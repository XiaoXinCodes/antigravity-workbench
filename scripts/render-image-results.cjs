// Production view + synthetic result states. No account, editor, filesystem or service writes from this preview.
const fs=require('node:fs'),path=require('node:path'),{directImageHtml}=require('../out/direct-image-view');
const dir=path.resolve('.test-results');fs.mkdirSync(dir,{recursive:true});
const picture=(night=false)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="${night?'#213753':'#efdccc'}"/><circle cx="750" cy="150" r="65" fill="${night?'#e2e6c0':'#da8970'}"/><path d="M0 395Q250 310 470 395T960 395V640H0" fill="${night?'#3e6c87':'#76a6a0'}"/><path d="M0 500Q220 410 450 510T960 500V640H0" fill="${night?'#294558':'#467b80'}"/><path d="M450 375L485 180H545L580 375Z" fill="#f1e9d7"/><path d="M475 180V148L515 122L555 148V180Z" fill="${night?'#c4ad8a':'#a75448'}"/><rect x="497" y="203" width="35" height="55" rx="3" fill="#304e63"/><path d="M430 385H600L646 425H385Z" fill="#334e55"/><text x="40" y="590" fill="#f4eee5" font-size="24" font-family="sans-serif">SYNTHETIC PREVIEW · ${night?'EVENING VERSION':'MORNING ORIGINAL'}</text></svg>`).toString('base64');
const A='11111111-1111-4111-8111-111111111111',parent='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',child='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image=(preview,index=0)=>({index,name:index?'evening (2).png':'灯塔 (1).png',width:960,height:640,preview});
const task=(id,prompt,preview,origin)=>({id,createdAt:'2026-10-05T10:30:00Z',accountId:A,accountLabel:'示例账号 A',promptSummary:prompt,modelId:'gemini-3.1-flash-image',ratio:'3:2',count:1,size:'auto',quality:'auto',phase:'complete',status:'已保存 1 张图片 · 本页均为模拟数据',images:[image(preview)],...(origin?{origin}: {})});
const first=task(parent,'海边灯塔，温暖晨光，简洁插画。',picture()),second=task(child,'保留灯塔构图，将光线改为宁静的蓝调傍晚。',picture(true),{taskId:parent,imageIndex:0,rootTaskId:parent,rootImageIndex:0});
const versions=[{key:parent+':0',label:'原图 · 创作 1 / 图 1'},{key:child+':0',label:'修改图 · 创作 2 / 图 1'}];
const state={type:'state',busy:false,status:'本地交互预览 · 模拟数据 · 没有真实请求',accountStatus:'仅用于生图；官方当前登录保持不变',accountBlocked:false,choicesLoading:false,canCheckAccount:true,
 choices:{accounts:[{id:A,label:'示例账号 A',active:true}],models:[{id:'gemini-3.1-flash-image',label:'Nano Banana 2'}]},
 draft:{prompt:second.promptSummary,accountId:A,followCurrent:false,modelId:first.modelId,ratio:'3:2',count:1,size:'auto',quality:'auto'},outputDirectory:'/synthetic/项目/images',references:['灯塔 (1).png'],images:[],tasks:[first,second],recentDiagnostic:'',operationHistory:'',
 iteration:{taskId:parent,imageIndex:0,name:'灯塔 (1).png',modelUnavailable:false},savedDrafts:[{id:'draft-original',savedAt:'2026-10-05T10:20:00Z',summary:'之前未提交的草稿：绿色山间的小屋。'}],
 actionNotice:'已载入这张图片和原任务参数；原草稿可从保留列表恢复。',editorTarget:{id:7,label:'docs/设计说明 (草稿).md',selectionCount:1,replacesSelection:false,canInsert:true},
 comparison:{versions,left:{...versions[0],...first.images[0]},right:{...versions[1],...second.images[0]}}};
const mock=`window.fixture=${JSON.stringify(state)};window.messages=[];window.savedState={};window.emitFixture=()=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(window.fixture)}));
window.acquireVsCodeApi=()=>({getState:()=>window.savedState,setState:s=>window.savedState=s,postMessage:m=>{window.messages.push(m);const s=window.fixture;
 if(m.type==='ready')setTimeout(window.emitFixture,0);
 else if(m.type==='draft')s.draft={...s.draft,...m};
 else if(m.type==='compareSelect'){s.comparison[m.side]=m.key.startsWith('${parent}')?{...s.comparison.versions[0],...s.tasks[0].images[0]}:{...s.comparison.versions[1],...s.tasks[1].images[0]};window.emitFixture()}
 else if(m.type==='closeCompare'){s.comparison=undefined;window.emitFixture()}
 else if(m.type==='continueImage'){s.actionNotice='模拟：已载入参考图；没有发送请求';window.emitFixture()}
 else if(m.type==='restoreDraft'||m.type==='deleteDraft'){s.savedDrafts=[];s.actionNotice='模拟草稿操作；没有修改实际记录';window.emitFixture()}
 else if(m.type==='detachIteration'){s.iteration=undefined;window.emitFixture()}
 else if(m.type==='copyPath'||m.type==='copyMarkdown'||m.type==='insertMarkdown'||m.type==='copyToProject'){s.actionNotice='模拟 '+m.type+'：没有写入真实剪贴板、文档或图片';window.emitFixture()}
}});`;
const nonce='offline-image-results';fs.writeFileSync(path.join(dir,'image-results.html'),directImageHtml(nonce,'',{resultsShare:.55,resultsCollapsed:false}).replace('</head>',`<script nonce="${nonce}">${mock}</script></head>`));
console.log('Wrote isolated synthetic image-results preview.');
