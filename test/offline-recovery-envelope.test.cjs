const test=require('node:test'),assert=require('node:assert/strict');
const {encryptOfflineRecovery,decryptOfflineRecovery}=require('../out/offline-recovery-envelope');
const token=JSON.stringify({token:{refresh_token:'synthetic-private-token'}});
const record={schema:1,hostId:'synthetic-host',id:'18b6b550-6e0d-4b57-b5be-9d70810f07a9',phase:'prepared',backup:{keyring:null,file:null},target:{keyring:token,file:token},expectedEmail:'synthetic@example.test'};
const password='synthetic recovery password';
test('password-encrypted record recovers exact slots without a VS Code vault',async()=>{
 const bytes=await encryptOfflineRecovery(record,password);
 assert.ok(!bytes.includes(Buffer.from('synthetic-private-token')));
 assert.ok(!bytes.includes(Buffer.from(record.expectedEmail)));
 assert.deepEqual(await decryptOfflineRecovery(bytes,password,record.hostId,record.id),record);
});
test('wrong password, host or transaction cannot authorize recovery',async()=>{
 const bytes=await encryptOfflineRecovery(record,password);
 await assert.rejects(decryptOfflineRecovery(bytes,'wrong password',record.hostId,record.id),/OFFLINE_RECOVERY_DECRYPT_FAILED/);
 await assert.rejects(decryptOfflineRecovery(bytes,password,'different-host',record.id),/OFFLINE_RECOVERY_INVALID/);
 await assert.rejects(decryptOfflineRecovery(bytes,password,record.hostId,'different-tx'),/OFFLINE_RECOVERY_INVALID/);
});
test('tampered ciphertext and unexpected envelope fields reject',async()=>{
 const bytes=await encryptOfflineRecovery(record,password),e=JSON.parse(bytes);
 const b=Buffer.from(e.ciphertext,'base64');b[0]^=1;
 await assert.rejects(decryptOfflineRecovery(Buffer.from(JSON.stringify({...e,ciphertext:b.toString('base64')})),password,record.hostId,record.id),/OFFLINE_RECOVERY_DECRYPT_FAILED/);
 await assert.rejects(decryptOfflineRecovery(Buffer.from(JSON.stringify({...e,plaintext:'injected'})),password,record.hostId,record.id),/OFFLINE_RECOVERY_ENVELOPE_INVALID/);
});
test('short passwords and invalid journals fail before encryption',async()=>{
 await assert.rejects(encryptOfflineRecovery(record,'short'),/OFFLINE_RECOVERY_PASSWORD_INVALID/);
 await assert.rejects(encryptOfflineRecovery({...record,phase:'bogus'},password),/OFFLINE_RECOVERY_INVALID/);
});
test('duplicate keys and oversized records reject before KDF',async()=>{
 await assert.rejects(decryptOfflineRecovery(Buffer.from('{"version":1,"version":1}'),password,record.hostId,record.id),/OFFLINE_RECOVERY_ENVELOPE_INVALID/);
 await assert.rejects(decryptOfflineRecovery(Buffer.alloc(4*1024*1024),password,record.hostId,record.id),/OFFLINE_RECOVERY_ENVELOPE_INVALID/);
});
