const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {generateImage,checkImageConfiguration,imageArgs,validateImageRequest,quoteHookArgument}=require('../out/legacy/image-service');
const {guardDecision}=require('../out/image-guard');const {png}=require('./fixtures/png-fixture.cjs');
const fixture=path.join(__dirname,'fixtures/fake-agy-image.cjs');
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-service-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));const home=await fs.realpath(dir);const output=path.join(home,'output');await fs.mkdir(output);return {home,output,request:{executable:process.execPath,prompt:'A blue cloud',references:[],aspectRatio:'1:1',outputDirectory:output}};}
test('CLI contract uses real flags, explicit timeout and no permissive or chat model override',()=>{
 const args=imageArgs('approved-agent');assert.deepEqual(args.slice(0,4),['--input-format','stream-json','--output-format','stream-json']);assert.ok(args.includes('--print-timeout'));assert.ok(args.includes('--disable-slash-commands'));assert.ok(!args.includes('--dangerously-skip-permissions'));assert.ok(!args.includes('--model'));assert.throws(()=>validateImageRequest({prompt:'',references:[],aspectRatio:'1:1'}));
 assert.equal(quoteHookArgument('/tmp/a b','linux'),'\'/tmp/a b\'');assert.equal(quoteHookArgument('/tmp/a b','win32'),'"/tmp/a b"');assert.throws(()=>quoteHookArgument('C:\\bad%thing.exe','win32'),/UNSUPPORTED/);
});
test('pre-tool guard permits selected references only and denies unrelated tools and extra fields',()=>{
 const policy={references:['/tmp/selected.png'],imageName:'generated_image',aspectRatio:'1:1',workspace:'/tmp/fixture'};
 const call={toolCall:{name:'generate_image',args:{Prompt:'an image',ImageName:'generated_image',ImagePaths:['/tmp/selected.png'],AspectRatio:'1:1'}}};
 assert.equal(guardDecision(call,policy),true);assert.equal(guardDecision({...call,toolCall:{...call.toolCall,name:'run_command'}},policy),false);
 for(const changes of [{ImagePaths:['/etc/private.png']},{ImagePaths:[]},{AspectRatio:'16:9'},{ImageName:'../../oops'},{Extra:'field'}])assert.equal(guardDecision({toolCall:{...call.toolCall,args:{...call.toolCall.args,...changes}}},policy),false);
});
test('guard executable admits only one generation per task',async t=>{
 const f=await setup(t),policyFile=path.join(f.home,'policy.json');const policy={references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:f.home};await fs.writeFile(policyFile,JSON.stringify(policy));
 const opts={encoding:'utf8',input:JSON.stringify({toolCall:{name:'generate_image',args:{Prompt:'fixture',ImageName:'generated_image',AspectRatio:'1:1'}}})};
 const exec=()=>JSON.parse(spawnSync(process.execPath,[path.join(__dirname,'../out/image-guard.js'),policyFile],opts).stdout).decision;
 assert.equal(exec(),'allow');assert.equal(exec(),'deny');
});
test('simulated official stream invokes guard, validates artifact and saves non-overwriting PNG',async t=>{
 const f=await setup(t),progress=[];const ref=path.join(f.home,'reference.png');await fs.writeFile(ref,png());f.request.references=[ref];
 const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success'],onProgress:p=>progress.push(p.phase)});
 assert.deepEqual(progress,['checking','checking','starting','generating','validating']);assert.equal(result.identity,null);assert.equal(result.quota,null);assert.equal(result.images[0].width,2);assert.equal(path.dirname(result.images[0].file),f.output);assert.ok((await fs.readFile(result.images[0].file)).equals(png()));
 const again=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success']});assert.notEqual(again.images[0].file,result.images[0].file);
});
for(const [mode,code] of [['auth','AUTH_REQUIRED'],['bad-json','MALFORMED_OUTPUT'],['missing-image-tool','TOOL_SCOPE_UNVERIFIED'],['missing-flags','CAPABILITY_MISSING'],['help-failed','PROBE_FAILED'],['missing-schema','TOOL_SCOPE_UNVERIFIED'],['wrong-schema','TOOL_SCOPE_UNVERIFIED'],['missing-permission','TOOL_SCOPE_UNVERIFIED'],['turbo','TOOL_SCOPE_UNVERIFIED'],['missing','MISSING_RESULT'],['quota','QUOTA_EXHAUSTED'],['permission','PERMISSION_DENIED'],['no-guard','GUARD_NOT_CONFIRMED'],['outside','ARTIFACT_PATH_REJECTED'],['bad-image','INVALID_PNG'],['wrong-tool','UNEXPECTED_TOOL'],['no-path','MISSING_IMAGE_PATH'],['duplicate-result','MALFORMED_OUTPUT']])test(`image task fails closed on ${mode}`,async t=>{
 const f=await setup(t);await assert.rejects(generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,mode]}),new RegExp(code));assert.deepEqual(await fs.readdir(f.output),[]);
});
test('cancel and explicit timeout terminate pending CLI process without saving outputs',async t=>{
 const f=await setup(t);const controller=new AbortController();const p=generateImage(f.request,controller.signal,{home:f.home,executableArgs:[fixture,'wait'],onProgress:v=>{if(v.phase==='generating')controller.abort();}});await assert.rejects(p,/CANCELLED/);
 await assert.rejects(generateImage(f.request,new AbortController().signal,{home:f.home,timeoutMs:100,executableArgs:[fixture,'stall']}),/TIMEOUT/);assert.deepEqual(await fs.readdir(f.output),[]);
});
test('global executable customizations are refused without mutating settings or reading credentials',async t=>{
 const f=await setup(t);const cfg=path.join(f.home,'.gemini','config');await fs.mkdir(cfg,{recursive:true});const file=path.join(cfg,'hooks.json');await fs.writeFile(file,JSON.stringify({external:{PreInvocation:[{command:'synthetic'}]}}));
 await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/EXTERNAL_CUSTOMIZATIONS/);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).external.PreInvocation[0].command,'synthetic');await fs.unlink(file);
 await fs.writeFile(path.join(cfg,'config.json'),JSON.stringify({userSettings:{hooks:{}}}));await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
 await fs.writeFile(path.join(cfg,'config.json'),JSON.stringify({plugins:{test:{command:'node'}}}));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/EXTERNAL_CUSTOMIZATIONS/);
});
test('image environment strips provider, proxy and auth overrides while retaining OS keyring routing',()=>{
 const {imageEnvironment}=require('../out/legacy/image-service');const keys=['GEMINI_API_KEY','GOOGLE_API_KEY','AGY_LLM_GATEWAY_URL','ANTIGRAVITY_APP_DATA_DIR','HTTPS_PROXY','CODEX_HOME','DBUS_SESSION_BUS_ADDRESS'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{for(const k of keys)process.env[k]='synthetic';const env=imageEnvironment('/home/fixture');for(const k of keys.filter(k=>k!=='DBUS_SESSION_BUS_ADDRESS'))assert.equal(env[k],undefined);assert.equal(env.DBUS_SESSION_BUS_ADDRESS,'synthetic');assert.equal(env.HOME,'/home/fixture');}finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}}
});
test('unrelated shared metadata is inert while nonempty global instructions fail closed',async t=>{
 const f=await setup(t);const cfg=path.join(f.home,'.gemini','config');await fs.mkdir(cfg,{recursive:true});await fs.writeFile(path.join(cfg,'future-discovery.txt'),'synthetic');await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));await fs.unlink(path.join(cfg,'future-discovery.txt'));await fs.mkdir(path.join(cfg,'skills'));await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));await fs.writeFile(path.join(cfg,'skills','injected.md'),'synthetic');await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/EXTERNAL_CUSTOMIZATIONS/);
});

