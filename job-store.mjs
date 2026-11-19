import {mkdir,writeFile,readFile,rename,readdir,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';

const validId=value=>{const id=String(value||'');if(!/^[A-Za-z0-9:_-]{1,160}$/.test(id))throw Error('Invalid durable object id');return id;};
const rootOf=directory=>path.join(directory,'jobs-v1');
const envelope=(value,key)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};};
const open=(value,key)=>{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8'));};
async function atomic(file,value,key){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(envelope(value,key)),{mode:0o600});await rename(temp,file);}
async function readEncrypted(file,key){return open(JSON.parse(await readFile(file,'utf8')),key);}
async function files(folder,suffix){try{return (await readdir(folder)).filter(name=>name.endsWith(suffix));}catch(error){if(error.code==='ENOENT')return [];throw error;}}

export async function saveDurableJob(directory,key,id,job){id=validId(id);const stored=structuredClone(job);delete stored.key;delete stored.members;delete stored.workerActive;delete stored.pipelineWorkerActive;await atomic(path.join(rootOf(directory),'jobs',id+'.json'),stored,key);}
export async function saveDurablePlan(directory,key,id,plan){id=validId(id);await atomic(path.join(rootOf(directory),'plans',id+'.json'),plan,key);}
export async function saveDurablePayload(directory,key,id,payload){id=validId(id);await atomic(path.join(rootOf(directory),'payloads',id+'.json'),payload,key);}
export async function appendDurableEvent(directory,key,jobId,event){jobId=validId(jobId);const file=path.join(rootOf(directory),'events',jobId+'.ndjson');await mkdir(path.dirname(file),{recursive:true});await appendFile(file,JSON.stringify(envelope(event,key))+'\n',{encoding:'utf8',mode:0o600});}

export async function loadDurableState(directory,key){
 const root=rootOf(directory),jobs=new Map(),plans=new Map(),payloads=new Map(),events=new Map();
 for(const name of await files(path.join(root,'jobs'),'.json')){const id=name.slice(0,-5);jobs.set(id,await readEncrypted(path.join(root,'jobs',name),key));}
 for(const name of await files(path.join(root,'plans'),'.json')){const id=name.slice(0,-5);plans.set(id,await readEncrypted(path.join(root,'plans',name),key));}
 for(const name of await files(path.join(root,'payloads'),'.json')){const id=name.slice(0,-5);payloads.set(id,await readEncrypted(path.join(root,'payloads',name),key));}
 for(const name of await files(path.join(root,'events'),'.ndjson')){const id=name.slice(0,-7),text=await readFile(path.join(root,'events',name),'utf8'),rows=[];for(const line of text.split(/\r?\n/).filter(Boolean)){try{rows.push(open(JSON.parse(line),key));}catch(error){if(line===text.trim().split(/\r?\n/).at(-1))break;throw error;}}events.set(id,rows);}
 return {jobs,plans,payloads,events};
}

export async function deleteDurableJob(directory,id){id=validId(id);const root=rootOf(directory);await Promise.all([rm(path.join(root,'jobs',id+'.json'),{force:true}),rm(path.join(root,'events',id+'.ndjson'),{force:true})]);}
export async function deleteDurablePlan(directory,id){id=validId(id);await rm(path.join(rootOf(directory),'plans',id+'.json'),{force:true});}
export async function deleteDurablePayload(directory,id){id=validId(id);await rm(path.join(rootOf(directory),'payloads',id+'.json'),{force:true});}
