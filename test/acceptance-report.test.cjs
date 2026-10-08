const test=require('node:test'),assert=require('node:assert/strict');
const {acceptanceEvents,acceptanceReport}=require('../out/acceptance-report');
test('acceptance export uses the installed manifest version and never echoes arbitrary version text',()=>{
 assert.equal(JSON.parse(acceptanceReport([],2,'linux','0.15.8')).extensionVersion,'0.15.8');
 for(const value of [undefined,'SECRET',{},'0.15.8\nSECRET']){
  const report=acceptanceReport([],2,'linux',value);assert.equal(JSON.parse(report).extensionVersion,'unknown');assert.doesNotMatch(report,/SECRET/);
 }
});
test('acceptance export rebuilds from a strict allowlist and never copies token, account, path or raw error fields',()=>{
 const report=acceptanceReport([{action:'quota-ready',at:'2026-10-01T00:00:00Z',email:'private@example.test',token:'SECRET',path:'/private',error:'SECRET'},{action:'SECRET',at:'2026-10-01'},{action:'switch-verified',at:'bad'}],2,'linux');
 assert.doesNotMatch(report,/SECRET|private@example|\/private/);assert.equal(JSON.parse(report).events.length,1);assert.equal(JSON.parse(report).savedAccountCount,2);
});
test('acceptance export bounds output, rejects unknown platform and does not imply full coverage',()=>{
 assert.equal(acceptanceEvents(Array.from({length:200},()=>({action:'quota-failed',at:'2026-10-01'}))).length,100);
 const result=JSON.parse(acceptanceReport(null,999,'PRIVATE HOST'));assert.equal(result.savedAccountCount,0);assert.equal(result.platform,'unknown');assert.match(result.scope,/Observed local operations only/);
});