test('bounded batch passes preferences, uses independent sequential calls and reports exact counts',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service');const calls=[],progress=[];let active=0;
 const request={executable:'agy',prompt:'cloud',references:[],aspectRatio:'3:2',outputDirectory:'/tmp/fixture',count:4,size:'2K',quality:'detail'};
 const result=await generateImageBatch(request,new AbortController().signal,{onProgress:p=>progress.push(p.message)},async(req,_signal,deps)=>{
  assert.equal(++active,1);calls.push(req);deps.onProgress({phase:'generating',message:'working'});await new Promise(r=>setImmediate(r));active--;
  return {images:[{file:'/tmp/work-'+calls.length+'.png',width:2,height:2,bytes:4,sha256:'fixture'}],identity:null,quota:null,conversationId:'id-'+calls.length,completedAt:new Date().toISOString(),warning:'fixture'};
 });
 assert.equal(calls.length,4);assert.ok(calls.every(r=>r.count===1&&r.size==='2K'&&r.quality==='detail'&&r.aspectRatio==='3:2'));assert.equal(result.images.length,4);assert.deepEqual(result.batch,{requested:4,completed:4,outcome:'complete'});assert.match(progress[3],/第 4\/4 张/);
});
test('batch stops at first failure without retry and preserves completed outputs',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service');let calls=0;const request={prompt:'cloud',references:[],aspectRatio:'1:1',count:4};
 const result=await generateImageBatch(request,new AbortController().signal,{},async()=>{if(++calls===2)throw Error('IMAGE_QUOTA_EXHAUSTED');return {images:[{file:'/tmp/first.png'}],warning:'fixture'};});
 assert.equal(calls,2);assert.equal(result.images[0].file,'/tmp/first.png');assert.deepEqual(result.batch,{requested:4,completed:1,outcome:'partial',error:'IMAGE_QUOTA_EXHAUSTED'});
});
test('batch cancellation retains prior outputs and never launches next request',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service');let calls=0;const controller=new AbortController();
 const result=await generateImageBatch({prompt:'cloud',references:[],aspectRatio:'1:1',count:3},controller.signal,{},async()=>{calls++;controller.abort();return {images:[{file:'/tmp/first.png'}],warning:'fixture'};});
 assert.equal(calls,1);assert.equal(result.batch.outcome,'cancelled');assert.equal(result.images.length,1);assert.equal(result.batch.requested,3);
});
test('batch bounds and invalid preferences fail before any generation',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service');for(const fields of [{count:0},{count:5},{count:1.5},{size:'8K'},{quality:'ultra'}])await assert.rejects(generateImageBatch({prompt:'cloud',references:[],aspectRatio:'1:1',...fields},new AbortController().signal,{},async()=>{throw Error('must not run')}),/REQUEST_INVALID/);
 const aborted=new AbortController();aborted.abort();await assert.rejects(generateImageBatch({prompt:'cloud',references:[],aspectRatio:'1:1'},aborted.signal,{},async()=>{throw Error('must not run')}),/CANCELLED/);
});
test('actual synthetic CLI batch saves distinct files and enforces the native ratio guard per image',async t=>{
 const {generateImageBatch}=require('../out/legacy/image-service');const f=await setup(t);const result=await generateImageBatch({...f.request,count:2,size:'4K',quality:'detail'},new AbortController().signal,{home:f.home,executableArgs:[fixture,'preferences']});
 assert.equal(result.images.length,2);assert.notEqual(result.images[0].file,result.images[1].file);assert.equal(result.batch.outcome,'complete');for(const image of result.images)assert.ok((await fs.readFile(image.file)).equals(png()));
 const policy={references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:f.home};assert.equal(guardDecision({toolCall:{name:'generate_image',args:{Prompt:'fixture',ImageName:'generated_image'}}},policy),true);
 assert.equal(guardDecision({toolCall:{name:'generate_image',args:{Prompt:'fixture',ImageName:'generated_image'}}},{...policy,aspectRatio:'16:9'}),false);
});

test('changed reference between batch images stops without submitting replacement bytes',async t=>{
 const {generateImageBatch}=require('../out/legacy/image-service');const f=await setup(t),ref=path.join(f.home,'chosen.png');await fs.writeFile(ref,png());let calls=0;
 const result=await generateImageBatch({...f.request,references:[ref],count:3},new AbortController().signal,{},async()=>{calls++;await fs.writeFile(ref,Buffer.from('changed'));return {images:[{file:'/tmp/first.png'}],warning:'fixture'};});
 assert.equal(calls,1);assert.equal(result.batch.outcome,'partial');assert.equal(result.batch.completed,1);assert.equal(result.images[0].file,'/tmp/first.png');
});

