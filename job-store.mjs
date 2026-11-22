import {mkdir,writeFile,readFile,rename,opendir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';

const validId=value=>{const id=String(value||'');if(!/^[A-Za-z0-9:_-]{1,160}$/.test(id))throw Error('Invalid durable object id');return id;};
const rootOf=directory=>path.join(directory,'jobs-v1');
const envelope=(value,key)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};};
const open=(value,key)=>{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8'));};
async function atomic(file,value,key){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(envelope(value,key)),{mode:0o600});await rename(temp,file);}
async function readEncrypted(file,key){return open(JSON.parse(await readFile(file,'utf8')),key);}
async function* files(folder,suffix){
 let handle;
 try{handle=await opendir(folder);}catch(error){if(error.code==='ENOENT')return;throw error;}
 for await(const entry of handle)if(entry.isFile()&&entry.name.endsWith(suffix))yield entry.name;
}

export async function saveRecoveryKey(directory,serviceKey,vaultKey){
 await atomic(path.join(rootOf(directory),'recovery.json'),{key:vaultKey.toString('base64')},serviceKey);
}

export async function loadRecoveryKey(directory,serviceKey){
 try{
  const value=await readEncrypted(path.join(rootOf(directory),'recovery.json'),serviceKey);
  const key=Buffer.from(value.key,'base64');
  if(key.length!==32)throw Error('Invalid recovery key');
  return key;
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

const stores=new Map();

function transaction(db,work){
 db.exec('BEGIN IMMEDIATE');
 try{
  const result=work();
  db.exec('COMMIT');
  return result;
 }catch(error){
  db.exec('ROLLBACK');
  throw error;
 }
}

async function migrate(db,directory,key){
 const root=rootOf(directory);
 const done=db.prepare('SELECT 1 FROM migration WHERE name=?');
 const checkpoint=db.prepare('INSERT OR IGNORE INTO migration VALUES (?)');
 const put=db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?,?)');
 const event=db.prepare('INSERT OR IGNORE INTO events(owner,sequence,payload) VALUES (?,?,?)');
 for(const kind of ['jobs','plans','payloads']){
  for await(const name of files(path.join(root,kind),'.json')){
   const id=validId(name.slice(0,-5)),marker=kind+'/'+id;
   if(done.get(marker))continue;
   const raw=await readFile(path.join(root,kind,name),'utf8');
   open(JSON.parse(raw),key);
   transaction(db,()=>{put.run(kind,id,raw);checkpoint.run(marker);});
  }
 }
 for await(const name of files(path.join(root,'events'),'.ndjson')){
  const id=validId(name.slice(0,-7)),marker='events/'+id;
  if(done.get(marker))continue;
  const source=createReadStream(path.join(root,'events',name));
  const lines=createInterface({input:source,crlfDelay:Infinity});
  let sequence=0,pending;
  const batch=[];
  const insert=line=>{
   open(JSON.parse(line),key);
   batch.push(line);
   if(batch.length===256)flush();
  };
  const flush=()=>{
   if(!batch.length)return;
   transaction(db,()=>{for(const line of batch)event.run(id,++sequence,line);});
   batch.length=0;
  };
  for await(const line of lines){
   if(!line.trim())continue;
   if(pending!==undefined)insert(pending);
   pending=line;
  }
  if(pending!==undefined){
   let parsed;
   try{parsed=JSON.parse(pending);}catch{}
   if(parsed)insert(pending);
  }
  flush();
  checkpoint.run(marker);
 }
 transaction(db,()=>checkpoint.run('complete'));
}

async function openStore(directory,key){
 const root=path.join(directory,'jobs-v2');
 await mkdir(root,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(root,'work.sqlite'));
 try{
  db.exec(`
   PRAGMA journal_mode=WAL;
   PRAGMA synchronous=FULL;
   PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS migration(name TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS objects(kind TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS events(owner TEXT,sequence INTEGER,payload TEXT NOT NULL,PRIMARY KEY(owner,sequence));
   CREATE TABLE IF NOT EXISTS relation_identities(owner TEXT, fingerprint BLOB, payload TEXT NOT NULL, PRIMARY KEY(owner,fingerprint));
   CREATE TABLE IF NOT EXISTS import_keys(owner TEXT, fingerprint BLOB, PRIMARY KEY(owner,fingerprint));
   CREATE TABLE IF NOT EXISTS plan_mapping_refs(plan TEXT PRIMARY KEY, mapping TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS plan_mapping_lookup ON plan_mapping_refs(mapping);
   CREATE TABLE IF NOT EXISTS plan_work(plan TEXT, position INTEGER, payload TEXT NOT NULL, PRIMARY KEY(plan,position));
   CREATE TABLE IF NOT EXISTS plan_links(plan TEXT, position INTEGER, payload TEXT NOT NULL, PRIMARY KEY(plan,position));
   CREATE TABLE IF NOT EXISTS intents(owner TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
  `);
  if(!db.prepare("SELECT 1 FROM migration WHERE name='complete'").get())await migrate(db,directory,key);
  return db;
 }catch(error){db.close();throw error;}
}

async function store(directory,key){
 const resolved=path.resolve(directory);
 if(!stores.has(resolved)){
  const opening=openStore(resolved,key).catch(error=>{stores.delete(resolved);throw error;});
  stores.set(resolved,opening);
 }
 return stores.get(resolved);
}

async function saveObject(directory,key,kind,id,value){
 const db=await store(directory,key);
 db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload')
  .run(kind,validId(id),JSON.stringify(envelope(value,key)));
}

export async function saveDurableJob(directory,key,id,job){
 const stored=structuredClone(job);
 delete stored.key;
 delete stored.members;
 delete stored.workerActive;
 delete stored.pipelineWorkerActive;
 delete stored.pendingRelationRepair;
 if(stored.type==='import_run')delete stored.debug;
 await saveObject(directory,key,'jobs',id,stored);
}
export async function saveDurablePlan(directory,key,id,plan){await saveObject(directory,key,'plans',id,plan);}
export async function saveSegmentedPlan(directory,key,id,header,work,links,mapping){
 const db=await store(directory,key),plan=validId(id);
 const putWork=db.prepare('INSERT INTO plan_work VALUES (?,?,?)');
 const putLink=db.prepare('INSERT INTO plan_links VALUES (?,?,?)');
 const mappingId=createHmac('sha256',key).update(JSON.stringify(mapping??[])).digest('hex');
 transaction(db,()=>{
  db.prepare("INSERT OR IGNORE INTO objects VALUES ('plan-mappings',?,?)")
   .run(mappingId,JSON.stringify(envelope(mapping??[],key)));
  db.prepare('INSERT INTO plan_mapping_refs VALUES (?,?)').run(plan,mappingId);
  db.prepare("INSERT INTO objects VALUES ('plans',?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload")
   .run(plan,JSON.stringify(envelope({...header,mappingId},key)));
  for(const [position,value] of work)putWork.run(plan,position,JSON.stringify(envelope(value,key)));
  for(const [position,value] of links)putLink.run(plan,position,JSON.stringify(envelope(value,key)));
 });
 return mappingId;
}
export async function loadPlanMapping(directory,key,id){
 const db=await store(directory,key);
 const result=db.prepare("SELECT payload FROM objects WHERE kind='plan-mappings' AND id=?").get(validId(id));
 return result?open(JSON.parse(result.payload),key):null;
}
export async function loadPlanWork(directory,key,planId,position){
 const db=await store(directory,key);
 const row=db.prepare('SELECT payload FROM plan_work WHERE plan=? AND position=?').get(validId(planId),position);
 return row?open(JSON.parse(row.payload),key):null;
}
export async function savePlanWork(directory,key,planId,position,value){
 const db=await store(directory,key);
 return db.prepare('UPDATE plan_work SET payload=? WHERE plan=? AND position=?')
  .run(JSON.stringify(envelope(value,key)),validId(planId),position).changes===1;
}
export async function loadPlanLinks(directory,key,planId){
 const db=await store(directory,key);
 const rows=db.prepare('SELECT position,payload FROM plan_links WHERE plan=? ORDER BY position'),plan=validId(planId);
 return function*(){
  for(const row of rows.iterate(plan))yield [row.position,open(JSON.parse(row.payload),key)];
 };
}
export async function finishPlanLink(directory,key,jobId,planId,position,event){
 const db=await store(directory,key);
 transaction(db,()=>{
  insertEvent(db,key,validId(jobId),event);
  if(!event.issues.length)db.prepare('DELETE FROM plan_links WHERE plan=? AND position=?').run(validId(planId),position);
 });
}

export async function saveDurablePayload(directory,key,id,payload){await saveObject(directory,key,'payloads',id,payload);}
export async function importIdentityIndex(directory,key,jobId){
 const db=await store(directory,key),owner=validId(jobId);
 const query=db.prepare('SELECT payload FROM relation_identities WHERE owner=? AND fingerprint=?');
 const save=db.prepare('INSERT INTO relation_identities VALUES (?,?,?) ON CONFLICT(owner,fingerprint) DO UPDATE SET payload=excluded.payload');
 const fingerprint=id=>createHmac('sha256',key).update(id).digest();
 return {
  get(id){
   const row=query.get(owner,fingerprint(id));
   return row?open(JSON.parse(row.payload),key):undefined;
  },
  save(values){
   transaction(db,()=>{for(const [id,value] of values)save.run(owner,fingerprint(id),JSON.stringify(envelope(value,key)));});
  }
 };
}
export async function clearImportIdentities(directory,key,jobId){
 const db=await store(directory,key);
 db.prepare('DELETE FROM relation_identities WHERE owner=?').run(validId(jobId));
}

export async function saveImportBatch(directory,key,inputId,index,batch){
 const db=await store(directory,key),owner=validId(inputId);
 const reserve=db.prepare('INSERT OR IGNORE INTO import_keys VALUES (?,?)');
 transaction(db,()=>{
  for(const record of batch.entity.records){
   const fields=[batch.targetId,batch.targetKey,String(record?.matchKey)];
   const fingerprint=createHmac('sha256',key).update(JSON.stringify(fields)).digest();
   if(!reserve.run(owner,fingerprint).changes){
    throw Object.assign(Error('יותר מרשומת מקור אחת מופנית לאותו מפתח יעד: '+fields[2]),{status:422});
   }
  }
  db.prepare('INSERT INTO objects VALUES (?,?,?)').run('import-batches',validId(owner+':'+index),JSON.stringify(envelope(batch,key)));
 });
}
export async function clearImportKeys(directory,key,inputId){
 const db=await store(directory,key);
 db.prepare('DELETE FROM import_keys WHERE owner=?').run(validId(inputId));
}
export async function loadImportBatch(directory,key,inputId,index){
 const db=await store(directory,key);
 const row=db.prepare("SELECT payload FROM objects WHERE kind='import-batches' AND id=?").get(validId(inputId+':'+index));
 return row?open(JSON.parse(row.payload),key):null;
}
export async function deleteImportBatch(directory,inputId,index){
 await remove(directory,'import-batches',inputId+':'+index);
}
export async function appendDurableEvent(directory,key,jobId,event){
 const db=await store(directory,key);
 insertEvent(db,key,validId(jobId),event);
}

function insertEvent(db,key,owner,event){
 db.prepare('INSERT INTO events SELECT ?,COALESCE(MAX(sequence),0)+1,? FROM events WHERE owner=?')
  .run(owner,JSON.stringify(envelope(event,key)),owner);
}

export async function saveWriteIntent(directory,key,jobId,rowId,value){
 const db=await store(directory,key);
 db.prepare('INSERT INTO intents VALUES (?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload')
  .run(validId(jobId),validId(rowId),JSON.stringify(envelope(value,key)));
}

export async function finishWriteIntent(directory,key,jobId,rowId,value,progress,work){
 const db=await store(directory,key),owner=validId(jobId),id=validId(rowId);
 transaction(db,()=>{
  insertEvent(db,key,owner,{type:'outcome',id,value});
  if(progress)insertEvent(db,key,owner,progress);
  db.prepare('DELETE FROM intents WHERE owner=? AND id=?').run(owner,id);
  if(value.status==='succeeded'&&work)db.prepare('DELETE FROM plan_work WHERE plan=? AND position=?').run(validId(work.planId),work.index);
 });
}

export async function readDurableState(directory,key){
 const db=await store(directory,key);
 const records=db.prepare('SELECT id,payload FROM objects WHERE kind=? ORDER BY id');
 const owners=db.prepare('SELECT owner FROM events UNION SELECT owner FROM intents');
 const events=db.prepare('SELECT payload FROM events WHERE owner=? ORDER BY sequence');
 const intents=db.prepare('SELECT id,payload FROM intents WHERE owner=? ORDER BY id');
 const decrypt=payload=>open(JSON.parse(payload),key);
 return {
  *objects(kind){
   for(const row of records.iterate(kind))yield [row.id,decrypt(row.payload)];
  },
  *eventOwners(){
   for(const row of owners.iterate())yield row.owner;
  },
  *events(owner){
   for(const row of events.iterate(owner))yield decrypt(row.payload);
   for(const row of intents.iterate(owner))yield {type:'outcome',id:row.id,value:decrypt(row.payload)};
  }
 };
}

export async function loadDurableState(directory,key){
 const reader=await readDurableState(directory,key);
 return {
  jobs:new Map(reader.objects('jobs')),
  plans:new Map(reader.objects('plans')),
  payloads:new Map(reader.objects('payloads')),
  events:new Map([...reader.eventOwners()].map(owner=>[owner,[...reader.events(owner)]]))
 };
}

async function remove(directory,kind,id){
 const opening=stores.get(path.resolve(directory));
 if(!opening)return;
 const db=await opening;
 transaction(db,()=>{
  db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind,validId(id));
  if(kind==='plans'){
   const mapping=db.prepare('SELECT mapping FROM plan_mapping_refs WHERE plan=?').get(id);
   db.prepare('DELETE FROM plan_mapping_refs WHERE plan=?').run(id);
   if(mapping&&!db.prepare('SELECT 1 FROM plan_mapping_refs WHERE mapping=? LIMIT 1').get(mapping.mapping)){
    db.prepare("DELETE FROM objects WHERE kind='plan-mappings' AND id=?").run(mapping.mapping);
   }
   db.prepare('DELETE FROM plan_work WHERE plan=?').run(id);
   db.prepare('DELETE FROM plan_links WHERE plan=?').run(id);
  }
  if(kind==='jobs'){
   db.prepare('DELETE FROM events WHERE owner=?').run(id);
   db.prepare('DELETE FROM intents WHERE owner=?').run(id);
   db.prepare('DELETE FROM relation_identities WHERE owner=?').run(id);
  }
 });
}
export async function deleteDurableJob(directory,id){await remove(directory,'jobs',id);}
export async function deleteDurablePlan(directory,id){await remove(directory,'plans',id);}
export async function deleteDurablePayload(directory,id){
 const opening=stores.get(path.resolve(directory));
 if(!opening)return;
 const db=await opening;
 const prefix=validId(id)+':';
 transaction(db,()=>{
  db.prepare("DELETE FROM objects WHERE kind='payloads' AND id=?").run(id);
  db.prepare('DELETE FROM import_keys WHERE owner=?').run(id);
  db.prepare("DELETE FROM objects WHERE kind='import-batches' AND id>=? AND id<?")
   .run(prefix,prefix.slice(0,-1)+';');
 });
}
