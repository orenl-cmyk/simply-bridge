import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {scryptSync,createDecipheriv} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const work=path.resolve(root,'../..','work');
await mkdir(work,{recursive:true});
const data=await mkdtemp(path.join(work,'vault-test-'));
const port=4329,origin=`http://127.0.0.1:${port}`;
let child,cookie='';
async function launch(){child=spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main',path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),DATA_DIR:data},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited: ${code}`));});});}
async function stop(){if(child&&!child.killed){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}}
async function call(route,body,extra={}){const r=await fetch(origin+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),Cookie:cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
test('encrypted connection lifecycle, authorization, persistence and secret retention',async()=>{
 await launch();
 try{
 assert.equal((await call('connections')).status,401);
 assert.equal((await call('setup',{password:'short'})).status,400);
 const password='Testing-only-password-123';
 assert.equal((await call('setup',{password},{Origin:'https://wrong.example'})).status,403);
 assert.equal((await call('setup',{password})).status,200);
 assert.ok(cookie.startsWith('ot_session_4329='));
 assert.equal((await call('connections',undefined,{Cookie:cookie.replace('ot_session_4329=','ot_session_4318=')})).status,401);
 assert.equal((await call('connections')).status,200);
 assert.equal((await call('setup',{password})).status,409);
 const connection={name:'בדיקת סביבה',baseUrl:'https://internal.example:8443/origami/',username:'test@example.invalid',secret:'TEST-SECRET-ONLY',note:'test',color:'teal'};
 assert.equal((await call('connections',{...connection,baseUrl:'javascript:alert(1)'})).status,400);
 const saved=await call('connections',connection);assert.equal(saved.status,200);
 assert.equal(saved.data.connections[0].baseUrl,'https://internal.example:8443/origami');
 assert.equal('secret' in saved.data.connections[0],false);
 const id=saved.data.connections[0].id;
 assert.equal((await call('select',{id})).data.activeId,id);
 const edited=await call('connections',{...connection,id,name:'עודכן',secret:''});assert.equal(edited.status,200);
 const raw=await readFile(path.join(data,'connections.vault.json'),'utf8');
 for(const needle of [connection.secret,connection.username,'internal.example','עודכן'])assert.equal(raw.includes(needle),false);
 const encrypted=JSON.parse(raw),key=scryptSync(password,Buffer.from(encrypted.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(encrypted.iv,'base64'));decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
 const plain=JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]).toString());
 assert.equal(plain.connections[0].secret,connection.secret);
 assert.equal((await call('lock',{})).status,200);
 assert.equal((await call('connections')).status,401);
 assert.equal((await call('unlock',{password:'incorrect'})).status,401);
 assert.equal((await call('unlock',{password})).data.connections[0].name,'עודכן');
 await stop();await launch();
 assert.equal((await call('connections')).status,401);
 const restored=await call('unlock',{password});assert.equal(restored.data.activeId,id);assert.equal(restored.data.connections.length,1);
 const removed=await call('delete',{id});assert.equal(removed.data.connections.length,0);assert.equal(removed.data.activeId,null);
 assert.equal((await call('select',{id})).status,404);
 await call('lock',{});
 for(let i=0;i<5;i++)assert.equal((await call('unlock',{password:'bad'})).status,401);
 assert.equal((await call('unlock',{password})).status,429);
 }finally{await stop();}
});