test('batch pins actual copied reference bytes when a valid PNG changes after the precheck',async t=>{
 const {generateImageBatch}=require('../out/legacy/image-service');
 for(const replaceOn of [1,2]){
  const f=await setup(t),ref=path.join(f.home,'chosen.png');await fs.writeFile(ref,png());let checking=0;
  const pending=generateImageBatch({...f.request,references:[ref],count:3},new AbortController().signal,{home:f.home,executableArgs:[fixture,'success'],onProgress:value=>{
   if(value.phase==='checking'&&value.message.endsWith('正在检查官方 CLI、参考图与输出目录')&&++checking===replaceOn)require('node:fs').writeFileSync(ref,png({value:50}));
  }});
  if(replaceOn===1){await assert.rejects(pending,/IMAGE_FILE_CHANGED/);assert.deepEqual(await fs.readdir(f.output),[]);}
  else {const result=await pending;assert.deepEqual(result.batch,{requested:3,completed:1,outcome:'partial',error:'IMAGE_FILE_CHANGED'});assert.equal(result.images.length,1);assert.ok((await fs.readFile(result.images[0].file)).equals(png()));assert.equal((await fs.readdir(f.output)).length,1);}
  assert.equal(checking,replaceOn);
 }
});

test('temporary cleanup failure retains the validated image and stops the remaining batch',async t=>{
 const {generateImageBatch}=require('../out/legacy/image-service');const f=await setup(t),originalRm=fs.rm,workspaces=new Set();let started=0;
 fs.rm=async function(file,...options){
  if(path.basename(String(file)).startsWith('ag-image-')){workspaces.add(String(file));throw Object.assign(new Error('synthetic private cleanup detail'),{code:'EPERM'});}
  return originalRm.call(this,file,...options);
 };
 try{
  const result=await generateImageBatch({...f.request,count:4},new AbortController().signal,{home:f.home,executableArgs:[fixture,'success'],onProgress:value=>{if(value.phase==='starting')started++;}});
  assert.equal(started,1);assert.equal(result.cleanupFailed,true);assert.deepEqual(result.batch,{requested:4,completed:1,outcome:'partial',error:'IMAGE_TEMP_CLEANUP_FAILED'});
  assert.equal(result.images.length,1);assert.ok((await fs.readFile(result.images[0].file)).equals(png()));assert.equal((await fs.readdir(f.output)).length,1);
  assert.equal(workspaces.size,1);assert.match(result.warning,/临时目录清理失败/);assert.ok(result.warning.includes([...workspaces][0]));assert.doesNotMatch(result.warning,/synthetic private cleanup detail|EPERM/);
 }finally{
  fs.rm=originalRm;
  for(const workspace of workspaces)await originalRm(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});

test('normal official auth preference and existing project metadata do not block image generation',async t=>{
 const f=await setup(t),cfg=path.join(f.home,'.gemini','config'),cli=path.join(f.home,'.gemini','antigravity-cli');
 await fs.mkdir(path.join(cfg,'projects'),{recursive:true});await fs.mkdir(cli,{recursive:true});
 // Unrelated project contents are deliberately not read or inherited by --new-project.
 await fs.writeFile(path.join(cfg,'projects','unrelated.json'),JSON.stringify({hooks:{command:'must not execute'},private:'must not read'}));
 const setting=path.join(cli,'settings.json');
 for(const previousAuthMethod of ['consumer','gcp','keyring','']){
  await fs.writeFile(setting,JSON.stringify({previousAuthMethod,theme:'dark',vimMode:false}));
  const before=await fs.readFile(setting);await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));assert.deepEqual(await fs.readFile(setting),before);
 }
 await fs.writeFile(setting,JSON.stringify({previousAuthMethod:'consumer'}));
 const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success']});assert.equal(result.images.length,1);
});
test('official auth exception is source and field specific and never enables arbitrary auth or providers',async t=>{
 const f=await setup(t),cli=path.join(f.home,'.gemini','antigravity-cli');await fs.mkdir(cli,{recursive:true});const setting=path.join(cli,'settings.json');
 for(const previousAuthMethod of ['gateway','gemini_api_key','adc','wif','oauth',true,{},['consumer']]){
  await fs.writeFile(setting,JSON.stringify({previousAuthMethod}));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),e=>e.message==='IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED'&&e.diagnostics[0].key==='previousAuthMethod');
 }
 for(const value of [{customModelsConfig:{models:{external:{apiKey:'SECRET'}}}},{modelProvider:'gateway'},{sandboxProxy:{http:{address:'PRIVATE'}}}]){
  await fs.writeFile(setting,JSON.stringify(value));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);
 }
 // These names belong to unknown preserved fields or the separate Gemini CLI.
 for(const value of [{userSettings:{previousAuthMethod:'consumer'}},{auth:{method:'gateway'}},{authMethod:'consumer'},{previousAuthMethod:'consumer',more:[{mcpServers:{command:'SECRET'}}]}]){
  await fs.writeFile(setting,JSON.stringify(value));await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
 }
 await fs.unlink(setting);await fs.writeFile(path.join(f.home,'.gemini','settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
});
test('empty official hook and MCP files are inert but populated definitions remain blocked',async t=>{
 const f=await setup(t),cfg=path.join(f.home,'.gemini','config');await fs.mkdir(cfg,{recursive:true});const hook=path.join(cfg,'hooks.json'),mcp=path.join(cfg,'mcp_config.json');
 await fs.writeFile(hook,'{}');await fs.writeFile(mcp,'{"mcpServers":{}}');await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
 for(const value of [{external:{enabled:false,PreToolUse:[{command:'SECRET'}]}},{external:{PreInvocation:[{command:'SECRET'}]}}]){await fs.writeFile(hook,JSON.stringify(value));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);}
 await fs.writeFile(hook,'{}');await fs.writeFile(mcp,'{"mcpServers":{"external":{"command":"SECRET"}}}');await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);
});
test('configuration errors retain actionable paths and reasons without values, arbitrary keys or token reads',async t=>{
 const {imageConfigurationDiagnostics}=require('../out/legacy/image-configuration');const f=await setup(t),cfg=path.join(f.home,'.gemini','config');await fs.mkdir(cfg,{recursive:true});
 await fs.writeFile(path.join(cfg,'config.json'),JSON.stringify({userSettings:{customModels:{apiKey:'SECRET_TOKEN',url:'https://private.invalid'}}}));
 await fs.writeFile(path.join(f.home,'.gemini','jetski-standalone-oauth-token'),'not JSON and must not be read');
 await assert.rejects(generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success']}),e=>{
  const diagnostic=imageConfigurationDiagnostics(e);assert.deepEqual(diagnostic,[{source:'~/.gemini/config/config.json',key:'userSettings.customModels',reason:'存在全局工具执行或服务覆盖配置'}]);assert.doesNotMatch(JSON.stringify(e),/SECRET_TOKEN|private.invalid/);return true;
 });
 assert.deepEqual(imageConfigurationDiagnostics({diagnostics:[{source:'/private/token',key:'secret',reason:'SECRET'}]}),[]);
 assert.deepEqual(await fs.readdir(f.output),[]);
});
test('safe configuration reader rejects malformed, linked or non-file settings without starting CLI',async t=>{
 const f=await setup(t),cli=path.join(f.home,'.gemini','antigravity-cli');await fs.mkdir(cli,{recursive:true});const file=path.join(cli,'settings.json');
 for(const value of ['{','[]','null']){await fs.writeFile(file,value);await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),e=>e.message==='IMAGE_UNSAFE_CLI_SETTINGS'&&e.diagnostics[0].source==='~/.gemini/antigravity-cli/settings.json');}
 await fs.unlink(file);await fs.mkdir(file);await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/UNSAFE_CLI_SETTINGS/);await fs.rmdir(file);
 const target=path.join(f.home,'outside.json');await fs.writeFile(target,'{}');await fs.link(target,file);await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/UNSAFE_CLI_SETTINGS/);
});
test('global standalone rules and legacy skills are checked rather than silently inherited',async t=>{
 const f=await setup(t),gemini=path.join(f.home,'.gemini');await fs.mkdir(gemini,{recursive:true});const rule=path.join(gemini,'AGENTS.md');await fs.writeFile(rule,'untrusted rule');await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);await fs.unlink(rule);
 const skill=path.join(gemini,'antigravity-cli','skills');await fs.mkdir(skill,{recursive:true});await fs.writeFile(path.join(skill,'external.md'),'untrusted skill');await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);
});
test('batch preserves structured configuration diagnostics on initial and partial failures',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service'),{ImageConfigurationError}=require('../out/legacy/image-configuration');const diagnostics=[{source:'~/.gemini/config/hooks.json',key:'hooks',reason:'存在全局工具执行或服务覆盖配置'}];const error=new ImageConfigurationError('IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED',diagnostics);const req={prompt:'cloud',references:[],aspectRatio:'1:1',count:2};
 await assert.rejects(generateImageBatch(req,new AbortController().signal,{},async()=>{throw error}),e=>e===error);
 let count=0;const result=await generateImageBatch(req,new AbortController().signal,{},async()=>{if(count++)throw error;return {images:[{file:'/tmp/first.png'}],warning:'fixture'};});assert.deepEqual(result.batch.diagnostics,diagnostics);
});

