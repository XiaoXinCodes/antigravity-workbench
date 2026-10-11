const {spawn,execFileSync}=require('node:child_process');
let python;
const fixtureEnv=()=>Object.fromEntries(['PATH','SystemRoot','WINDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
function pythonCommand(){if(python)return python;for(const [name,prefix] of (process.platform==='win32'?[['py',['-3']],['python',[]],['python3',[]]]:[['python3',[]],['python',[]]])){try{execFileSync(name,[...prefix,'-I','-c','import sqlite3,sys;assert sys.version_info.major==3'],{env:fixtureEnv(),stdio:'ignore',timeout:3000,windowsHide:true});return python=[name,prefix]}catch{/* Test fixtures can use any existing Python 3. */}}throw Error('SYNTHETIC_FIXTURE_PYTHON3_REQUIRED')}
const runPython=args=>{const [name,prefix]=pythonCommand();return execFileSync(name,[...prefix,...args],{env:fixtureEnv(),windowsHide:true})};
const vi=value=>{let n=BigInt(value),out=[];do{const b=Number(n&127n);n>>=7n;out.push(b|(n?128:0))}while(n);return Buffer.from(out)};
const num=(field,value)=>Buffer.concat([vi(field<<3),vi(value)]);
const buf=(field,value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([vi((field<<3)|2),vi(b.length),b])};
const generation=({models=['synthetic-return-a'],usage={1:3,2:7,3:9,5:20,9:5,10:4},id='synthetic-response-a',label='Synthetic display label'}={})=>buf(1,Buffer.concat([...models.map(model=>buf(19,model)),buf(21,label),buf(4,Buffer.concat([...Object.entries(usage).map(([field,n])=>num(Number(field),n)),...(id?[buf(11,id)]:[])]))]));
const timestamp=value=>{const seconds=Math.floor(value/1000);return Buffer.concat([num(1,BigInt.asUintN(64,BigInt(seconds))),num(2,(value-seconds*1000)*1000000)])};
const stepMetadata=({id='synthetic-response-a',createdAt}={})=>Buffer.concat([...(createdAt===undefined?[]:[buf(1,timestamp(createdAt))]),buf(9,buf(11,id))]);
const workspaceMetadata=uris=>Buffer.concat(uris.map(uri=>buf(1,buf(1,uri))));
const SCRIPT=`import sys,sqlite3,base64,json
p,mode,rows,page,extra=sys.argv[1:];extra=json.loads(extra);c=sqlite3.connect(p);c.execute('PRAGMA page_size='+page);c.execute('PRAGMA journal_mode='+('WAL' if mode=='wal' else 'DELETE'));c.execute('PRAGMA wal_autocheckpoint=0');c.execute('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB)');c.execute('CREATE TABLE prompts(text TEXT)');c.execute("INSERT INTO prompts VALUES('SYNTHETIC_PROMPT_MUST_NOT_BE_DECODED')");c.commit()
for i,b in enumerate(json.loads(rows)):c.execute('INSERT INTO gen_metadata VALUES(?,?)',(i,base64.b64decode(b)))
if 'steps' in extra:
 c.execute('CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB,payload BLOB)')
 for i,b in enumerate(extra['steps']):c.execute('INSERT INTO steps VALUES(?,?,?)',(i,base64.b64decode(b),b'SYNTHETIC_STEP_PAYLOAD_MUST_NOT_BE_DECODED'))
if 'workspace' in extra:
 c.execute('CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY,data BLOB)');c.execute('INSERT INTO trajectory_metadata_blob VALUES(?,?)',('main',base64.b64decode(extra['workspace'])))
c.commit()
if mode=='journal':c.execute('INSERT INTO gen_metadata VALUES(999,?)',(b'pending',))
print('ready',flush=True)
for line in sys.stdin:
 if line.strip()=='close':break
 if line.strip()=='add':c.execute('INSERT INTO gen_metadata SELECT max(idx)+1,data FROM gen_metadata');c.commit();print('added',flush=True)
 if line.strip()=='pending':c.execute('PRAGMA cache_size=5');c.execute('BEGIN');c.execute('INSERT INTO gen_metadata SELECT max(idx)+1,data FROM gen_metadata');c.execute('INSERT INTO prompts VALUES(?)',('SYNTHETIC_PENDING_'+'x'*1048576,));print('pending',flush=True)
 if line.strip()=='rollback':c.rollback();print('rolledback',flush=True)
 if line.strip()=='commit':c.commit();print('committed',flush=True)
 if line.strip()=='truncate':c.execute('PRAGMA wal_checkpoint(TRUNCATE)');print('truncated',flush=True)
 if line.strip()=='restart':c.execute('PRAGMA wal_checkpoint(RESTART)');print('restarted',flush=True)
c.close()
`;
async function database(file,rows=[generation()],mode='wal',pageSize=4096,metadata={}) {
 const extra={...(metadata.steps?{steps:metadata.steps.map(x=>x.toString('base64'))}:{}),...(metadata.workspace?{workspace:metadata.workspace.toString('base64')}:{})};
 const [name,prefix]=pythonCommand(),child=spawn(name,[...prefix,'-I','-c',SCRIPT,file,mode,JSON.stringify(rows.map(x=>x.toString('base64'))),String(pageSize),JSON.stringify(extra)],{env:fixtureEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error(error))})});
 const command=name=>new Promise((resolve,reject)=>{child.stdout.once('data',resolve);if(child.exitCode!==null)reject(Error('FIXTURE_CLOSED'));else child.stdin.write(name+'\n')});
 return{add:()=>command('add'),command,close:()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('close\n')})};
}
module.exports={vi,num,buf,generation,timestamp,stepMetadata,workspaceMetadata,database,runPython};
