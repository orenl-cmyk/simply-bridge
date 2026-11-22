import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyOrigamiResult} from '../origami-result.mjs';
import {executeRow} from '../run.mjs';
import {rateState,rateSnapshot,restoreEnvironmentRate} from '../rate-limit.mjs';

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
 assert.equal(classifyOrigamiResult({status:200,responseOk:true,data:{error:{type:'query',message:'Invalid filter'}}}).kind,'api_error');
});

test('explicit uniqueness errors differ from an uncertain server response',()=>{
 assert.equal(classifyOrigamiResult({status:200,responseOk:true,data:{error:{type:'validation',code:'unique_violation'}}}).kind,'uniqueness');
 const server=classifyOrigamiResult({status:502,data:{error:{type:'validation'}}});
 assert.equal(server.kind,'system');
 assert.equal(server.definiteRejection,false);
});

test('connections targeting the same environment share the strictest observed quota',()=>{
 const baseUrl='https://shared.invalid/bridge';
 const first=rateState({id:'first',baseUrl,maxRequestsPerSecond:6,maxRequestsPerHour:300});
 const second=rateState({id:'second',baseUrl:baseUrl+'/',maxRequestsPerSecond:10,maxRequestsPerHour:500});
 const other=rateState({id:'other',baseUrl:'https://other.invalid/bridge'});
 assert.equal(first,second);
 assert.equal(second.effectiveRps,6);
 assert.equal(second.configuredHourly,300);
 assert.notEqual(first,other);
});

test('restart restores observed quota and backoff across connections to the environment',()=>{
 const baseUrl='https://recovered.invalid';
 const capturedAt=Date.now()-1000;
 restoreEnvironmentRate({id:'before',baseUrl,maxRequestsPerHour:10},{capturedAt,hourlyUsed:9,effectiveRps:2,pausedMs:5000});
 const snapshot=rateSnapshot({id:'after',baseUrl,maxRequestsPerHour:10});
 assert.equal(snapshot.hourlyUsed,9);
 assert.equal(snapshot.hourlyRemaining,1);
 assert.equal(snapshot.effectiveRps,2);
 assert.ok(snapshot.pausedMs>0);
});