test('official profile metadata created during generation does not turn a validated PNG into failure',async t=>{
 const f=await setup(t),sync=require('node:fs');
 const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success'],onProgress:p=>{
  if(p.phase!=='generating')return;
  sync.mkdirSync(path.join(f.home,'.gemini','config','projects'),{recursive:true});
  sync.writeFileSync(path.join(f.home,'.gemini','config','projects','new-project.json'),JSON.stringify({id:'synthetic-new-project'}));
  sync.mkdirSync(path.join(f.home,'.gemini','antigravity-cli'),{recursive:true});
  sync.writeFileSync(path.join(f.home,'.gemini','antigravity-cli','settings.json'),JSON.stringify({previousAuthMethod:'consumer'}));
 }});
 assert.equal(result.images.length,1);assert.deepEqual(await fs.readFile(result.images[0].file),png());
});
test('project metadata exemption never accepts a linked metadata directory',async t=>{
 const f=await setup(t),cfg=path.join(f.home,'.gemini','config'),target=path.join(f.home,'other-projects');await fs.mkdir(cfg,{recursive:true});await fs.mkdir(target);await fs.symlink(target,path.join(cfg,'projects'),'junction');
 await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),e=>e.message==='IMAGE_UNSAFE_CLI_SETTINGS'&&e.diagnostics.some(d=>d.source==='~/.gemini/config/projects'));
});

test('official first-run migration files and unrelated Gemini CLI auth no longer block images', async t => {
 const f=await setup(t),cfg=path.join(f.home,'.gemini/config'),cli=path.join(f.home,'.gemini/antigravity-cli');
 await fs.mkdir(cfg,{recursive:true});await fs.mkdir(cli,{recursive:true});
 await fs.writeFile(path.join(cfg,'.migrated'),'');await fs.writeFile(path.join(cfg,'mcp_config.json'),'');
 await fs.writeFile(path.join(cfg,'window-state.json'),'{"customWindow":true}');
 await fs.writeFile(path.join(cfg,'config.json'),JSON.stringify({userSettings:{customWorkspace:'/private/ordinary/project',customTheme:{auth:'inert unknown metadata'}}}));
 await fs.writeFile(path.join(f.home,'.gemini/settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));
 // The separate Gemini CLI settings must not even be read by this adapter.
 await fs.writeFile(path.join(f.home,'.gemini/settings.json'),'not valid JSON');
 await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
 const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'success']});assert.equal(result.images.length,1);
 assert.equal(await fs.readFile(path.join(cfg,'mcp_config.json'),'utf8'),'');
});

test('active CLI statusLine and title require exact per-run approval with redacted previews', async t => {
 const {reviewImageConfiguration}=require('../out/legacy/image-configuration');const f=await setup(t),cli=path.join(f.home,'.gemini/antigravity-cli');await fs.mkdir(cli,{recursive:true});const settings=path.join(cli,'settings.json');
 const raw=JSON.stringify({statusLine:{type:'command',command:'node /private/secret-script.js --token PRIVATE_SECRET',enabled:true},title:{command:'/private/account@example.test --key PRIVATE',enabled:true}});await fs.writeFile(settings,raw);
 const review=await reviewImageConfiguration(f.home);assert.equal(review.scripts.length,2);assert.equal(review.scripts[0].preview,'node …（参数已隐藏）');assert.equal(review.scripts[1].preview,'自定义命令（内容已隐藏）');assert.doesNotMatch(JSON.stringify(review),/PRIVATE|account@example|secret-script|\/private/);
 const approvals=review.scripts.map(({source,key,sha256})=>({source,key,sha256}));
 await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/SCRIPT_CONSENT_REQUIRED/);
 await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'),approvals);
 const result=await generateImage({...f.request,authorizedScripts:approvals},new AbortController().signal,{home:f.home,executableArgs:[fixture,'success']});assert.equal(result.images.length,1);assert.equal(await fs.readFile(settings,'utf8'),raw);
 await fs.writeFile(settings,raw+' ');await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'),approvals),/CONFIGURATION_CHANGED/);
});

