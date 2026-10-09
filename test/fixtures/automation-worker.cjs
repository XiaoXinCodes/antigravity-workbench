// Independent process simulates a second extension host sharing the durable store.
const fs=require('node:fs/promises'),path=require('node:path');
const {PrivateState}=require('../../out/private-state'),{parseWakeState,initialWakeState}=require('../../out/wake-state'),{WakeEngine}=require('../../out/wake-engine');
(async()=>{
 const directory=process.argv[2],now=Number(process.argv[3]),store=new PrivateState(directory,parseWakeState,initialWakeState);
 const engine=new WakeEngine(store,{fingerprint:()=> 'synthetic-bound-A',run:async(_task,_signal,before)=>{await before();await fs.appendFile(path.join(directory,'synthetic-sends.txt'),String(process.pid)+'\n');await new Promise(r=>setTimeout(r,150));return{phase:'succeeded',code:'WAKE_COMPLETE'}}},()=>{},()=>now);
 for(let n=0;n<8;n++){try{await engine.tick()}catch(error){if(!/LOCKED/.test(error.message))throw error}await new Promise(r=>setTimeout(r,25))}engine.dispose();
})().catch(error=>{console.error(error);process.exitCode=1});
