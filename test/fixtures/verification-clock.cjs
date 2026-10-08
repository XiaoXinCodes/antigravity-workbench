const settle = async () => { for (let i=0;i<6;i++) await new Promise(setImmediate); };
function verificationClock() {
 let value=0;const timers=new Set();
 return {timers,now:()=>value,set:(callback,delay)=>{const timer={callback,at:value+delay};timers.add(timer);return timer;},clear:timer=>timers.delete(timer),
  jump:ms=>{value+=ms;},advance:async ms=>{const target=value+ms;let iterations=0;
   while(true){const next=[...timers].filter(t=>t.at<=target).sort((a,b)=>a.at-b.at)[0];if(!next)break;
    if(++iterations>1000)throw Error('unbounded synthetic timers');value=next.at;timers.delete(next);next.callback();await settle();}
   value=target;await settle();}};
}
module.exports={verificationClock,settle};
