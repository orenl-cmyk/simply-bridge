import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {writeSimply,executeRow} from '../run.mjs';
test('write transport never retries unknown outcomes, 429 or validation; redacts secrets and requires explicit success',async()=>{
 let count=0,mode='validation',debug;const server=http.createServer(async(req,res)=>{count++;for await(const x of req){}if(mode==='validation')res.end(JSON.stringify({error:{type:'validation',message:'secret-unique',column:[{field_data_name:'title',message:'bad'}]}}));else if(mode==='429'){res.writeHead(429);res.end('{}');}else if(mode==='missing-id')res.end('{"success":"ok","results":{}}');else if(mode==='multi-update')res.end('{"success":"ok","results":{"instances_updated":2}}');else res.end('not json');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const c={baseUrl:`http://127.0.0.1:${server.address().port}`,username:'test-user',secret:'secret-unique'};
 try{for(const [m,kind] of [['validation','validation'],['429','stopped'],['missing-id','unknown'],['multi-update','unknown'],['garbled','unknown']]){mode=m;const before=count;await assert.rejects(writeSimply(c,m==='multi-update'?'update_instance_fields':'create_instance',{entity_data_name:'demo',filter:[['_id','=','id']]},d=>debug=d),e=>e.kind===kind&&!JSON.stringify(e.details).includes('secret-unique'));assert.equal(count,before+1);assert.equal(JSON.stringify(debug).includes('secret-unique'),false);}}
 finally{await new Promise(r=>server.close(r));}
});
test('blocked or changed plans never write; failed journal intent prevents writing',async()=>{
 const p={sourceId:'a',matchKey:'a',action:'create',status:'planned',request:{body:{form_data:[]}}};let writes=0;const args={planned:p,recheck:async()=>p,write:async()=>{writes++;return {targetId:'new'};},recordIntent:async()=>{},recordResult:async()=>{}};
 const changed=await executeRow({...args,recheck:async()=>({...p,action:'update'})});assert.equal(changed.status,'changed');assert.equal(changed.stop,true);
 const blocked=await executeRow({...args,planned:{...p,status:'blocked'}});assert.equal(blocked.status,'blocked');assert.equal(blocked.stop,false);
 await assert.rejects(executeRow({...args,recordIntent:async()=>{throw Error('disk unavailable');}}));assert.equal(writes,0);
});
