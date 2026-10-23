const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vscode=require('vscode');
const {Cdp,sleep}=require('./cdp.cjs');
exports.run=async()=>{
 const fixture=await vscode.extensions.getExtension('synthetic.current-plugin-capture').activate(),cdp=await Cdp.connect(Number(process.env.AG_CAPTURE_CDP_PORT)),evidence=process.env.AG_CAPTURE_EVIDENCE,shots=[];
 try{
 await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');await vscode.commands.executeCommand('antigravityAccounts.accounts.focus');
 const ui=await cdp.find('#quota-search'),main=await cdp.find('.monaco-workbench'),read=e=>cdp.eval(e,ui),native=e=>cdp.eval(e,main);
 assert.equal(vscode.extensions.getExtension('google.google-antigravity'),undefined);
 fixture.presentation({activeEmail:fixture.accounts[0].expectedEmail,error:'准备切换失败：切换执行器未能确认就绪。请重新检查当前登录；已准备的记录将保留并自动核对。',lastFailure:{schema:1,at:new Date().toISOString(),action:'switch',stage:'command',phase:'none',code:'UNCLASSIFIED_ERROR'}});
 fixture.processes({phase:'blocked',canContinue:false,currentCount:1,current:{id:'current',pid:4000,owner:'current',scope:'current-window',credentialScopeVerified:true,parentState:'alive',taskState:'unknown',canEnd:false},processes:[1,2,3].map(i=>({id:'peer-'+i,pid:4000+i,owner:'other',scope:'other-window',credentialScopeVerified:true,parentState:'alive',taskState:'unknown',canEnd:false,projects:['synthetic-project-'+i]}))});
 await sleep(200);await read('document.querySelector("#process-conflict-list").open=true');await sleep(100);fixture.repaint();await sleep(200);
 const resize=async width=>{const side=await native('document.querySelector(".part.sidebar").getBoundingClientRect().toJSON()'),before=await read('innerWidth'),sashes=await native('[...document.querySelectorAll(".monaco-sash.vertical")].map(n=>n.getBoundingClientRect().toJSON()).filter(b=>b.width&&b.height)'),sash=sashes.sort((a,b)=>Math.abs(a.x+a.width/2-side.right)-Math.abs(b.x+b.width/2-side.right))[0],x=sash.x+sash.width/2,y=sash.y+sash.height/2;for(const m of [{type:'mouseMoved',x,y},{type:'mousePressed',x,y,button:'left',clickCount:1},{type:'mouseMoved',x:x+width-before,y,button:'left',buttons:1},{type:'mouseReleased',x:x+width-before,y,button:'left',clickCount:1}])await cdp.send('Input.dispatchMouseEvent',m,main.session);await sleep(200)};
 for(const width of [440,240,680]){
 await resize(width);await read('window.scrollTo(0,0)');await sleep(300);
 const metrics=await read(`(()=>{const d=document.querySelector('#backend-diagnostics'),a=document.querySelector('#account-list');return {width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,accounts:document.querySelectorAll('.account').length,diagnosticsOpen:d.open,accountsTop:a.getBoundingClientRect().top,diagnosticsTop:d.getBoundingClientRect().top,destructive:document.querySelectorAll('[data-command="live.processEnd"],[data-command="live.processEndAll"]').length,scope:document.querySelector('#current-status').textContent,green:document.querySelector('#current-status').classList.contains('verified')}})()`);
 assert.equal(metrics.accounts,4);assert.equal(metrics.diagnosticsOpen,false);assert.equal(metrics.destructive,0);assert.equal(metrics.green,false);assert.match(metrics.scope,/不代表本次切换成功/);assert.ok(metrics.accountsTop<metrics.diagnosticsTop);assert.ok(metrics.scroll<=metrics.client,JSON.stringify(metrics));
 const clip=await native('(()=>{const r=document.querySelector(".part.sidebar").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
 const r=await cdp.send('Page.captureScreenshot',{format:'png',clip},main.session),file='switch-failure-'+width+'.png';await fs.writeFile(path.join(evidence,file),Buffer.from(r.data,'base64'));shots.push({file,...metrics});
 }
 await fs.writeFile(path.join(evidence,'capture-receipt.json'),JSON.stringify({passed:true,actualVSCode:true,productionUi:true,synthetic:true,officialRpc:false,shots},null,2));
 }finally{fixture.automation.engine.dispose();cdp.close()}
};
