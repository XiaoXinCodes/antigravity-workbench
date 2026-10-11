require('../helpers/offline-only.cjs');
const path=require('node:path'),fs=require('node:fs/promises'),vscode=require('vscode'),root=path.resolve(__dirname,'../..');
exports.activate=async context=>{
 const {responseModels}=require(path.join(root,'out/model-observation')),{initialWakeState,parseWakeState}=require(path.join(root,'out/wake-state')),{registerAutomationUi,registerIdentityPrivacy}=require(path.join(root,'out/automation-ui')),{registerObservationsUi}=require(path.join(root,'out/request-observation-ui'));
 const taskId='88888888-8888-4888-8888-888888888888',oldId='99999999-9999-4999-8999-999999999999',A='00000001-0000-4000-8000-000000000001';const draft={prompt:'Synthetic draft preserved',accountId:A,modelId:'synthetic-request-image',ratio:'1:1',count:2,size:'auto',quality:'auto',followCurrent:true};
 const task={id:taskId,accountId:A,createdAt:new Date().toISOString(),prompt:'Synthetic submitted prompt',promptSummary:'Synthetic current task',modelId:draft.modelId,ratio:'1:1',size:'auto',quality:'auto',count:2,references:[],phase:'complete',status:'synthetic',outputDirectory:'',images:[],responseModels:[responseModels({response:{modelVersion:'synthetic-image-route-a'}}),responseModels({modelVersion:'synthetic-image-route-b'})]};
 const old={...task,id:oldId,promptSummary:'Synthetic legacy task'};delete old.responseModels;
 const session=require('../helpers/image-session.cjs').memorySession({value:{schema:3,draft,outputDirectory:'',references:[],savedDrafts:[],tasks:[task,old]}});
 const fixture=require('./quota-host-extension.cjs').activate(context,{imageSession:session});registerIdentityPrivacy(context);
 let state=initialWakeState();const instance={id:'synthetic-wake-current',taskId,revision:oldId,accountId:A,modelId:'synthetic-request-text',due:Date.now(),manual:false,nonce:taskId,leaseUntil:0,phase:'succeeded',code:'WAKE_COMPLETE',responseModel:require(path.join(root,'out/wake-transport')).parseWakeStream('data: {"response":{"modelVersion":"synthetic-wake-route-a"}}\ndata: {"response":{"modelVersion":"synthetic-wake-route-b"}}\ndata: [DONE]\n').responseModel};state.instances=[instance,{...instance,id:'synthetic-wake-legacy',responseModel:undefined}];
 const store={read:async()=>structuredClone(state),transaction:async fn=>{const next=structuredClone(state),result=fn(next);state=parseWakeState(next);return result}};let wakeCalls=0;
 registerAutomationUi(context,fixture.live,{store,accounts:{fingerprint:()=> 'synthetic',run:async()=>{wakeCalls++;throw Error('GENERATION_FORBIDDEN')},models:async()=>[]}});
 const home=path.join(context.globalStorageUri.fsPath,'synthetic-home'),directory=path.join(home,'.gemini','antigravity-cli','conversations');await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'11111111-1111-4111-8111-111111111111.db'),{database,generation}=require('../helpers/generation-fixture.cjs');const db=await database(file,[generation(),generation({models:[],usage:{},id:'second'}),generation({models:['synthetic-route-a','synthetic-route-b'],id:'third'})]);let selections=0;
 let verified=false;const exportFiles=[];
 context.subscriptions.push(vscode.commands.registerCommand('synthetic.observations.verifiedFixture',()=>{verified=true}));
 registerObservationsUi(context,{runtime:{home,platform:process.platform},pick:async()=>{selections++;return[vscode.Uri.file(file)]},read:async(selected,abort)=>{
  const result=await require(path.join(root,'out/local-generation-db')).readLocalGenerationDb(selected,abort,verified?{schema:'google-antigravity-1.7.0'}:{});
  // Explicitly trusted synthetic dates/workspace exercise display and filtering;
  // the product reader does not infer these fields from real unversioned DBs.
  if(verified)for(const row of result.rows){row.timestamp={status:'provided',value:Date.now()-[0,86400000,8*86400000][row.index],fields:['synthetic.verified.timestamp']};if(row.index===0)row.project={status:'provided',values:[{key:'a'.repeat(64),label:'Synthetic workspace'}],fields:['synthetic.verified.workspace']}}
  return result;
 },save:async format=>{const name=path.join(context.globalStorageUri.fsPath,'synthetic-usage-'+exportFiles.length+'.'+format);exportFiles.push(name);return vscode.Uri.file(name)}});
 const runtime={node:process.versions.node,electron:process.versions.electron,platform:process.platform};try{runtime.builtinSqlite=typeof require('node:sqlite').DatabaseSync==='function'}catch{runtime.builtinSqlite=false}
 return{...fixture,session,runtime,wakeCalls:()=>wakeCalls,selections:()=>selections,exports:async()=>Promise.all(exportFiles.map(name=>fs.readFile(name,'utf8'))),shutdown:()=>db.close()};
};
