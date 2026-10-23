// Optional fixed-category diagnostics for system service exclusion; no environ,
// credential contents, RPC, writes, subprocesses, or signals.
const {inspectOfflineSystemServiceRole}=require('../out/offline-process-census');
const ids=process.argv.slice(2);
if(process.platform!=='linux'||!ids.length||ids.length>8||ids.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<1)){
 process.stderr.write('DIAGNOSTIC_PID_REQUIRED\n');process.exitCode=1;
}else void Promise.all(ids.map(async id=>({pid:Number(id),...await inspectOfflineSystemServiceRole(Number(id),process.getuid())}))).then(results=>process.stdout.write(JSON.stringify({readOnly:true,environmentRead:false,credentialContentsRead:false,results})+'\n')).catch(()=>{process.stderr.write('DIAGNOSTIC_UNAVAILABLE\n');process.exitCode=1;});
