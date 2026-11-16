import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {writeSimply,executeRow} from '../run.mjs';
test('write transport never retries unknown outcomes or validation, but adapts and retries definite 429 rejections',async()=>{
 let count=0,mode='validation',debug;const server=http.createServer(async(req,res)=>{count++;for await(const x of req){}if(mode==='validation')res.end(JSON.stringify({error:{type:'validation',message:'secret-unique',column:[{field_data_name:'title',message:'bad'}]}}));else if(mode==='429'){res.writeHead(429);res.end('{}');}else if(mode==='missing-id')res.end('{"success":"ok","results":{}}');else if(mode==='multi-update')res.end('{"success":"ok","results":{"instances_updated":2}}');else res.end('not json');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const c={baseUrl:`http://127.0.0.1:${server.address().port}`,username:'test-user',secret:'secret-unique'};
 try{for(const [m,kind,attempts] of [['validation','validation',1],['429','rate_limit',5],['missing-id','unknown',1],['multi-update','unknown',1],['garbled','unknown',1]]){mode=m;const before=count;await assert.rejects(writeSimply(c,m==='multi-update'?'update_instance_fields':'create_instance',{entity_data_name:'demo',filter:[['_id','=','id']]},d=>debug=d),e=>e.kind===kind&&!JSON.stringify(e.details).includes('secret-unique'));assert.equal(count,before+attempts);assert.equal(JSON.stringify(debug).includes('secret-unique'),false);}}
 finally{await new Promise(r=>server.close(r));}
});
test('RUN executes the frozen plan without re-running Dry Run; blocked rows never write and failed journal intent prevents writing',async()=>{
 const p={sourceId:'a',matchKey:'a',action:'create',status:'planned',request:{body:{form_data:[]}}};let writes=0,rechecks=0;const args={planned:p,recheck:async()=>{rechecks++;return {...p,action:'update'};},write:async()=>{writes++;return {targetId:'new'};},recordIntent:async()=>{},recordResult:async()=>{}};
 const frozen=await executeRow(args);assert.equal(frozen.status,'succeeded');assert.equal(rechecks,0);assert.equal(writes,1);
 const blocked=await executeRow({...args,planned:{...p,status:'blocked'}});assert.equal(blocked.status,'blocked');assert.equal(blocked.stop,false);
 writes=0;const journal=await executeRow({...args,recordIntent:async()=>{throw Error('disk unavailable');}});assert.equal(journal.status,'not_sent');assert.equal(journal.stop,false);assert.equal(writes,0);
});
test('a planned row executes update and repeat-row additions in order',async()=>{
 const steps=[{operation:'update_instance_fields',body:{field:[['a','b',0]]}},{operation:'add_group_repetition',body:{group_data:{a:'c'}}}],p={sourceId:'a',matchKey:'a',targetId:'target',action:'update',status:'planned',request:{operation:steps[0].operation,body:steps[0].body},requests:steps};const seen=[];
 const result=await executeRow({planned:p,recheck:async()=>structuredClone(p),write:async(row,step)=>{seen.push(step.operation);return {targetId:'target',response:{success:'ok'}};},recordIntent:async()=>{},recordResult:async()=>{}});
 assert.equal(result.status,'succeeded');assert.deepEqual(seen,['update_instance_fields','add_group_repetition']);assert.equal(result.responses.length,2);
});
