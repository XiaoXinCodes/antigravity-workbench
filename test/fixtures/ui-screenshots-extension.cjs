const path=require('node:path'),vscode=require('vscode');
const root=path.resolve(__dirname,'../..'),load=name=>require(path.join(root,'out',name));
exports.activate=context=>{
 load('i18n-vscode').registerI18n(context);load('automation-ui').registerIdentityPrivacy(context);
 const A='00000001-0000-4000-8000-000000000001',taskId='88888888-8888-4888-8888-888888888888';
 const imageSession=require(path.join(root,'test/helpers/image-session.cjs')).memorySession({value:{schema:3,draft:{prompt:'虚构测试提示词：一幅简洁的山水场景草图',accountId:A,modelId:'synthetic-image-model',ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true},outputDirectory:'',references:[],savedDrafts:[],tasks:[{id:taskId,accountId:A,accountLabel:'虚构测试账号 1',createdAt:new Date().toISOString(),prompt:'虚构测试历史：一幅清晨的山水场景草图',promptSummary:'虚构测试历史 · 场景草图',modelId:'synthetic-image-model',ratio:'16:9',count:2,size:'2K',quality:'detail',references:['/tmp/synthetic-missing-reference.png'],phase:'failed',status:'虚构测试任务：模拟失败，未发送真实请求',outputDirectory:'',images:[]}]}});
 const {accountDisplayFingerprint}=load('quota-presentation');let reads=0,wakeCalls=0;
 const fixture=require(path.join(root,'test/fixtures/quota-host-extension.cjs')).activate(context,{imageSession,historyFactory:live=>load('quota-history-ui').registerQuotaHistory(context,live),imageDirect:{selectSavedAccount:()=>{},hasSavedAccountSelection:()=>true,readCandidateImageQuota:async(id,model,_signal,endpoint)=>{reads++;return{accountId:id,modelId:model,endpoint,remainingFraction:[.996,.8,null,0][Number(id.slice(0,8))-1],resetAt:null,queriedAt:new Date().toISOString()}}}});
 fixture.imageDirect.readChoices=async()=>({accounts:fixture.accounts.map((a,i)=>({...a,active:i===0})),models:[{id:'synthetic-image-model',label:'模拟图片模型 · Gemini 图像'},{id:'synthetic-other-image',label:'模拟图片模型二'}]});
 for(const [i,a]of fixture.accounts.entries()){a.label='虚构测试账号 '+(i+1);a.quota.accountFingerprint=accountDisplayFingerprint(a);a.quota.snapshot.buckets[0].label='Gemini Pro · 5 小时';a.quota.snapshot.buckets[1].label='Claude Sonnet · 7 天';a.quota.snapshot.buckets[2].label='未分组新模型（测试）'}
 const automation=load('automation-ui').registerAutomationUi(context,fixture.live,{accounts:{fingerprint:id=>{const a=fixture.accounts.find(a=>a.id===id);return a&&accountDisplayFingerprint(a)},models:async()=>[{id:'synthetic-text-alpha',label:'模拟文本模型 · Gemini 家族'}],run:async()=>{wakeCalls++;throw Error('SCREENSHOT_REAL_REQUESTS_DISABLED')},quota:async()=>{throw Error('SCREENSHOT_REAL_REQUESTS_DISABLED')}}});
 const disclosure=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,1000);disclosure.text='$(beaker) 虚构账号 · 模拟额度 · 无真实调用';disclosure.tooltip='实际运行的生产 UI；测试数据来自本地合成适配器。';disclosure.show();context.subscriptions.push(disclosure);
 return{...fixture,automation,imageSession,reads:()=>reads,wakeCalls:()=>wakeCalls};
};