test('disabled and command-free UI settings need no permission; malformed active commands stay blocked',async t=>{
 const {reviewImageConfiguration}=require('../out/legacy/image-configuration');const f=await setup(t),cli=path.join(f.home,'.gemini/antigravity-cli');await fs.mkdir(cli,{recursive:true});const settings=path.join(cli,'settings.json');
 for(const value of [{statusLine:{command:'node PRIVATE',enabled:false}},{statusLine:{command:''},title:{command:null,enabled:null}},{statusLine:{stack_with_default:true},windowTitle:{command:'unknown, ignored by 1.2.14'}}]){await fs.writeFile(settings,JSON.stringify(value));assert.deepEqual((await reviewImageConfiguration(f.home)).scripts,[]);await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));}
 for(const value of [{statusLine:{command:['node']}},{title:{command:'node',enabled:'false'}},{statusLine:'command'}]){await fs.writeFile(settings,JSON.stringify(value));await assert.rejects(reviewImageConfiguration(f.home),/UNSAFE_CLI_SETTINGS/);}
});

test('script approval cannot authorize hooks, MCP, or service overrides',async t=>{
 const {reviewImageConfiguration}=require('../out/legacy/image-configuration');const f=await setup(t),cli=path.join(f.home,'.gemini/antigravity-cli'),cfg=path.join(f.home,'.gemini/config');await fs.mkdir(cli,{recursive:true});await fs.mkdir(cfg,{recursive:true});await fs.writeFile(path.join(cli,'settings.json'),'{"statusLine":{"command":"node harmless"}}');const approved=(await reviewImageConfiguration(f.home)).scripts.map(({source,key,sha256})=>({source,key,sha256}));
 for(const [name,value]of [['hooks.json',{external:{PreToolUse:[{command:'private'}]}}],['mcp_config.json',{mcpServers:{untrusted:{command:'private'}}}],['config.json',{plugins:{untrusted:{enabled:true}}}]]){const target=path.join(cfg,name);await fs.writeFile(target,JSON.stringify(value));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'),approved),/CUSTOMIZATIONS/);await fs.unlink(target);}
});

test('configuration changes at the last prelaunch boundary prevent CLI launch and prompt submission',async t=>{
 const {reviewImageConfiguration}=require('../out/legacy/image-configuration');const f=await setup(t),cli=path.join(f.home,'.gemini/antigravity-cli');await fs.mkdir(cli,{recursive:true});const file=path.join(cli,'settings.json');await fs.writeFile(file,'{"statusLine":{"command":"node approved"}}');const approved=(await reviewImageConfiguration(f.home)).scripts.map(({source,key,sha256})=>({source,key,sha256}));let started=0;
 await assert.rejects(generateImage({...f.request,authorizedScripts:approved},new AbortController().signal,{home:f.home,executableArgs:[fixture,'success'],onProgress:p=>{if(p.phase==='starting'){started++;require('node:fs').writeFileSync(file,'{"statusLine":{"command":"node changed"}}');}}}),/CONFIGURATION_CHANGED/);assert.equal(started,1);assert.deepEqual(await fs.readdir(f.output),[]);assert.equal(await fs.stat(path.join(cli,'brain')).then(()=>true,()=>false),false);
});

test('invalid, duplicate or broader authorization records are rejected',()=>{
 for(const authorizedScripts of [true,[{source:'~/.gemini/config/hooks.json',key:'hooks',sha256:'a'.repeat(64)}],[{source:'~/.gemini/antigravity-cli/settings.json',key:'statusLine',sha256:'a'.repeat(64),preview:'fake'}],Array(2).fill({source:'~/.gemini/antigravity-cli/settings.json',key:'title',sha256:'a'.repeat(64)})])assert.throws(()=>validateImageRequest({prompt:'test',references:[],aspectRatio:'1:1',authorizedScripts}),/REQUEST_INVALID/);
});

test('native nested case aliases cannot bypass script consent or disabled-state detection',async t=>{
 const {reviewImageConfiguration}=require('../out/legacy/image-configuration');const f=await setup(t),cli=path.join(f.home,'.gemini/antigravity-cli');await fs.mkdir(cli,{recursive:true});const file=path.join(cli,'settings.json');
 for(const commandKey of ['command','Command','COMMAND','cOmMaNd']){await fs.writeFile(file,JSON.stringify({statusLine:{[commandKey]:'node PRIVATE',Enabled:true}}));assert.equal((await reviewImageConfiguration(f.home)).scripts.length,1);await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/SCRIPT_CONSENT_REQUIRED/);}
 for(const enabledKey of ['enabled','Enabled','ENABLED']){await fs.writeFile(file,JSON.stringify({statusLine:{Command:'node PRIVATE',[enabledKey]:false}}));assert.equal((await reviewImageConfiguration(f.home)).scripts.length,0);}
 for(const value of [{statusLine:{command:'',Command:'node active'}},{statusLine:{command:'node active',enabled:false,Enabled:true}},{title:{command:'node active',COMMAND:''}}]){await fs.writeFile(file,JSON.stringify(value));await assert.rejects(reviewImageConfiguration(f.home),/UNSAFE_CLI_SETTINGS/);}
 // Real 1.2.14 startup probes confirm roots are exact and nested separators are not aliases.
 for(const value of [{StatusLine:{command:'node ignored'}},{status_line:{command:'node ignored'}},{statusLine:{c_ommand:'node ignored'}},{statusLine:{'c-ommand':'node ignored'}}]){await fs.writeFile(file,JSON.stringify(value));assert.equal((await reviewImageConfiguration(f.home)).scripts.length,0);}
});

test('actual Antigravity gateway settings are distinguished from unrelated Gemini CLI settings',async t=>{
 const f=await setup(t),dir=path.join(f.home,'.antigravity');await fs.mkdir(dir);const file=path.join(dir,'settings.json');
 await fs.writeFile(file,'{"customTheme":"dark","security":{"auth":"unrelated metadata"}}');await checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic'));
 for(const value of [{gateway:{url:'https://PRIVATE',apiKey:'SECRET'}},{Gateway:{url:'https://PRIVATE'}},{models:{custom:'PRIVATE'}},{caCertPath:'/private/cert'}]){await fs.writeFile(file,JSON.stringify(value));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),error=>{assert.equal(error.message,'IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED');assert.equal(error.diagnostics[0].source,'~/.antigravity/settings.json');assert.doesNotMatch(JSON.stringify(error),/PRIVATE|SECRET|\/private/);return true;});}
});

