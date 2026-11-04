import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readOrigami,normalizeEntities,normalizeStructure} from '../origami.mjs';
test('exclude users and user groups by identity anywhere in the list, before validating data names',()=>{
 const skipped=[];
 const list=normalizeEntities([{entity_data_name:'issues',entity_name:'תקלות'},{entity_name:'קבוצות משתמשים'},{entity_data_name:'buildings',entity_name:'מבנים'},{entity_data_name:'users',entity_name:'System users'},{entity_data_name:'user_groups'},{entity_data_name:'work_groups',entity_name:'קבוצות עבודה'}],e=>skipped.push(e));
 assert.equal(skipped.length,3);assert.deepEqual(new Set(list.map(e=>e.id)),new Set(['issues','buildings','work_groups']));
});
test('debug reports preserve network causes and redact credentials in reflected responses',async()=>{
 const secret='TEST-SECRET-12345',username='private@example.invalid';let debug;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'failed '+secret+' '+username,api_secret:secret,Authorization:'Bearer hidden-token',nested:{password:'also-hidden'}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port,c={baseUrl:`http://127.0.0.1:${port}`,username,secret};
 try{await assert.rejects(readOrigami(c,'entities_list',{},d=>debug=d));assert.equal(debug.response.status,200);assert.equal(debug.failureStage,'api-result');assert.equal(debug.request.method,'POST');assert.equal(debug.request.body.api_secret,'[REDACTED]');const report=JSON.stringify(debug);for(const s of [secret,username,'hidden-token','also-hidden'])assert.equal(report.includes(s),false);assert.ok(report.includes('[REDACTED]'));}finally{await new Promise(r=>server.close(r));}
 await assert.rejects(readOrigami(c,'entities_list',{},d=>debug=d));assert.equal(debug.response,null);assert.equal(debug.failureStage,'connect');assert.ok(JSON.stringify(debug.error).includes('ECONNREFUSED'));assert.ok(debug.durationMs>=0);
});
test('list and nested schema normalization preserves empty repeating groups',()=>{
 assert.deepEqual(normalizeEntities({entities:{data:[{entity_data_name:'a',entity_name:'A'},{entity_data_name:'a'}]}}),[{id:'a',name:'A'}]);
 assert.deepEqual(normalizeEntities([]),[]);
 assert.throws(()=>normalizeEntities({info:'unexpected'}));
 const r=normalizeStructure({instance_data:{field_groups:[{field_group_data:{group_data_name:'g1',group_name:'G'},fields_data:[[{field_data_name:'f1',field_name:'F',field_type_name:'input-text',custom_validation:{writable:'0'}}]]},{field_group_data:{group_data_name:'g2',repeatable_group:'1'}}]}});
 assert.equal(r.groups.length,2);assert.equal(r.fieldCount,1);assert.equal(r.groups[0].fields[0].readonly,true);assert.equal(r.groups[1].repeatable,true);assert.equal(r.groups[1].fields.length,0);
 assert.throws(()=>normalizeStructure({message:'not a schema'}));
});
test('read-only API respects full base path, credentials, API errors and no redirects',async()=>{
 const requests=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({url:req.url,body});res.setHeader('Content-Type','application/json');if(body.entity_data_name==='error')res.end(JSON.stringify({error:'secret upstream message'}));else if(body.entity_data_name==='redirect'){res.writeHead(302,{Location:'/other'});res.end('{}');}else if(body.entity_data_name==='bad'){res.end('not-json');}else res.end(JSON.stringify([{entity_data_name:'issues',entity_name:'Issues'}]));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const c={baseUrl:`http://127.0.0.1:${server.address().port}/custom/base`,username:'demo',secret:'test-only'};
 try{await readOrigami(c,'entities_list');assert.equal(requests[0].url,'/custom/base/entities/api/entities_list/format/json');assert.equal(requests[0].body.api_secret,c.secret);assert.equal(requests[0].body.username,c.username);
 await assert.rejects(readOrigami(c,'entity_structure',{entity_data_name:'error'}),e=>e.status===502&&!e.message.includes('secret upstream'));
 await assert.rejects(readOrigami(c,'entity_structure',{entity_data_name:'redirect'}));
 await assert.rejects(readOrigami(c,'entity_structure',{entity_data_name:'bad'}));
 await assert.rejects(readOrigami(c,'create_instance'));
 assert.equal(requests.length,4);
 }finally{await new Promise(r=>server.close(r));}
});
