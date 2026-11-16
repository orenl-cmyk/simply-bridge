import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {postJson} from '../transport.mjs';

test('Simply transport forces IPv4 even when the destination hostname could also resolve to IPv6',async()=>{
 const received=[];
 const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{received.push(JSON.parse(body));response.setHeader('Content-Type','application/json');response.end('{"success":"ok"}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let lookupOptions;
 const lookup=(hostname,options,callback)=>{lookupOptions=options;callback(null,'127.0.0.1',4);};
 try{
  const response=await postJson(`http://simply-dual-stack.invalid:${server.address().port}/entities/api/entities_list/format/json`,{ping:true},{lookup});
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(await response.text()),{success:'ok'});
  assert.equal(lookupOptions.family,4);
  assert.deepEqual(received,[{ping:true}]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