for (const mode of ['unknown-version','stderr-help','help-cwd']) test(`runtime capabilities support ${mode} without version gating`,async t=>{
 const f=await setup(t);const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,mode]});assert.equal(result.images.length,1);
});
test('capability probe is cancellable, bounded and reports only safe actionable diagnostics',async t=>{
 const {checkImageCliCapabilities,imageCapabilityDiagnostics,missingImageCliFlags}=require('../out/legacy/image-capabilities');await setup(t);
 assert.ok(missingImageCliFlags('The option --new-project is not supported.').includes('--new-project'));
 await assert.rejects(checkImageCliCapabilities(process.execPath,process.env,new AbortController().signal,[fixture,'missing-flags']),e=>{assert.deepEqual(imageCapabilityDiagnostics(e),{executable:process.execPath,missingFlags:['--new-project']});return true;});
 await assert.rejects(checkImageCliCapabilities(process.execPath,process.env,new AbortController().signal,[fixture,'help-stall'],100),/PROBE_TIMEOUT/);
 const controller=new AbortController();const result=checkImageCliCapabilities(process.execPath,process.env,controller.signal,[fixture,'help-stall']);controller.abort();await assert.rejects(result,/CANCELLED/);
 assert.equal(imageCapabilityDiagnostics({capabilities:{executable:'secret\nvalue',missingFlags:[]}}),undefined);
 assert.equal(imageCapabilityDiagnostics({capabilities:{executable:process.execPath,missingFlags:['secret']}}),undefined);
});

test('documented inline CLI hooks and executable roots remain blocked on every runtime',async t=>{
 const f=await setup(t),cli=path.join(f.home,'.gemini','antigravity-cli');await fs.mkdir(cli,{recursive:true});const file=path.join(cli,'settings.json');
 for(const value of [{hooks:{custom:{PreToolUse:[{command:'synthetic'}]}}},{mcpServers:{custom:{command:'synthetic'}}},{skills:['synthetic']},{plugins:['synthetic']}]){await fs.writeFile(file,JSON.stringify(value));await assert.rejects(checkImageConfiguration(f.home,path.join(os.tmpdir(),'ag-image-synthetic')),/CUSTOMIZATIONS/);}
});

const {guardRejection,imageGuardDiagnostics,readImageGuardDiagnostic}=require('../out/image-guard');
test('guard diagnostics identify exact rejected fields without retaining any input values',()=>{
 const policy={references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:'/tmp/synthetic'};
 const args={Prompt:'safe',ImageName:'generated_image',AspectRatio:'1:1',ImagePaths:[]};const event=a=>({toolCall:{name:'generate_image',args:a}});
 for(const [value,reason] of [[null,'EVENT_SHAPE'],[[],'EVENT_SHAPE'],[{toolCall:[]},'EVENT_SHAPE'],[{toolCall:{name:'PRIVATE_TOOL',args}},'TOOL_NAME'],[event('SECRET'),'ARGUMENT_SHAPE'],[event([]),'ARGUMENT_SHAPE'],[event({...args,SECRET_FIELD:'PRIVATE'}),'UNKNOWN_ARGUMENT'],[event({...args,prompt:'PRIVATE'}),'ARGUMENT_ALIAS'],[event({...args,Prompt:''}),'PROMPT'],[event({...args,ImageName:'PRIVATE_NAME.png'}),'IMAGE_NAME'],[event({...args,AspectRatio:'16:9'}),'ASPECT_RATIO'],[event({...args,ImagePaths:'PRIVATE'}),'REFERENCE_SHAPE'],[event({...args,ImagePaths:['/private/SECRET.png']}),'REFERENCE_COUNT']])assert.equal(guardRejection(value,policy),reason);
 const refs={...policy,references:['/tmp/synthetic/reference-1.png']};assert.equal(guardRejection(event({...args,ImagePaths:['/private/SECRET.png']}),refs),'REFERENCE_PATH');
 assert.deepEqual(imageGuardDiagnostics({guard:{version:1,reason:'IMAGE_NAME',generationAllowed:false,PRIVATE:'SECRET'}}),{version:1,reason:'IMAGE_NAME',generationAllowed:false});
 for(const guard of [{version:1,reason:'SECRET',generationAllowed:false},{version:1,reason:'PROMPT',generationAllowed:'SECRET'},{version:2,reason:'PROMPT',generationAllowed:false},'SECRET'])assert.equal(imageGuardDiagnostics({guard}),undefined);
});
test('optional no-reference forms and default square ratios stay bounded to their exact approved scope',()=>{
 const policy={references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:'/tmp/synthetic'};
 for(const refs of [undefined,null,[]])for(const ratio of [undefined,null,'','1:1'])assert.equal(guardDecision({toolCall:{name:'generate_image',args:{Prompt:'safe',ImageName:'generated_image',ImagePaths:refs,AspectRatio:ratio}}},policy),true);
 for(const ratio of ['1:1 ', 'square','auto','16/9',1,[],{}])assert.equal(guardRejection({toolCall:{name:'generate_image',args:{Prompt:'safe',ImageName:'generated_image',AspectRatio:ratio}}},policy),'ASPECT_RATIO');
 for(const aspectRatio of ['16:9','9:16','4:3','3:4','3:2','2:3'])for(const optional of [undefined,null,''])assert.equal(guardDecision({toolCall:{name:'generate_image',args:{Prompt:'safe',ImageName:'generated_image',AspectRatio:optional}}},{...policy,aspectRatio}),false);
});
test('a rejected attempt stays stopped and the first safe diagnostic survives model retries',async t=>{
 const f=await setup(t),file=path.join(f.home,'policy.json');await fs.writeFile(file,JSON.stringify({references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:f.home}));
 const call={toolCall:{name:'generate_image',args:{Prompt:'PRIVATE_PROMPT',ImageName:'PRIVATE_NAME.png',AspectRatio:'1:1'}}};
 const invoke=()=>spawnSync(process.execPath,[path.join(__dirname,'../out/image-guard.js'),file],{input:JSON.stringify(call),encoding:'utf8'});
 assert.equal(JSON.parse(invoke().stdout).decision,'deny');call.toolCall.args.ImageName='generated_image';assert.equal(JSON.parse(invoke().stdout).decision,'deny');
 const diagnostic=readImageGuardDiagnostic(f.home);assert.deepEqual({...diagnostic,argumentShape:undefined},{version:1,reason:'IMAGE_NAME',generationAllowed:false,argumentShape:undefined});
 assert.doesNotMatch(await fs.readFile(path.join(f.home,'.generation-scope-denied'),'utf8'),/PRIVATE/);assert.equal(await fs.stat(path.join(f.home,'.generation-started')).then(()=>true,()=>false),false);
});
test('diagnostic reader rejects unsafe and overlong marker files',async t=>{
 const f=await setup(t),file=path.join(f.home,'.generation-scope-denied');
 await fs.writeFile(file,'SECRET');assert.equal(readImageGuardDiagnostic(f.home),undefined);
 await fs.writeFile(file,' '.repeat(1025));assert.equal(readImageGuardDiagnostic(f.home),undefined);await fs.unlink(file);
 const target=path.join(f.home,'private');await fs.writeFile(target,JSON.stringify({version:1,reason:'PROMPT',generationAllowed:false}));await fs.link(target,file);assert.equal(readImageGuardDiagnostic(f.home),undefined);
});
for(const [mode,reason,generationAllowed] of [['guard-ratio','ASPECT_RATIO',false],['guard-name','IMAGE_NAME',false],['guard-refs','REFERENCE_COUNT',false],['guard-alias','ARGUMENT_ALIAS',false],['guard-unknown','UNKNOWN_ARGUMENT',false],['guard-shape','ARGUMENT_SHAPE',false],['guard-repeat','CALL_LIMIT',true]])test(`actual guard child and full service retain non-secret diagnosis for ${mode}`,async t=>{
 const f=await setup(t);await assert.rejects(generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,mode]}),error=>{assert.equal(error.message,'IMAGE_REQUEST_SCOPE_DENIED');const diagnostic=imageGuardDiagnostics(error);assert.deepEqual({...diagnostic,argumentShape:undefined},{version:1,reason,generationAllowed,argumentShape:undefined});assert.doesNotMatch(JSON.stringify(error),/PRIVATE|SECRET/);return true;});assert.deepEqual(await fs.readdir(f.output),[]);
});
test('batch preserves the same guard diagnosis for first and partial failures',async()=>{
 const {generateImageBatch}=require('../out/legacy/image-service');const request={executable:'agy',prompt:'safe',references:[],aspectRatio:'1:1',outputDirectory:'/tmp/synthetic',count:3};const guard={version:1,reason:'IMAGE_NAME',generationAllowed:false};
 const failure=()=>{throw Object.assign(new Error('IMAGE_REQUEST_SCOPE_DENIED'),{guard});};await assert.rejects(generateImageBatch(request,new AbortController().signal,{},failure),e=>{assert.deepEqual(imageGuardDiagnostics(e),guard);return true;});
 let count=0;const result=await generateImageBatch(request,new AbortController().signal,{},async()=>{if(count++)return failure();return{images:[{file:'/tmp/synthetic.png'}],warning:'synthetic'};});assert.equal(count,2);assert.equal(result.images.length,1);assert.deepEqual(result.batch.guard,guard);
});

