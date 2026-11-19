import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyOrigamiResult} from '../origami-result.mjs';
import {executeRow} from '../run.mjs';

test('HTTP 200 max_api_calls is a rate limit and pauses a row without recording a permanent failure',async()=>{
 const classified=classifyOrigamiResult({status:200,responseOk:true,data:{error:{type:'max_api_calls',message:'Hourly quota reached'}}});
 assert.equal(classified.kind,'rate_limit');
 let recorded;
 const row=await executeRow({planned:{status:'planned',sourceId:'11',matchKey:'11',action:'create',request:{operation:'create_instance',body:{}}},write:async()=>{throw Object.assign(new Error('quota'),{kind:'rate_limit'});},recordIntent:async()=>{},recordResult:async value=>{recorded=value;}});
 assert.equal(row.status,'deferred');assert.equal(row.stop,true);assert.equal(row.sent,false);assert.equal(recorded.status,'deferred');
});

test('validation and authorization bodies remain distinct from hourly quota errors',()=>{
 assert.equal(classifyOrigamiResult({status:200,responseOk:true,data:{error:{type:'validation',message:'required'}}}).kind,'validation');
 assert.equal(classifyOrigamiResult({status:200,responseOk:true,data:{error:{type:'permission',message:'denied'}}}).kind,'authorization');
});
