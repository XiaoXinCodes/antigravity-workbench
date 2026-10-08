const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {decodePng,readPng}=require('../out/image-files');const {png}=require('./fixtures/png-fixture.cjs');
test('PNG decoder validates pixel stream, CRCs, filters and dimensions',()=>{
 for(const color of [0,2,4,6])for(const filter of [0,1,2,3,4])assert.equal(decodePng(png({color,filter})).width,2);
 assert.equal(decodePng(png({color:3,bits:1,value:0})).height,2);
 const b=png();b[40]^=1;assert.throws(()=>decodePng(b),/IMAGE_INVALID_PNG/);
 for(const data of [Buffer.from('png'),png().subarray(0,35),Buffer.concat([png(),Buffer.from('extra')]),png({filter:5}),png({width:8193}),png({interlace:1}),png({compressed:Buffer.from('broken')}),png({color:3,bits:8,value:5})])assert.throws(()=>decodePng(data),/IMAGE_INVALID_PNG/);
});
test('local PNG reads reject traversal, arbitrary extension, symlinks and hardlinks',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-file-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=await fs.realpath(dir),file=path.join(root,'ok.png');await fs.writeFile(file,png());assert.equal((await readPng(file,root)).info.height,2);
 await assert.rejects(readPng(file,path.join(root,'elsewhere')),/OUTSIDE/);await assert.rejects(readPng(path.join(root,'fake.txt')),/PNG_REQUIRED/);
 const hard=path.join(root,'hard.png');await fs.link(file,hard);await assert.rejects(readPng(hard,root),/UNSAFE/);await fs.unlink(hard);
 try{await fs.symlink(file,path.join(root,'alias.png'));await assert.rejects(readPng(path.join(root,'alias.png'),root),/UNSAFE/);}catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e;}
});
test('malformed parent spelling cannot loop forever while checking image ancestry',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-parent-bound-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'result.png');await fs.writeFile(file,png());
 await assert.rejects(readPng(file,root+path.sep),/IMAGE_PATH_OUTSIDE_OUTPUT/);
});
test('Windows URI lowercase drive and canonical uppercase root read the same image',{skip:process.platform!=='win32'},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-drive-case-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'result.png');await fs.writeFile(file,png());
 const lower=file.replace(/^[A-Z]:/i,value=>value.toLowerCase()),upper=root.replace(/^[a-z]:/i,value=>value.toUpperCase());assert.equal((await readPng(lower,upper)).info.width,2);
});