test('safe image names permit harmless model naming without permitting paths or changing artifact scope',async t=>{
 const {safeImageName,readImageGuardClaim}=require('../out/image-guard');
 for(const name of ['generated_image','blue_cloud','a','photo_2'])assert.equal(safeImageName(name),true);
 for(const name of ['../escape','/tmp/output','file.png','a/b','a\\b','a__b','_prefix','suffix_','UpperCase','two words','a'.repeat(65),'a\nsecret'])assert.equal(safeImageName(name),false);
 const f=await setup(t);const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'safe-image-name']});assert.equal(result.images.length,1);
 await assert.rejects(generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'wrong-image-name']}),/ARTIFACT_PATH_REJECTED/);
 const file=path.join(f.home,'.generation-started');await fs.writeFile(file,JSON.stringify({version:1,imageName:'blue_cloud'}));assert.deepEqual(readImageGuardClaim(f.home),{version:1,imageName:'blue_cloud'});
 await fs.writeFile(file,JSON.stringify({version:1,imageName:'../escape'}));assert.equal(readImageGuardClaim(f.home),undefined);
});

test('concurrent hook processes still admit at most one safe name and cannot replace its claim',async t=>{
 const {spawn}=require('node:child_process'),{readImageGuardClaim}=require('../out/image-guard');const f=await setup(t),file=path.join(f.home,'policy.json');await fs.writeFile(file,JSON.stringify({references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:f.home}));
 const invoke=name=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'../out/image-guard.js'),file],{stdio:['pipe','pipe','pipe']});let stdout='';child.stdout.on('data',c=>stdout+=c);child.on('error',reject);child.on('close',code=>{if(code)reject(new Error('synthetic hook failed'));else resolve({name,...JSON.parse(stdout)});});child.stdin.end(JSON.stringify({toolCall:{name:'generate_image',args:{Prompt:'synthetic',ImageName:name,AspectRatio:'1:1'}}}));});
 const results=await Promise.all(['first_image','second_image','third_image','fourth_image'].map(invoke));assert.equal(results.filter(r=>r.decision==='allow').length,1);assert.equal(readImageGuardClaim(f.home).imageName,results.find(r=>r.decision==='allow').name);assert.equal(readImageGuardDiagnostic(f.home).generationAllowed,true);
});
test('claim reader rejects malformed, hardlinked and symlinked proof files',async t=>{
 const {readImageGuardClaim}=require('../out/image-guard');const f=await setup(t),file=path.join(f.home,'.generation-started'),target=path.join(f.home,'target');
 for(const raw of ['', 'PRIVATE_INVALID_JSON',JSON.stringify({version:2,imageName:'valid_name'}),' '.repeat(1025)]){await fs.writeFile(file,raw);assert.equal(readImageGuardClaim(f.home),undefined);}
 await fs.unlink(file);await fs.writeFile(target,JSON.stringify({version:1,imageName:'safe_name'}));await fs.link(target,file);assert.equal(readImageGuardClaim(f.home),undefined);await fs.unlink(file);
 if(process.platform!=='win32'){await fs.symlink(target,file);assert.equal(readImageGuardClaim(f.home),undefined);}
});

test('verified native image-name normalization accepts titles but never path syntax',()=>{
 const {canonicalImageName}=require('../out/image-guard');
 for(const [input,expected] of [['Blue Cloud','blue_cloud'],['image--2','image_2'],['  BLUE__CLOUD  ','blue_cloud'],['2026 picture','2026_picture'],['generated_image','generated_image']])assert.equal(canonicalImageName(input),expected);
 for(const input of ['../escape','/tmp/output','file.png','a/b','a\\b','---',' ', 'a'.repeat(65),'a\nsecret','a:b','image%20name'])assert.equal(canonicalImageName(input),undefined);
});

