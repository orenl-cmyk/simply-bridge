import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createLimiter} from '../rate-limit.mjs';
import {readOrigami} from '../origami.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const schema={instance_data:{field_groups:[{field_group_data:{group_data_name:'main'},fields_data:[[{field_data_name:'title'},{field_data_name:'external_id'}]]},{field_group_data:{group_data_name:'rows',repeatable_group:'1'},fields_data:[[{field_data_name:'note'}]]}]}};
test('global limiter keeps simultaneous callers below 10 starts per second and limits concurrency',async()=>{
 const limiter=createLimiter(),starts=[];let active=0,max=0;
 await Promise.all(Array.from({length:16},()=>limiter.run(async()=>{starts.push(performance.now());active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,350));active--;})));
 for(const t of starts)assert.ok(starts.filter(x=>x>=t&&x<t+1000).length<=7);
 assert.ok(max<=3);assert.equal(starts.length,16);
});
test('429 retries with shared cooldown and records retry history',async()=>{
 let calls=0,first=0,debug;const server=http.createServer((req,res)=>{calls++;if(calls===1){first=Date.now();res.writeHead(429,{'Retry-After':'1'});res.end('{"error":"rate limited"}');}else{assert.ok(Date.now()-first>=990);res.end('[]');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const r=await readOrigami({baseUrl:`http://127.0.0.1:${server.address().port}`,username:'demo',secret:'demo-secret'},'entities_list',{},d=>debug=d);assert.deepEqual(r,[]);assert.equal(calls,2);assert.equal(debug.outcome,'success');assert.equal(debug.attempts[0].status,429);}finally{await new Promise(r=>server.close(r));}
});
test('presets persist encrypted, validate against live schema, remain scoped per connection and survive restart',async()=>{
 const mock=http.createServer(async(req,res)=>{for await(const c of req){}res.setHeader('Content-Type','application/json');res.end(req.url.includes('entities_list')?JSON.stringify([{entity_data_name:'origami_users'},{entity_data_name:'origami_groups'},{entity_data_name:'issues',entity_name:'תקלות'}]):JSON.stringify(schema));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const work=path.resolve(root,'../..','work');await mkdir(work,{recursive:true});const data=await mkdtemp(path.join(work,'preset-test-'));
 const port=4339,origin=`http://127.0.0.1:${port}`;let child,cookie='';
 const launch=async()=>{child=spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main',path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),DATA_DIR:data},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((r,j)=>{child.stdout.once('data',r);child.once('error',j);child.once('exit',()=>j(new Error('server exited')));});};
 const stop=async()=>{if(child&&!child.killed){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}};
 const call=async(route,body)=>{const r=await fetch(origin+'/api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,...await r.json()};};
 try{
 await launch();assert.equal((await call('presets/list',{connectionId:'none'})).status,401);
 await call('setup',{password:'Test-only-password-123'});
 const conn={name:'source-one',baseUrl:`http://127.0.0.1:${mock.address().port}`,username:'demo',secret:'demo-secret'};
 const c=(await call('connections',conn)).connections[0].id;await call('select',{id:c});
 const list=await call('schema/list',{connectionId:c});assert.equal(list.entities.length,1);assert.equal(list.skipped.length,2);
 assert.equal((await call('schema/structure',{connectionId:c,entityId:'origami_users'})).status,400);
 const draft={connectionId:c,name:'Black preset',makeDefault:true,entities:[{entityId:'issues',fields:[{groupId:'main',fieldId:'title'},{groupId:'main',fieldId:'external_id'}],key:{kind:'field',groupId:'main',fieldId:'external_id'}}]};
 assert.equal((await call('presets/save',draft)).status,400);
 await call('schema/structure',{connectionId:c,entityId:'issues'});
 const saved=await call('presets/save',draft);assert.equal(saved.status,200);const id=saved.presets[0].id;assert.equal(saved.defaultId,id);
 const bad=structuredClone(draft);bad.entities[0].fields=[{groupId:'main',fieldId:'missing'}];assert.equal((await call('presets/save',bad)).status,400);
 const repeating=structuredClone(draft);repeating.entities[0].key={kind:'field',groupId:'rows',fieldId:'note'};assert.equal((await call('presets/save',repeating)).status,400);
 const r=await call('presets/save',{...draft,id,name:'Edited preset',makeDefault:false});assert.equal(r.presets.length,1);assert.equal(r.defaultId,null);
 await call('presets/default',{connectionId:c,id});
 const c2=(await call('connections',{...conn,name:'source-two'})).connections.find(x=>x.id!==c).id;await call('select',{id:c2});
 assert.equal((await call('presets/list',{connectionId:c2})).presets.length,0);
 assert.equal((await call('presets/delete',{connectionId:c2,id})).status,404);
 assert.equal((await call('presets/list',{connectionId:c})).status,409);
 assert.equal((await readFile(path.join(data,'connections.vault.json'),'utf8')).includes('Edited preset'),false);
 await stop();await launch();await call('unlock',{password:'Test-only-password-123'});await call('select',{id:c});
 const restored=await call('presets/list',{connectionId:c});assert.equal(restored.presets[0].name,'Edited preset');assert.equal(restored.defaultId,id);assert.deepEqual(restored.presets[0].entities,draft.entities);
 await call('presets/delete',{connectionId:c,id});assert.equal((await call('presets/list',{connectionId:c})).presets.length,0);
 }finally{await stop();await new Promise(r=>mock.close(r));}
});
