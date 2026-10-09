const path=require('node:path'),{EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'../..');
exports.activate=context=>{
 const firstId='00000001-0000-4000-8000-000000000001',draft={prompt:'Synthetic image prompt',accountId:firstId,modelId:'synthetic-image-model',ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true};
 const imageSession=require('../helpers/image-session.cjs').memorySession({value:{schema:3,draft,outputDirectory:'',references:[],savedDrafts:[],tasks:[{id:'88888888-8888-4888-8888-888888888888',accountId:firstId,accountLabel:'合成账号 1 · synthetic1@example.test',createdAt:new Date().toISOString(),prompt:'Synthetic image prompt',promptSummary:'Synthetic history',modelId:'synthetic-image-model',ratio:'1:1',count:1,size:'auto',quality:'auto',references:[],phase:'failed',status:'Synthetic failure',outputDirectory:'',images:[]}]}});
 const fixture=require('./quota-host-extension.cjs').activate(context,{imageSession}),{registerAutomationUi,registerIdentityPrivacy}=require(path.join(root,'out/automation-ui')),{accountDisplayFingerprint}=require(path.join(root,'out/quota-presentation')),{sendWake}=require(path.join(root,'out/wake-transport')),{setIdentityHidden}=require(path.join(root,'out/identity-presentation'));
 registerIdentityPrivacy(context);require(path.join(root,'out/i18n-vscode')).registerI18n(context);let now=Date.now(),mode='success',pending;const modelPending=[];const payloads=[],modelCalls=[],notices=[];
 for(const a of fixture.accounts)a.quota.accountFingerprint=accountDisplayFingerprint(a);
 const accounts={fingerprint:id=>{const a=fixture.accounts.find(a=>a.id===id);return a?accountDisplayFingerprint(a):undefined},
  models:async(id,endpoint,signal)=>{modelCalls.push({id,endpoint});if(mode==='models-hold')await new Promise(resolve=>modelPending.push({resolve,id,signal}));return[{id:id===fixture.accounts[0].id?'synthetic-text-alpha':'synthetic-text-beta',label:'Synthetic account-specific model with a very long English model label'}]},
  run:async(task,signal,before)=>{
   if(mode==='prepare-hold')await new Promise(resolve=>pending={resolve,signal,stage:'preparing'});
   const transport=(options,receive)=>{const request=new EventEmitter();request.destroy=()=>{pending=undefined};request.end=body=>{payloads.push({options:{host:options.hostname,path:options.path},body:JSON.parse(body),accountId:task.accountId});const response=new EventEmitter();response.statusCode=200;receive(response);
    const finish=()=>{pending=undefined;if(mode==='timeout')response.emit('aborted');else{response.emit('data',Buffer.from('data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2,"totalTokenCount":14}}}\n\n'));response.emit('end')}};
    if(mode==='sent-hold')pending={resolve:finish,signal,stage:'sent'};else finish()};return request};
   return sendWake({token:'synthetic-never-google',projectId:'synthetic-project',modelId:task.modelId,endpoint:task.endpoint,verify:async()=>{}},task.outputBudget,signal,before,transport);
  }};
 const automation=registerAutomationUi(context,fixture.live??{getAccounts:()=>fixture.accounts,getState:()=>({})},{accounts,now:()=>now,notice:text=>notices.push(text)});
 return{...fixture,automation,payloads,modelCalls,notices,clock:value=>{now=value},mode:value=>{mode=value},finish:()=>pending?.resolve(),pending:()=>pending?.stage,finishModels:()=>modelPending.shift()?.resolve(),privacy:value=>setIdentityHidden(value),observe:()=>automation.observe(),quota:(fraction)=>{const a=fixture.accounts[0];now+=1000;a.quota={phase:'ready',accountFingerprint:accountDisplayFingerprint(a),snapshot:{...a.quota.snapshot,observedAt:new Date(now).toISOString(),buckets:a.quota.snapshot.buckets.map(b=>({...b,remaining:fraction}))}}}};
};
