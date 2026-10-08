const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {png}=require('./png-fixture.cjs');
const args=process.argv.slice(2),mode=args[0],agent=args[args.indexOf('--agent')+1],cwd=process.cwd();
if(args.includes('--version')){process.stdout.write(mode==='unknown-version'?'9.9.9':'1.2.14');process.exit(0);}
if(args.includes('--help')) {
 if(mode==='help-cwd'&&!path.basename(process.cwd()).startsWith('ag-image-')){process.stderr.write('unexpected cwd');process.exit(1);}
 if(mode==='help-stall'){setInterval(()=>{},1000);return;}
 if(mode==='help-failed'){process.stderr.write('synthetic private detail');process.exit(1);}
 const flags=['--input-format','--output-format','--json-schema','--agent','--disable-slash-commands','--new-project','--print-timeout'];
 const help=(mode==='missing-flags'?flags.filter(x=>x!=='--new-project'):flags).map(x=>'  '+x+'  synthetic help').join('\n');
 (mode==='stderr-help'?process.stderr:process.stdout).write(help);process.exit(0);
}
const id='12345678-1234-4234-8234-123456789abc';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(mode==='auth'){process.stderr.write('authentication required');process.exit(1);}
if(mode==='bad-json'){process.stdout.write('not-json\n');process.exit(0);}
if(mode==='stall'){setInterval(()=>{},1000);}
else {
 emit({event:'init',conversation_id:id,init:{cwd,agent,tools:mode==='missing-image-tool'?['run_command']:['generate_image','run_command','view_file'],json_schema:mode==='missing-schema'?undefined:mode==='wrong-schema'?{type:'string'}:JSON.parse(args[args.indexOf('--json-schema')+1]),permission_mode:mode==='missing-permission'?undefined:mode==='turbo'?'always-proceed':'request-review'}});
 let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
  if(['missing-image-tool','turbo','missing-schema','wrong-schema','missing-permission'].includes(mode))process.exit(2);
  const user=JSON.parse(input),prompt=user.message.content;
  if(!prompt.includes('Artwork description'))throw Error('missing prompt');
  if(mode==='preferences'&&(!prompt.includes('Approximate image size preference: 4K')||!prompt.includes('Artwork detail preference: rich fine details')))throw Error('missing preference text');
  if(mode==='wait'){setInterval(()=>{},1000);return;}
  if(mode==='missing'){process.exit(0);}
  if(mode==='quota'){emit({event:'result',result:{conversation_id:id,status:'ERROR',error:'image generation quota exceeded'}});return;}
  if(mode==='permission'){emit({event:'result',result:{conversation_id:id,status:'ERROR',error:'permission denied'}});return;}
  const policy=JSON.parse(fs.readFileSync(path.join(cwd,'image-policy.json'),'utf8'));
  const guard=path.resolve(__dirname,'../../out/image-guard.js');
  const call={toolCall:{name:'generate_image',args:{Prompt:'fixture only',ImageName:'generated_image',AspectRatio:policy.aspectRatio,ImagePaths:policy.references}}};
  if(mode==='framework-metadata')Object.assign(call.toolCall.args,{explanation:'PRIVATE_SUMMARY',toolSummary:'PRIVATE_TASK_SUMMARY',toolAction:'PRIVATE_ACTION',waitForPreviousTools:true});
  if(mode==='guard-ratio')call.toolCall.args.AspectRatio='16:9';
  if(mode==='safe-image-name'||mode==='wrong-image-name')call.toolCall.args.ImageName='Blue Cloud';
  if(mode==='guard-name')call.toolCall.args.ImageName='PRIVATE_SECRET_NAME.png';
  if(mode==='guard-refs')call.toolCall.args.ImagePaths=['/private/SECRET.png'];
  if(mode==='guard-alias')call.toolCall.args.prompt='PRIVATE_SECRET_PROMPT';
  if(mode==='guard-unknown')call.toolCall.args.SECRET_FIELD='PRIVATE_SECRET_VALUE';
  if(mode==='guard-shape')call.toolCall.args='PRIVATE_SECRET_ARGUMENTS';
  if(mode==='guard-defaults'){delete call.toolCall.args.AspectRatio;call.toolCall.args.ImagePaths=null;}
  if(mode==='guard-empty-ratio')call.toolCall.args.AspectRatio='';
  const invokeGuard=()=>spawnSync(process.execPath,[guard,path.join(cwd,'image-policy.json')],{input:JSON.stringify(call),encoding:'utf8'});
  if(mode.startsWith('guard-')&&!['guard-defaults','guard-empty-ratio'].includes(mode)){
   if(mode==='guard-repeat'){const first=invokeGuard();if(JSON.parse(first.stdout).decision!=='allow')throw Error('first guard failed');}
   const rejected=invokeGuard();if(JSON.parse(rejected.stdout).decision!=='deny')throw Error('expected guard rejection');
   // A real CLI may describe hook denial in several ways, or emit its final line without a newline.
   if(mode==='safe-image-name'||mode==='wrong-image-name')call.toolCall.args.ImageName='Blue Cloud';
  if(mode==='guard-name')process.stdout.write(JSON.stringify({event:'result',result:{status:'ERROR',error:'tool execution failed'}}));
   else if(mode==='guard-shape'){process.stderr.write('CLI stopped');process.exitCode=1;}
   else emit({event:'result',result:{status:'ERROR',error:mode==='guard-refs'?'tool failed':'permission denied'}});
   return;
  }
  if(mode!=='no-guard'){
   const g=invokeGuard();if(g.status!==0||JSON.parse(g.stdout).decision!=='allow')throw Error('guard failed');
  }
  const root=path.join(process.env.HOME,'.gemini','antigravity-cli','brain',id);fs.mkdirSync(root,{recursive:true});
  let file=path.join(root,`${mode==='wrong-image-name'?'generated_image':call.toolCall.args.ImageName.replace(/[^a-zA-Z0-9]+/g,'_').toLowerCase().replace(/^_+|_+$/g,'')}_1234567.png`);
  if(mode==='outside')file=path.join(cwd,'arbitrary.png');
  fs.writeFileSync(file,mode==='bad-image'?Buffer.from('not a png'):png());
  if(mode==='symlink'){fs.unlinkSync(file);fs.symlinkSync(path.join(cwd,'image-policy.json'),file);}
  emit({event:'step_update',step_update:{step_type:'tool',tool_name:mode==='wrong-tool'?'run_command':'generate_image',state:'DONE',tool_info:{name:'generate_image',parameters:call.toolCall.args}}});
  const result={conversation_id:id,status:'SUCCESS',structured_output:mode==='no-path'?{}:{image_paths:[file]}};
  emit({event:'result',result});if(mode==='duplicate-result')emit({event:'result',result});
 });
}
