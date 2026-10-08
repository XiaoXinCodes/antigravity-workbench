// Offline interactive fixture: production HTML, synthetic accounts, zero account-service or image requests.
const fs=require('node:fs'),path=require('node:path'),{directImageHtml}=require('../out/direct-image-view');
const dir=path.resolve('.test-results');fs.mkdirSync(dir,{recursive:true});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const state={type:'state',busy:false,status:'模拟预览 · 不连接真实账号服务',accountStatus:'',accountBlocked:false,choicesLoading:false,canCheckAccount:false,
 choices:{accounts:[{id:A,label:'工作账号 A · synthetic.a@example.test',active:true},{id:B,label:'创作账号 B · synthetic.b@example.test',active:false}],models:[{id:'gemini-3.1-flash-image',label:'Nano Banana 2 · A'}]},
 draft:{prompt:'一座安静的海边灯塔，清晨暖光，简洁的插画构图。',accountId:A,followCurrent:true,modelId:'gemini-3.1-flash-image',ratio:'16:9',count:2,size:'2K',quality:'detail'},outputDirectory:'/synthetic/images',references:[],images:[],tasks:[],recentDiagnostic:'',operationHistory:''};
const mock=`window.fixture=${JSON.stringify(state)};window.messages=[];window.fixtureCheckRevision=0;window.fixtureAutoComplete=true;
window.finishFixtureCheck=(revision=window.fixtureCheckRevision)=>{if(revision!==window.fixtureCheckRevision)return;const s=window.fixture,isB=s.draft.accountId==='${B}';s.choicesLoading=false;s.canCheckAccount=!s.draft.followCurrent;s.accountBlocked=false;s.choices.models=[{id:isB?'gemini-3-pro-image':'gemini-3.1-flash-image',label:isB?'Nano Banana Pro · B':'Nano Banana 2 · A'}];s.draft.modelId=s.choices.models[0].id;s.accountStatus=s.draft.followCurrent?'':'仅用于生图；官方当前登录保持不变';window.emitFixture()};
window.startFixtureCheck=()=>{const s=window.fixture,revision=++window.fixtureCheckRevision;s.choicesLoading=true;s.canCheckAccount=false;s.accountBlocked=true;s.choices.models=[];s.draft.modelId='';s.accountStatus='正在核验所选账号身份与图片模型';window.emitFixture();if(window.fixtureAutoComplete)setTimeout(()=>window.finishFixtureCheck(revision),250)};window.emitFixture=()=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(window.fixture)}));
window.acquireVsCodeApi=()=>({getState:()=>window.savedState||{},setState:s=>window.savedState=s,postMessage:m=>{window.messages.push(m);const s=window.fixture;
 if(m.type==='ready'){setTimeout(window.emitFixture,0)}
 else if(m.type==='selectAccount'){s.draft={...s.draft,...m,followCurrent:m.selection==='@current',accountId:m.selection==='@current'?'${A}':m.selection};window.startFixtureCheck()}
 else if(m.type==='checkAccount'){window.startFixtureCheck()}
 else if(m.type==='draft'){s.draft={...s.draft,...m}}
 else if(m.type==='generate'){const id=s.draft.accountId;s.tasks.push({id:'synthetic-task-'+s.tasks.length,createdAt:'2026-10-04T10:30:00Z',accountId:id,accountLabel:id==='${B}'?'创作账号 B · synthetic.b@example.test':'工作账号 A · synthetic.a@example.test',promptSummary:m.prompt,modelId:m.modelId,ratio:m.ratio,size:m.size,quality:m.quality,count:m.count,phase:'cancelled',status:'仅演示任务卡；未向任何服务提交',images:[]});window.emitFixture()}
 else if(m.type==='deleteTask'){s.tasks=s.tasks.filter(t=>t.id!==m.taskId);window.emitFixture()}
 else if(m.type==='saveRecords'){s.storageBlocked=false;s.storageNotice='';window.emitFixture()}
 else if(m.type==='cancel'){window.fixtureCheckRevision++;s.busy=false;s.choicesLoading=false;s.accountBlocked=true;s.canCheckAccount=true;s.accountStatus='已取消账号状态检查，未提交图片';window.emitFixture()}
}});`;
const nonce='offline-image-accounts';
let html=directImageHtml(nonce,'', {resultsShare:.35,resultsCollapsed:false});
html=html.replace('</head>',`<script nonce="${nonce}">${mock}</script></head>`);
fs.writeFileSync(path.join(dir,'image-accounts.html'),html);console.log('Generated isolated interactive account-selection fixture.');
