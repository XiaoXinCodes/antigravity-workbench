const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const calls=[],old=Module._load;
Module._load=function(name,...args){return name==='vscode'?{commands:{executeCommand:async(...args)=>calls.push(args)},window:{showWarningMessage(){}}}:old.call(this,name,...args)};
const {routeWorkbenchNavigation}=require('../out/workbench-navigation');Module._load=old;
test('navigation exposes only fixed product destinations and never forwards account data or arbitrary commands',()=>{
 calls.length=0;
 for(const m of [{type:'workbench.navigate',target:'workbench.action.terminal.new'},{type:'workbench.navigate',target:'__proto__'},{type:'workbench.navigate',target:'images',accountId:'private'},{type:'workbench.navigate',target:'settings',value:'en'},{type:'workbench.navigate',target:{command:'unsafe'} }])assert.equal(routeWorkbenchNavigation(m),true);
 assert.equal(calls.length,0);assert.equal(routeWorkbenchNavigation({type:'generate'}),false);
 for(const target of ['accounts','images','records','history','automation','alerts','settings','help','diagnostics'])assert.equal(routeWorkbenchNavigation({type:'workbench.navigate',target}),true);
 assert.deepEqual(calls,[['antigravityAccounts.workbench.open'],['antigravityAccounts.images.open'],['antigravityAccounts.observations.open'],['antigravityAccounts.quota.history'],['antigravityAccounts.automation.open','tasks'],['antigravityAccounts.automation.open','alerts'],['antigravityAccounts.openSettings'],['antigravityAccounts.openHelp'],['antigravityAccounts.support.diagnostics']]);
});