test('a later forbidden non-image tool is diagnosed honestly after the one allowed image call',async t=>{
 const f=await setup(t),file=path.join(f.home,'policy.json');await fs.writeFile(file,JSON.stringify({references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:f.home}));
 const call={toolCall:{name:'generate_image',args:{Prompt:'synthetic',ImageName:'generated_image',AspectRatio:'1:1'}}};const invoke=()=>JSON.parse(spawnSync(process.execPath,[path.join(__dirname,'../out/image-guard.js'),file],{input:JSON.stringify(call),encoding:'utf8'}).stdout);
 assert.equal(invoke().decision,'allow');call.toolCall.name='run_command';assert.equal(invoke().decision,'deny');assert.deepEqual({...readImageGuardDiagnostic(f.home),argumentShape:undefined},{version:1,reason:'TOOL_NAME',generationAllowed:true,argumentShape:undefined});
});

for(const mode of ['guard-defaults','guard-empty-ratio'])test(`native optional square defaults work through the real guard process: ${mode}`,async t=>{
 const f=await setup(t);const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,mode]});assert.equal(result.images.length,1);
});
test('diagnostic readback upgrades concurrent successful claims and never asserts zero calls from uncertain proof',async t=>{
 const f=await setup(t),marker=path.join(f.home,'.generation-scope-denied'),claim=path.join(f.home,'.generation-started');
 const first={version:1,reason:'REFERENCE_PATH',generationAllowed:false};await fs.writeFile(marker,JSON.stringify(first));assert.deepEqual(readImageGuardDiagnostic(f.home),first);
 await fs.writeFile(claim,JSON.stringify({version:1,imageName:'safe_name'}));assert.deepEqual(readImageGuardDiagnostic(f.home),{...first,generationAllowed:true});assert.equal(JSON.parse(await fs.readFile(marker,'utf8')).generationAllowed,false);
 await fs.writeFile(claim,'');assert.deepEqual(readImageGuardDiagnostic(f.home),{...first,generationAllowed:'unknown'});
});

test('verified generic execution metadata does not alter the image-specific authorization',()=>{
 const policy={references:[],imageName:'generated_image',aspectRatio:'1:1',workspace:'/tmp/synthetic'};
 const base={Prompt:'safe',ImageName:'generated_image',AspectRatio:'1:1',ImagePaths:[]};
 const call=changes=>({toolCall:{name:'generate_image',args:{...base,...changes}}});
 for(const waitForPreviousTools of [true,false])assert.equal(guardDecision(call({explanation:'PRIVATE',toolSummary:'PRIVATE',toolAction:'PRIVATE',waitForPreviousTools}),policy),true);
 for(const field of ['explanation','toolSummary','toolAction']){
  assert.equal(guardDecision(call({[field]:''}),policy),true);
  for(const value of [null,true,[],{},'x'.repeat(8193),'bad\u001b[31m'])assert.equal(guardRejection(call({[field]:value}),policy),'FRAMEWORK_METADATA');
 }
 assert.equal(guardRejection(call({Explanation:'PRIVATE'}),policy),'ARGUMENT_ALIAS');
 for(const value of ['true',0,{},null])assert.equal(guardRejection(call({waitForPreviousTools:value}),policy),'FRAMEWORK_METADATA');
 for(const [field,value] of [['Size','4K'],['Quality','high'],['Count',2],['TaskName','private'],['Description','private'],['thoughtSignature','private']])assert.equal(guardRejection(call({[field]:value}),policy),'UNKNOWN_ARGUMENT');
 for(const change of [{AspectRatio:'16:9'},{ImagePaths:['/private/extra.png']}])assert.equal(guardDecision(call({...change,explanation:'PRIVATE',waitForPreviousTools:false}),policy),false);
});
test('official generic metadata survives the real guard/service flow without entering local diagnostics',async t=>{
 const f=await setup(t);const result=await generateImage(f.request,new AbortController().signal,{home:f.home,executableArgs:[fixture,'framework-metadata']});assert.equal(result.images.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});

test('guard argument summary contains only fixed known key types and unknown count, never unknown names or values',()=>{
 const {imageArgumentShape,imageGuardDiagnostics,IMAGE_ARGUMENT_FIELDS}=require('../out/image-guard');const args={Prompt:'SECRET_PROMPT',ImageName:'SECRET_NAME',AspectRatio:null,ImagePaths:['/secret/path'],explanation:{SECRET:'value'},toolSummary:'SECRET_SUMMARY',toolAction:'SECRET_ACTION',waitForPreviousTools:false,Size:'SECRET_SIZE',Quality:3,Count:2,Width:1,Height:1,Resolution:[1],Format:{SECRET:'x'},SECRET_UNKNOWN_NAME:'SECRET_UNKNOWN_VALUE'};
 const shape=imageArgumentShape({toolCall:{args}});assert.equal(shape.unknownFieldCount,1);assert.equal(Object.keys(shape.knownTypes).length,IMAGE_ARGUMENT_FIELDS.length);assert.deepEqual(shape.knownTypes,{Prompt:'string',ImageName:'string',AspectRatio:'null',ImagePaths:'array',explanation:'object',toolSummary:'string',toolAction:'string',waitForPreviousTools:'boolean',Size:'string',Quality:'number',Count:'number',Width:'number',Height:'number',Resolution:'array',Format:'object'});assert.doesNotMatch(JSON.stringify(shape),/SECRET|\/secret/);
 const guard=imageGuardDiagnostics({guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false,argumentShape:{...shape,SECRET_FIELD:'SECRET',knownTypes:{...shape.knownTypes,SECRET_KEY:'string'}}}});assert.deepEqual(guard.argumentShape,shape);assert.ok(Buffer.byteLength(JSON.stringify(guard))<1024);assert.doesNotMatch(JSON.stringify(guard),/SECRET/);
 let calls=0;const hostile={};Object.defineProperty(hostile,'Prompt',{get(){calls++;throw Error('SECRET');}});assert.equal(imageArgumentShape({toolCall:{args:hostile}}).knownTypes.Prompt,'other');assert.equal(calls,0);assert.equal(imageArgumentShape(new Proxy({},{getOwnPropertyDescriptor(){throw Error('SECRET');}})),undefined);
});
