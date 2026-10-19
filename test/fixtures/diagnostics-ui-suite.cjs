// Run inside the isolated screenshot host. Synthetic transport only.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { imageHttpFailure } = require('../../out/direct-image-http-error');
const { sleep } = require('./cdp.cjs');
exports.run = async (cdp, ui, fixture, capture) => {
  const read = expression => cdp.eval(expression, ui);
  const until = async fn => { for (let i=0;i<100;i++) { if(await fn()) return; await sleep(40); } throw Error('Diagnostic UI timed out'); };
  const original = fixture.imageDirect.readImageQuota, originalChoices = fixture.imageDirect.readChoices;
  fixture.imageDirect.readChoices = async () => ({accounts:fixture.accounts.map((a,i)=>({...a,active:i===0})),models:[{id:'synthetic-image-model',label:'Synthetic image model'}]});
  await cdp.click(ui,'#checkAccount');
  await until(()=>read('!document.querySelector("#queryQuota").disabled'));
  const prompt = await read('document.querySelector("#prompt").value');
  try {
    for (const language of ['zh-CN','en']) {
      await vscode.workspace.getConfiguration('antigravityAccounts').update('language',language,vscode.ConfigurationTarget.Global);
      await until(()=>read(`document.documentElement.lang===${JSON.stringify(language)}`));
      for (const [name,reason] of [['verification','VALIDATION_REQUIRED'],['permission','PERMISSION_DENIED'],['unknown',undefined],['waits','QUOTA_EXHAUSTED']]) {
        const details=reason?[{reason}]:[];
        if(name==='waits') { details[0].metadata={quotaResetDelay:'58h24m53s'};details.push({'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'90s'}); }
        const error=imageHttpFailure(name==='waits'?429:403,{error:{details}},name==='waits'?'3':undefined);
        fixture.imageDirect.readImageQuota=async()=>{throw error};
        await cdp.click(ui,'#queryQuota');
        const expected=name==='waits'?'210293':name==='verification'?language==='en'?'requires verification':'需要完成验证':name==='permission'?language==='en'?'lacks permission':'没有本次操作所需的权限':language==='en'?'reason is unclear':'原因尚不明确';
        await until(()=>read(`document.querySelector('#imageQuotaError').textContent.includes(${JSON.stringify(expected)})`));
        const text=await read('document.querySelector("#imageQuotaError").textContent');
        assert.doesNotMatch(text,/IMAGE_|RetryInfo|Retry-After|https?:/);
        if(name==='waits') {assert.match(text,/90/);assert.match(text,/3/);}
        assert.equal(await read('document.querySelector("#imageDebug").open'),false);
        assert.equal(await read('document.querySelector("#prompt").value'),prompt);
        await read('document.querySelector("#imageQuotaStatus").scrollIntoView({block:"center"})');
        await capture(`09-diagnostic-${name}-${language}.png`,`${name} diagnostic (${language}, synthetic failure)`,{width:await read('innerWidth')});
      }
    }
  } finally {
    fixture.imageDirect.readImageQuota=original; fixture.imageDirect.readChoices=originalChoices;
    await vscode.workspace.getConfiguration('antigravityAccounts').update('language','zh-CN',vscode.ConfigurationTarget.Global);
    await cdp.click(ui,'#queryQuota');
    await until(()=>read('document.querySelector("#imageQuotaError").textContent===""'));
  }
};
