const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeImageCatalog,diagnoseImageCatalog}=require('../out/image-catalog-diagnostic');
const n='gemini-nano-banana-2.1',p='gemini-3-pro-image';
const catalog=(ids=[n],models={})=>({imageGenerationModelIds:ids,models:Object.fromEntries(ids.map(id=>[id,{}]).concat(Object.entries(models)))});
const signal=new AbortController().signal;
function fixture(){let endpoint='daily',changed=false,directs=0,checks=0;const accounts=[{id:'current',hostCurrent:true,expectedEmail:'synthetic@example.test'},{id:'other',hostCurrent:true,expectedEmail:'other@example.test'}];
 const deps={endpoint:()=>endpoint,accounts:()=>accounts,now:()=>new Date('2026-10-07T10:00:00Z'),hub:async()=>({email:'synthetic@example.test',catalog:catalog([n],{[p]:{disabled:true},privateToken:'SENTINEL_TOKEN',email:'SENTINEL_EMAIL',project:'SENTINEL_PROJECT'}),verify:async()=>{checks++;if(changed)throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED')}}),
 direct:async(id,s,target,verify)=>{directs++;assert.equal(id,'current');assert.equal(target,'daily');assert.equal(s,signal);await verify();return summarizeImageCatalog(catalog([n,p],{[p]:{disabled:false}}))}};
 return{deps,accounts,get directs(){return directs},get checks(){return checks},change:()=>changed=true,endpoint:e=>endpoint=e};}
test('catalog projection keeps only bounded IDs and boolean disabled declarations',()=>{
 const result=summarizeImageCatalog({...catalog([n],{[p]:{disabled:true,label:'SENTINEL_EMAIL'}}),token:'SENTINEL_TOKEN',project:'SENTINEL_PROJECT',prompt:'SENTINEL_PROMPT'});
 assert.equal(result.status,'queried');assert.deepEqual(result.imageModels,[{id:n,disabled:'unspecified'}]);assert.deepEqual(result.allModels,[{id:n,disabled:'unspecified',listed:true},{id:p,disabled:true,listed:false}]);assert.doesNotMatch(JSON.stringify(result),/SENTINEL/);
 for(const data of [{},catalog([n,n]),{imageGenerationModelIds:[n],models:{}},catalog(['bad\nID']),catalog(['ya29.private-secret']),catalog([n],{[n]:{disabled:'false'}})])assert.equal(summarizeImageCatalog(data).status,'invalid');
});
test('same-account diagnosis shows difference, Pro declarations, endpoint and unknown cache age without private fields',async()=>{
 const f=fixture(),report=await diagnoseImageCatalog(f.deps,signal);assert.equal(f.directs,1);assert.ok(f.checks>=2);
 for(const pattern of [/仅直连列出的图片模型：gemini-3-pro-image/,/disabled=true/,/disabled=false/,/未列为图片模型/,/daily-cloudcode-pa.googleapis.com/,/缓存年龄未知/,/2026-10-07T10:00:00.000Z/,/空 payload/])assert.match(report,pattern);
 assert.doesNotMatch(report,/SENTINEL|synthetic@example|other@example/);
});
for(const kind of ['none','duplicate','foreign','pending'])test(`no direct lookup when current saved account matching is ${kind}`,async()=>{
 const f=fixture();if(kind==='none')f.accounts.shift();if(kind==='duplicate')f.accounts.push({...f.accounts[0],id:'duplicate'});if(kind==='foreign')f.accounts[0].hostCurrent=false;if(kind==='pending')f.accounts[0].migrationState='pending';
 const report=await diagnoseImageCatalog(f.deps,signal);assert.equal(f.directs,0);assert.match(report,/无法唯一匹配/);assert.match(report,/未查询/);assert.doesNotMatch(report,/仅直连列出的图片模型/);
});
for(const kind of ['hub','direct','empty','malformed'])test(`diagnosis distinguishes ${kind} without claiming permission or leaking errors`,async()=>{
 const f=fixture();if(kind==='hub')f.deps.hub=async()=>{throw Error('SENTINEL_TOKEN_EMAIL_PROJECT')};if(kind==='direct')f.deps.direct=async()=>{throw Error('SENTINEL_TOKEN_EMAIL_PROJECT')};if(kind==='empty')f.deps.direct=async()=>summarizeImageCatalog(catalog([]));if(kind==='malformed')f.deps.direct=async()=>summarizeImageCatalog({});
 const report=await diagnoseImageCatalog(f.deps,signal);assert.match(report,/均不代表没有权限/);assert.doesNotMatch(report,/SENTINEL/);
 assert.match(report,kind==='empty'?/未列出图片模型/:/查询失败/);if(kind==='hub')assert.equal(f.directs,0);
});
for(const kind of ['identity','endpoint','removed'])test(`late diagnostic ${kind} change invalidates comparison`,async()=>{
 const f=fixture(),read=f.deps.direct;f.deps.direct=async(...args)=>{const value=await read(...args);if(kind==='identity')f.change();if(kind==='endpoint')f.endpoint('production');if(kind==='removed')f.accounts.shift();return value};
 const report=await diagnoseImageCatalog(f.deps,signal);assert.match(report,/结果已丢弃/);assert.doesNotMatch(report,/仅直连列出的图片模型：gemini/);
});

test('on-demand diagnostic retains minimal image-list presence reasons without credentials or Hub assumptions',async()=>{
 const f=fixture();f.deps.hub=async()=>({email:'synthetic@example.test',catalog:{models:{'opaque-input-id':{supportsImages:true}}},verify:async()=>{}});f.deps.direct=async()=>summarizeImageCatalog({models:{},imageGenerationModelIds:[]});
 const report=await diagnoseImageCatalog(f.deps,signal);assert.match(report,/IMAGE_CATALOG_LIST_MISSING/);assert.match(report,/IMAGE_CATALOG_LIST_EMPTY/);assert.doesNotMatch(report,/synthetic@example|supportsImages|SENTINEL|projectId/);
 assert.equal(summarizeImageCatalog({models:{},imageGenerationModelIds:null}).imageListIssue,'IMAGE_CATALOG_LIST_INVALID');
 f.deps.direct=async()=>{throw Error('IMAGE_CATALOG_LIST_INVALID')};assert.match(await diagnoseImageCatalog(f.deps,signal),/IMAGE_CATALOG_LIST_INVALID/);
});

test('bilingual difference section compares image members only while separate complete catalogs may differ',async()=>{
 const {setLanguage,localizeLines}=require('../out/i18n'),f=fixture();
 const visual='synthetic-visual-only',hubOnly='synthetic-hub-text',directOnly='synthetic-direct-text';
 f.deps.hub=async()=>({email:'synthetic@example.test',catalog:catalog([visual],{[hubOnly]:{}}),verify:async()=>{}});
 f.deps.direct=async()=>summarizeImageCatalog(catalog([visual],{[directOnly]:{}}));
 try{
  setLanguage('zh-CN');const report=await diagnoseImageCatalog(f.deps,signal);assert.match(report,/图片模型差异（同账号；仅比较图片清单成员）/);assert.match(report,new RegExp(hubOnly));assert.match(report,new RegExp(directOnly));
  const tail=report.slice(report.indexOf('图片模型差异'));assert.match(tail,/仅 Hub 列出的图片模型：无/);assert.match(tail,/仅直连列出的图片模型：无/);assert.match(tail,/图片模型 disabled 声明不同：无/);assert.doesNotMatch(tail,/synthetic-(?:hub|direct)-text/);
  setLanguage('en');assert.match(localizeLines(report),/Image model differences \(same account; image-list members only\)/);const english=await diagnoseImageCatalog(f.deps,signal);assert.match(english,/Image model differences \(same account; image-list members only\)/);assert.match(english,/Image models listed only by Hub: None/);assert.match(english,/Image models listed only by direct catalog: None/);assert.match(english,/Different image model disabled declarations: None/);assert.match(english,new RegExp(hubOnly));assert.match(english,new RegExp(directOnly));
 }finally{setLanguage('zh-CN')}
});
