const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vscode=require('vscode');
const {Cdp,sleep}=require('./fixtures/cdp.cjs');
exports.run=async()=>{
 const fixture=await vscode.extensions.getExtension('synthetic.quota-ui-fixture').activate();
 assert.equal(vscode.extensions.getExtension('xiaoxincodes.antigravity-account-manager'),undefined);
 assert.equal(vscode.extensions.getExtension('google.google-antigravity'),undefined);
 await vscode.commands.executeCommand('antigravityAccounts.accounts.focus');
 const cdp=await Cdp.connect(Number(process.env.AG_QUOTA_CDP_PORT));
 try{
  const context=await cdp.find('#quota-compare'),read=expression=>cdp.eval(expression,context);
  await fs.writeFile(path.join(process.env.AG_QUOTA_EVIDENCE,'restart-state-debug.json'),JSON.stringify({stored:fixture.viewState(),api:await read('api.getState()'),seed:await read('document.querySelector("script[nonce]").textContent.match(/const previous=[^;]*/)?.[0]')},null,2));
  const key=JSON.stringify(['bucket','','gemini-real-bucket','5h']);
  for(let n=0;n<150&&await read('document.querySelector("#quota-compare").value')!==key;n++)await sleep(40);
  assert.equal(await read('document.querySelector("#quota-compare").value'),key);
  assert.equal(await read('document.querySelector("#quota-sort").value'),'low');
  assert.equal(await read('document.querySelector("#quota-search").value'),'');
  assert.equal(fixture.calls.length,0);assert.equal(fixture.imageRuns(),0);assert.deepEqual(fixture.tools.preferences.getState().favorites,[key]);assert.deepEqual(fixture.tools.preferences.getState().imageFavorites,['synthetic-image-model']);
  const evidence=process.env.AG_QUOTA_EVIDENCE,result=JSON.parse(await fs.readFile(path.join(evidence,'result.json'),'utf8'));
  result.checks.compareFullWorkbenchReloadPreservesSelection=true;
  result.fullWorkbenchReload=true;result.checks.favoritesSurviveFullWorkbenchReload=true;
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
  console.log('QUOTA_RESTART_RESULT '+JSON.stringify(result));
 }finally{cdp.close()}
};
