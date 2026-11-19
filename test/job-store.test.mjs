import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {saveDurableJob,saveDurablePlan,saveDurablePayload,appendDurableEvent,loadDurableState} from '../job-store.mjs';

const work=path.resolve('work');await mkdir(work,{recursive:true});
test('encrypted jobs, plans, inputs and append-only progress survive a fresh load',async()=>{
 const directory=await mkdtemp(path.join(work,'durable-test-')),key=randomBytes(32),secret='SHOULD-NOT-APPEAR-IN-FILES';
 await saveDurableJob(directory,key,'job-1',{state:'running',label:secret,workerActive:true});
 await saveDurablePlan(directory,key,'plan-1',{ownerId:'u1',result:{rows:[{sourceId:'1'}]}});
 await saveDurablePayload(directory,key,'input-job-1',{batches:[{records:[1,2,3]}]});
 await appendDurableEvent(directory,key,'job-1',{type:'progress',key:'plan-1:0',status:'succeeded'});
 await appendDurableEvent(directory,key,'job-1',{type:'pause',kind:'rate_limit'});
 const loaded=await loadDurableState(directory,key);
 assert.equal(loaded.jobs.get('job-1').state,'running');assert.equal(loaded.jobs.get('job-1').workerActive,undefined);assert.equal(loaded.plans.get('plan-1').ownerId,'u1');assert.equal(loaded.payloads.get('input-job-1').batches[0].records.length,3);assert.equal(loaded.events.get('job-1').length,2);
 const raw=(await readFile(path.join(directory,'jobs-v1','jobs','job-1.json'),'utf8'))+(await readFile(path.join(directory,'jobs-v1','events','job-1.ndjson'),'utf8'));assert.equal(raw.includes(secret),false);
});
