import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createCipheriv} from 'node:crypto';
import {saveWriteIntent,finishWriteIntent,saveDurableJob,saveDurablePlan,saveDurablePayload,appendDurableEvent,loadDurableState} from '../job-store.mjs';

const work=path.resolve('/work');await mkdir(work,{recursive:true});
function seal(value,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
 }

test('encrypted jobs, plans, inputs and append-only progress survive a fresh load',async()=>{
 const directory=await mkdtemp(path.join(work,'durable-test-')),key=randomBytes(32),secret='SHOULD-NOT-APPEAR-IN-FILES';
 await saveDurableJob(directory,key,'job-1',{state:'running',label:secret,workerActive:true});
 await saveDurablePlan(directory,key,'plan-1',{ownerId:'u1',result:{rows:[{sourceId:'1'}]}});
 await saveDurablePayload(directory,key,'input-job-1',{batches:[{records:[1,2,3]}]});
 await appendDurableEvent(directory,key,'job-1',{type:'progress',key:'plan-1:0',status:'succeeded'});
 await appendDurableEvent(directory,key,'job-1',{type:'pause',kind:'rate_limit'});
 const loaded=await loadDurableState(directory,key);
 assert.equal(loaded.jobs.get('job-1').state,'running');assert.equal(loaded.jobs.get('job-1').workerActive,undefined);assert.equal(loaded.plans.get('plan-1').ownerId,'u1');assert.equal(loaded.payloads.get('input-job-1').batches[0].records.length,3);assert.equal(loaded.events.get('job-1').length,2);
 for(const suffix of ['', '-wal', '-shm']){
  try{
   const raw=await readFile(path.join(directory,'jobs-v2','work.sqlite'+suffix));
   assert.equal(raw.includes(secret),false);
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
});

test('legacy encrypted checkpoints are imported once and cannot resurrect deleted jobs',async()=>{
 const directory=await mkdtemp(path.join(work,'migration-test-')),key=randomBytes(32);
 const root=path.join(directory,'jobs-v1');
 await mkdir(path.join(root,'jobs'),{recursive:true});
 await mkdir(path.join(root,'events'),{recursive:true});

 await writeFile(path.join(root,'jobs','job-1.json'),seal({state:'running'},key));
 await writeFile(path.join(root,'events','job-1.ndjson'),seal({type:'outcome',value:{status:'pending'}},key)+'\n{');
 const state=await loadDurableState(directory,key);
 assert.equal(state.jobs.get('job-1').state,'running');
 assert.equal(state.events.get('job-1')[0].value.status,'pending');
 const {deleteDurableJob}=await import('../job-store.mjs');
 await deleteDurableJob(directory,'job-1');
 const after=await loadDurableState(directory,key);
 assert.equal(after.jobs.has('job-1'),false);
 assert.equal(after.events.has('job-1'),false);
});

test('failed completion leaves the uncertain write intact and rolls back progress',async()=>{
 const directory=await mkdtemp(path.join(work,'transaction-test-')),key=randomBytes(32);
 await saveWriteIntent(directory,key,'job-1','row-1',{status:'pending',key:'private-match-key'});
 await assert.rejects(finishWriteIntent(directory,key,'job-1','row-1',{status:'succeeded'},{invalid:1n}),TypeError);
 let state=await loadDurableState(directory,key);
 assert.deepEqual(state.events.get('job-1').map(event=>event.value?.status),['pending']);
 await finishWriteIntent(directory,key,'job-1','row-1',{status:'succeeded',targetId:'new-id'},{type:'progress',key:'row-1',status:'succeeded'});
 state=await loadDurableState(directory,key);
 assert.deepEqual(state.events.get('job-1').map(event=>event.type),['outcome','progress']);
 assert.equal(state.events.get('job-1')[0].value.targetId,'new-id');
 for(const suffix of ['', '-wal', '-shm']){
  try{
   const raw=await readFile(path.join(directory,'jobs-v2','work.sqlite'+suffix));
   assert.equal(raw.includes('private-match-key'),false);
   assert.equal(raw.includes('new-id'),false);
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
});

test('rerunning an interrupted migration skips committed journal rows',async()=>{
 const directory=await mkdtemp(path.join(work,'migration-resume-test-')),key=randomBytes(32);
 const events=path.join(directory,'jobs-v1','events');
 await mkdir(events,{recursive:true});
 const journal=path.join(events,'job-1.ndjson');
 const lines=Array.from({length:300},(_,index)=>seal({type:'progress',index},key));
 const interrupted=[...lines];
 interrupted[275]='invalid middle line';
 await writeFile(journal,interrupted.join('\n')+'\n');
 await assert.rejects(loadDurableState(directory,key),SyntaxError);
 await writeFile(journal,lines.join('\n')+'\n');
 const state=await loadDurableState(directory,key);
 assert.deepEqual(state.events.get('job-1').map(event=>event.index),lines.map((_,index)=>index));
});
