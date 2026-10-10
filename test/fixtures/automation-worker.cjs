// Independent process simulates a second extension host sharing the durable store.
const fs=require('node:fs/promises'),path=require('node:path');
const {PrivateState}=require('../../out/private-state'),{parseWakeState,initialWakeState}=require('../../out/wake-state'),{WakeEngine}=require('../../out/wake-engine');
const {LiveError}=require('../../out/live-storage');
(async()=>{
 const directory=process.argv[2],now=Number(process.argv[3]),store=new PrivateState(directory,parseWakeState,initialWakeState);
 const engine=new WakeEngine(store,{fingerprint:()=> 'synthetic-bound-A',run:async(_task,_signal,before)=>{await before();await fs.appendFile(path.join(directory,'synthetic-sends.txt'),String(process.pid)+'\n');await new Promise(r=>setTimeout(r,150));return{phase:'succeeded',code:'WAKE_COMPLETE'}}},()=>{},()=>now);
 // A sibling can be writing its lock marker. A later poll may try again, but
 // neither this fixture nor the store repairs or removes an uncertain lock.
 for(let n=0;n<8;n++){try{await engine.tick()}catch(error){if(!(error instanceof LiveError)||!['LIVE_OPERATION_OR_RECOVERY_LOCKED','LOCK_RECORD_REQUIRES_MANUAL_CHECK'].includes(error.code))throw error}await new Promise(r=>setTimeout(r,100))}engine.dispose();
})().catch(error=>{console.error(error);process.exitCode=1});
