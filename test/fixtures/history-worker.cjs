// Independent processes share production history persistence; identities are synthetic.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {PrivateState}=require('../../out/private-state'),{QuotaHistory,parseQuotaHistory,initialQuotaHistory}=require('../../out/quota-history'),{accountDisplayFingerprint}=require('../../out/quota-presentation');
(async()=>{
 const [root,action]=process.argv.slice(2),accounts=()=>JSON.parse(fs.readFileSync(path.join(root,'accounts.json'),'utf8'));
 const now=Date.parse('2026-10-09T12:00:00Z'),history=new QuotaHistory(new PrivateState(path.join(root,'private'),parseQuotaHistory,initialQuotaHistory),accounts,()=>{},()=>now);
 if(action==='clear')return history.clear();if(action==='reconcile')return history.reconcile();
 const account=accounts()[0],sample={accountId:account.id,fingerprint:accountDisplayFingerprint(account),kind:'bucket',key:'synthetic-bucket',label:'Synthetic',observedAt:new Date(now).toISOString(),fraction:.8,resetAt:null};
 if(action==='held-record'){
  await fsp.writeFile(path.join(root,'ready'),'synthetic');const deadline=Date.now()+5000;
  while(!fs.existsSync(path.join(root,'release'))){if(Date.now()>deadline)throw Error('Synthetic release timeout');await new Promise(resolve=>setTimeout(resolve,10))}
 }
 await history.record(sample);
})().catch(error=>{console.error(error);process.exitCode=1});
