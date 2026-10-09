// Synthetic host adapter: production UI only; no LiveUi backend, tokens, network or official extension.
const vscode=require('vscode'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
exports.activate=context=>{
 const {WorkbenchView}=require(path.join(root,'out/workbench-view')),{registerQuotaTools}=require(path.join(root,'out/quota-tools')),{accountDisplayFingerprint}=require(path.join(root,'out/quota-presentation')),{setLanguage,t:tr}=require(path.join(root,'out/i18n'));
 const accounts=Array.from({length:4},(_,i)=>{const id=String(i+1).padStart(8,'0')+'-0000-4000-8000-000000000001',email=`synthetic${i+1}@example.test`;return{id,label:i===2?'Synthetic account with a very long English label for sidebar wrapping':'合成账号 '+(i+1),expectedEmail:email,capturedAt:'2026-10-01T00:00:00Z',hostCurrent:true,hostId:'synthetic-only',identitySource:'user',quota:{phase:'ready',snapshot:{source:'server',email,observedAt:new Date().toISOString(),buckets:[{bucketId:'gemini-real-bucket',window:'5h',label:'Gemini Pro · 5h',remaining:[.996,.25,.75,null][i],resetAt:'2026-10-10T12:00:00Z'},{bucketId:'claude-real-bucket',window:'7d',label:'Claude Sonnet · Weekly',remaining:.5,resetAt:null},{label:'Unmapped model with an exceptionally long name',remaining:null,resetAt:null}]}}}});
 const initialSnapshots=new Map(accounts.map(a=>[a.id,a.quota.snapshot]));
 let busy=false,mode='hold',pending,provider,tools;const calls=[];
 const repaint=()=>{provider?.refresh();tools?.refresh()};
 const live={getAccounts:()=>accounts,getState:()=>({busy,pending:false,environment:{available:true,message:'合成测试'}})};
 const state=()=>({version:'0.1.8',accounts,snapshots:[],status:'idle',busy,pending:false,recoveryPhase:'none',warning:null,environment:{available:true,message:'合成测试'},quotaPresentation:tools.getState()});
 context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.live.quota',async id=>{
  if(busy)return;const target=accounts.find(a=>a.id===id);if(!target)return;busy=true;calls.push(id);const identity=accountDisplayFingerprint(target),snapshot=target.quota?.snapshot??initialSnapshots.get(id);
  target.quota={phase:'loading',snapshot};repaint();
  let outcome=mode; if(mode==='hold')outcome=await new Promise(resolve=>pending={id,resolve});
  if(accountDisplayFingerprint(target)===identity){target.quota=outcome==='success'?{phase:'ready',snapshot:{...snapshot,observedAt:new Date().toISOString(),buckets:snapshot.buckets.map(b=>({...b,remaining:b.bucketId==='gemini-real-bucket'?.42:b.remaining}))}}:{phase:'error',message:outcome==='cancel'?tr('liveUi.18b0d552f8'):tr('workbenchView.229ba71468'),snapshot};}
  pending=undefined;busy=false;repaint();
 }),vscode.commands.registerCommand('antigravityAccounts.live.quotaCancel',()=>pending?.resolve('cancel')));
 tools=registerQuotaTools(context,live,repaint);provider=new WorkbenchView(state);context.subscriptions.push(provider,vscode.window.registerWebviewViewProvider('antigravityAccounts.accounts',provider));
 const {registerDirectImageUi}=require(path.join(root,'out/direct-image-ui'));let imageRuns=0;const imageDirect={getEndpoint:()=> 'daily',readChoices:async()=>({accounts:accounts.map((a,i)=>({...a,active:i===0})),models:[{id:'synthetic-image-model',label:'Synthetic image model with a long English display name'},{id:'synthetic-other-image',label:'Another synthetic image model'}]}),run:async()=>{imageRuns++;throw Error('Synthetic generation disabled')}};const images=registerDirectImageUi(context,imageDirect,undefined,require('./../helpers/image-session.cjs').memorySession(),tools.preferences);
 return{accounts,calls,state,tools,images,imageRuns:()=>imageRuns,mode:value=>{mode=value},finish:value=>pending?.resolve(value),pending:()=>!!pending,replace:()=>{const target=accounts.find(a=>a.id===pending?.id);if(target){target.capturedAt='2026-10-09T23:59:00Z';delete target.quota;repaint()}},language:value=>{setLanguage(value);repaint()}};
};
