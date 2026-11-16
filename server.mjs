import {exportAll} from './export-pages.mjs';
import {prepareImport,materializeDependencies,nodeKey} from './import-plan.mjs';
import {fetchRelations,verifyRelations} from './relations.mjs';
import {validateImportPreset} from './import-presets.mjs';
import {applyImportMapping} from './public/import-mapping.js';
import http from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {readOrigami,normalizeEntities,normalizeStructure,excludedEntity} from './origami.mjs';
import {exportEntity,createPackage} from './transfer.mjs';
import {dateRange,exportParams,verifyWindow,dryRunEntity} from './sync.mjs';
import {writeSimply,executeRow} from './run.mjs';
import {rateSnapshot} from './rate-limit.mjs';
import {validatePreset} from './presets.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const appVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const port=Number(process.env.PORT||4318);
const publicUrl=new URL(process.env.PUBLIC_URL||`http://127.0.0.1:${port}/`);
if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(publicUrl.pathname))throw Error('PUBLIC_URL must be an http(s) URL with a simple path and no credentials/query/fragment');
const origin=publicUrl.origin,basePath=publicUrl.pathname.replace(/\/+$/,'')+'/',listenHost=process.env.HOST||'127.0.0.1';
const cookiePath=basePath,secureCookie=publicUrl.protocol==='https:'?'; Secure':'';
const directory=path.resolve(process.env.DATA_DIR||path.join(root,'data'));
const vaultPath=path.join(directory,'connections.vault.json');
const usersPath=path.join(directory,'users.json');
const ttl=15*60*1000,planTtl=24*60*60*1000;
const cookieName='ot_session_'+port;
const sessions=new Map(),backgroundJobs=new Map(),runtimePlans=new Map(),runtimeOutcomes=new Map();let failures=0, blockedUntil=0;
let queue=Promise.resolve();
let vaultMutationQueue=Promise.resolve();
const fail=(status,message)=>Object.assign(new Error(message),{status});
async function envelope(){try{return JSON.parse(await readFile(vaultPath,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function userStore(){try{return JSON.parse(await readFile(usersPath,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function derive(password,salt){return scryptSync(password,Buffer.from(salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
function decrypt(e,key){const d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString());}
async function persist(data,key,salt){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([c.update(JSON.stringify(data),'utf8'),c.final()]);
 await mkdir(directory,{recursive:true});
 const temp=path.join(directory,`vault-${randomUUID()}.tmp`);
 await writeFile(temp,JSON.stringify({version:1,kdf:'scrypt',salt,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600});
 await rename(temp,vaultPath);
}
async function saveUsers(value){await mkdir(directory,{recursive:true});const temp=path.join(directory,`users-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,usersPath);}
const normalizedUsername=value=>{if(typeof value!=='string')throw fail(400,'יש להזין שם משתמש.');const username=value.trim();if(username.length<3||username.length>80||/[\u0000-\u001f\u007f]/.test(username))throw fail(400,'שם המשתמש חייב להכיל 3 עד 80 תווים.');return {username,normalized:username.toLocaleLowerCase('en-US')};};
function wrapMaster(master,password){const salt=randomBytes(16).toString('base64'),key=derive(password,salt),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(master),cipher.final()]);key.fill(0);return {salt,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}
function unwrapMaster(user,password){const key=derive(password,user.wrap.salt);try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(user.wrap.iv,'base64'));d.setAuthTag(Buffer.from(user.wrap.tag,'base64'));return Buffer.concat([d.update(Buffer.from(user.wrap.ciphertext,'base64')),d.final()]);}finally{key.fill(0);}}
function clear(s){if(!s)return;const current=sessions.get(s.token);if(current===s){sessions.delete(s.token);s.key.fill(0);}}
function tokenOf(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
function auth(req,touch=true){const s=sessions.get(tokenOf(req));if(s&&Date.now()-s.last>ttl)clear(s);if(!s||sessions.get(s.token)!==s)throw fail(401,'הכספת נעולה. יש להזין שם משתמש וסיסמה.');if(touch)s.last=Date.now();return s;}
async function commit(s,next){await persist(next,s.key,s.salt);for(const current of sessions.values())current.data=structuredClone(next);}
async function mutateVault(s,mutator){let result;const task=async()=>{const currentEnvelope=await envelope(),next=currentEnvelope?decrypt(currentEnvelope,s.key):structuredClone(s.data);result=await mutator(next);await persist(next,s.key,s.salt);for(const current of sessions.values())current.data=structuredClone(next);s.data=structuredClone(next);};const pending=vaultMutationQueue.then(task,task);vaultMutationQueue=pending.catch(()=>{});await pending;return result;}
const publicData=s=>({activeId:s.data.activeId,connections:s.data.connections.map(({secret,...c})=>({...c,hasSecret:!!secret})),currentUser:{username:s.username,role:s.role},expiresAt:s.last+ttl});
function clean(body,old){
 const str=(v,max)=>{if(typeof v!=='string'||v.length>max)throw fail(400,'אחד הפרטים חסר או ארוך מדי.');return v.trim();};
 const name=str(body.name,80),baseUrl=str(body.baseUrl,2048),username=str(body.username,320),note=str(body.note||'',300);
 const maxRequestsPerSecond=Number(body.maxRequestsPerSecond??old?.maxRequestsPerSecond??10);if(!Number.isInteger(maxRequestsPerSecond)||maxRequestsPerSecond<0||maxRequestsPerSecond>1000)throw fail(400,'מגבלת הקריאות חייבת להיות מספר שלם בין 0 ל־1000.');
 const maxConcurrentRequests=Number(body.maxConcurrentRequests??old?.maxConcurrentRequests??3);if(!Number.isInteger(maxConcurrentRequests)||maxConcurrentRequests<1||maxConcurrentRequests>100)throw fail(400,'מספר הבקשות המקבילות חייב להיות בין 1 ל־100.');
 if(!name||!username)throw fail(400,'יש למלא שם חיבור ושם משתמש.');
 let url;try{url=new URL(baseUrl);}catch{throw fail(400,'יש להזין כתובת מלאה, כולל https:// או http://.');}
 if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw fail(400,'כתובת הבסיס צריכה לכלול דומיין, ויכולה לכלול פורט ונתיב, ללא פרטי התחברות, פרמטרים או #.');
 const secret=body.secret===''&&old?old.secret:str(body.secret,4096);
 if(!secret)throw fail(400,'יש להזין API Secret.');
 return {id:old?.id||randomUUID(),name,baseUrl:url.href.replace(/\/+$/,''),username,note,secret,maxRequestsPerSecond,maxConcurrentRequests,color:['teal','red','slate','blue'].includes(body.color)?body.color:'teal',createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
}
async function bodyOf(req){const bulk=['/api/import/dry-run','/api/import/fetch-relations','/api/import/prepare','/api/import/prepare/start','/api/import/run/start','/api/presets/save','/api/import-presets/save','/api/export/entity'].includes(req.url),chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(!bulk&&size>32768)throw fail(413,'הבקשה גדולה מדי.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail(400,'בקשה לא תקינה.');}}
function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
async function buildImportPreparation({s,c,b,guard,onDebug,onProgress}){
 const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map();
 const prepared=await prepareImport({connection:c,mappings:b.mappings,rules:b.rules??[],schemas,guard,onDebug,onProgress});guard();
 const ids=prepared.plans.map(()=>randomUUID()),batch={nodes:new Map(),halted:false},createdAt=Date.now();
 prepared.order.forEach(item=>batch.nodes.set(item.key,{planId:ids[item.planIndex],index:item.index,dependencies:item.dependencies}));
 prepared.plans.forEach((p,i)=>runtimePlans.set(ids[i],{ownerId:s.userId,connectionId:c.id,connectionVersion:c.updatedAt,createdAt,sourceEntity:structuredClone(p.entity),entity:p.mapped,targetId:p.targetId,targetKey:p.targetKey,mapping:p.mapping,relationStaging:p.relationStaging,schema:p.schema,result:p.result,relationData:p.relationData,halted:false,batch}));
 return {plans:prepared.plans.map((p,i)=>({id:ids[i],result:p.result,sourceEntity:p.entity,targetKey:p.targetKey,mapping:p.mapping,relationStaging:p.relationStaging})),order:prepared.order.map(item=>({...item,planId:ids[item.planIndex]})),report:prepared.report};
}
async function executePlanRow(s,b,guard=()=>{}){
 const plan=runtimePlans.get(b.planId),index=b.index;
 if(!plan||plan.ownerId!==s.userId||!Number.isInteger(index)||index<0||index>=plan.entity.records.length)throw fail(422,'בדיקת הייבוא פגה או שהרשומה אינה תקינה. בצעו Dry Run חדש.');
 const c=s.data.connections.find(c=>c.id===plan.connectionId);
 if(!c||s.data.activeId!==c.id||c.updatedAt!==plan.connectionVersion)throw fail(409,'החיבור השתנה. בצעו Dry Run מחדש.');
 const id=b.planId+':'+index,outcome=id=>runtimeOutcomes.get(id)||s.data.importLog?.find(r=>r.id===id),previous=outcome(id);
 if(previous)return {row:previous,replayed:true};
 if(plan.halted||plan.batch?.halted||Date.now()-plan.createdAt>planTtl)throw fail(409,'הריצה נעצרה או שהבדיקה פגה. בדקו את הדוח לפני Dry Run חדש.');
 let planned=plan.result.rows[index];let effectiveRelationData=plan.relationData;
 if(plan.batch&&planned.status==='planned'){const item=plan.batch.nodes.get(nodeKey(plan.entity.meta.dataName,planned.sourceId)),outcomes=new Map(item.dependencies.map(key=>{const ref=plan.batch.nodes.get(key);return [key,outcome(ref?.planId+':'+ref?.index)];}));const materialized=materializeDependencies({planned,relationData:plan.relationData?.[planned.sourceId],dependencies:item.dependencies,outcomes});if(materialized.notReady)throw fail(409,'יש לבצע קודם את הרשומות הקודמות בסדר הכתיבה.');if(materialized.blocked)planned={...planned,status:'blocked',reasons:[materialized.reason]};else{planned=materialized.planned;effectiveRelationData={...plan.relationData,[planned.sourceId]:materialized.relationData};}}
 const key=JSON.stringify([c.id,plan.targetId,plan.targetKey.kind,plan.targetKey.groupId||'',plan.targetKey.fieldId||'',String(plan.targetKey.kind==='recordId'?planned.sourceId:planned.matchKey)]);
 if((s.data.importLog||[]).some(r=>r.conflictKey===key&&['pending','unknown'].includes(r.status)))return {row:{ownerId:s.userId,id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,status:'not_sent',sent:false,stop:false,error:{message:'דולג: קיימת כתיבה קודמת עם תוצאה לא ידועה לאותו מפתח. בדקו את הרשומה ביעד לפני ניסיון ידני נוסף.'}}};
 const base={ownerId:s.userId,relationResolution:effectiveRelationData?.[plan.entity.records[index].id]??{},writePayload:planned.request.body,writePayloads:structuredClone(planned.requests??[]),sourceRecord:structuredClone(plan.sourceEntity.records[index]),sourceEntityMeta:structuredClone(plan.sourceEntity.meta),targetRecord:structuredClone(plan.entity.records[index]),targetKey:structuredClone(plan.targetKey),mapping:plan.mapping??[],id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,startedAt:new Date().toISOString()};
 const compact=row=>({ownerId:s.userId,id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,startedAt:base.startedAt,...row});
 const save=async row=>{await mutateVault(s,next=>{next.importLog??=[];const i=next.importLog.findIndex(x=>x.id===id);if(row.status==='succeeded'){if(i>=0)next.importLog.splice(i,1);runtimeOutcomes.set(id,compact(row));return;}const entry={...base,...row};if(i<0)next.importLog.push(entry);else next.importLog[i]=entry;runtimeOutcomes.set(id,entry);});};
 let debug;const write=(r,step)=>writeSimply(c,step.operation,step.body,d=>debug=d,guard);
 const reconcile=async({completed,error})=>{
  const entity={...plan.entity,records:[plan.entity.records[index]]},checked=await dryRunEntity({connection:c,entity,targetId:plan.targetId,targetKey:plan.targetKey,schema:plan.schema,relationData:effectiveRelationData,guard,onDebug:d=>debug=d}),fresh=checked.rows[0];
  if(fresh.status==='skipped')return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:fresh.targetId||planned.targetId,status:'succeeded',sent:true,stop:false,reconciled:true,reconciliation:'הכתיבה נמצאה ביעד לאחר תשובה לא ידועה.',completedRequests:completed,warnings:planned.warnings};
  if(fresh.status!=='planned')return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:fresh.targetId||planned.targetId,status:'unknown',sent:true,stop:false,reconciled:false,completedRequests:completed,error:{message:'לא ניתן לאמת את הכתיבה ביעד: '+(fresh.reasons||[]).join('; '),details:error.details}};
  let targetId=fresh.targetId||planned.targetId;const recovery=[];for(const step of fresh.requests||[]){const response=await write(fresh,step);targetId=response.targetId||targetId;recovery.push({operation:step.operation,response:response.response});}
  return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId,status:'succeeded',sent:true,stop:false,reconciled:true,reconciliation:'היעד נבדק והכתיבה החסרה הושלמה.',completedRequests:completed,recoveryRequests:recovery,warnings:planned.warnings};
 };
 const row=await executeRow({planned,write,recordIntent:()=>save({status:'pending',sent:true,stop:false}),recordResult:r=>save({...r,finishedAt:new Date().toISOString()}),reconcile});
 if(!row.sent)await save({...row,finishedAt:new Date().toISOString()});
 return {row:row.status==='succeeded'?compact(row):{...base,...row},debug};
}
const dryGroupPrefix='dry-group:';
function dryGroup(ownerId,transferId){
 const members=[...backgroundJobs.entries()].filter(([,job])=>job.ownerId===ownerId&&job.type==='import_prepare'&&job.transferId===transferId);
 if(!members.length)return null;
 const jobs=members.map(([,job])=>job),failed=jobs.some(job=>job.state==='error'),batchesTotal=Math.max(1,...jobs.map(job=>Number(job.batchCount)||1)),allBatchesRegistered=jobs.length>=batchesTotal,running=!failed&&(jobs.some(job=>job.state==='running')||!allBatchesRegistered),doneRecords=jobs.filter(job=>job.state==='done').reduce((sum,job)=>sum+Number(job.batchRecords||0),0),activeRecords=jobs.filter(job=>job.state==='running').reduce((sum,job)=>sum+Math.min(Number(job.batchRecords||0),Number(job.progress?.records||0)),0),total=Number(jobs[0].totalRecords)||jobs.reduce((sum,job)=>sum+Number(job.batchRecords||0),0),completed=Math.min(total,doneRecords+activeRecords),percent=total?Math.floor(completed*100/total):(running?0:100),errors=jobs.filter(job=>job.error).map(job=>job.error);
 return {id:dryGroupPrefix+transferId,type:'import_prepare',state:failed?'error':running?'running':'done',connectionId:jobs[0].connectionId,connectionName:jobs[0].connectionName,label:jobs[0].label||jobs[0].fileName||'Dry Run',fileName:jobs[0].fileName||'',fileSize:Number(jobs[0].fileSize)||0,createdAt:Math.min(...jobs.map(job=>job.createdAt)),startedAt:jobs.map(job=>job.startedAt).sort()[0],finishedAt:running?null:Math.max(...jobs.map(job=>Number(job.finishedAt)||0)),progress:{completed,total,percent,etaSeconds:null,batchesCompleted:jobs.filter(job=>job.state==='done').length,batchesTotal},error:errors.join(' | ')||null,members};
}
function jobOverview(ownerId){
 const grouped=new Map(),plain=[];
 for(const [id,job] of backgroundJobs){if(job.ownerId!==ownerId)continue;if(job.type==='import_prepare'&&job.transferId){if(!grouped.has(job.transferId))grouped.set(job.transferId,dryGroup(ownerId,job.transferId));}else plain.push({id,...job});}
 return [...plain,...grouped.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(job=>({id:job.id,type:job.type,state:job.state,connectionId:job.connectionId,connectionName:job.connectionName,label:job.label,fileName:job.fileName,fileSize:job.fileSize,createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,progress:job.progress,counts:job.counts,error:job.error,rateLimit:job.rateLimit}));
}
async function api(req,res,url){
 const method=req.method;
 if(method!=='GET'&&(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0]!=='application/json'))throw fail(403,'בקשה ממקור לא מורשה.');
 if(url==='/api/status'&&method==='GET'){let unlocked=false,currentUser=null;try{const current=auth(req,false);unlocked=true;currentUser={username:current.username,role:current.role};}catch{}const e=await envelope(),users=await userStore();return send(res,200,{initialized:!!e,accountsInitialized:!!users,migrationRequired:!!e&&!users,unlocked,currentUser});}
 if(['/api/setup','/api/unlock'].includes(url)&&method==='POST'){
  if(Date.now()<blockedUntil)throw fail(429,'יותר מדי ניסיונות. אפשר לנסות שוב בעוד דקה.');
  const b=await bodyOf(req);if(typeof b.password!=='string'||b.password.length>1024)throw fail(400,'יש להזין סיסמה תקינה.');const identity=normalizedUsername(b.username);
  const e=await envelope(),store=await userStore();let key,data,salt,user;
  if(url==='/api/setup'){
   if(e)throw fail(409,'כבר הוגדרה סיסמת פתיחה.');
   if(b.password.length<10)throw fail(400,'בחרו סיסמה באורך 10 תווים לפחות.');
   salt=randomBytes(16).toString('base64');key=randomBytes(32);data={connections:[],activeId:null};user={id:randomUUID(),...identity,role:'admin',wrap:wrapMaster(key,b.password),createdAt:new Date().toISOString()};await persist(data,key,salt);await saveUsers({version:1,users:[user]});
  }else{
   if(!e)throw fail(409,'יש להגדיר תחילה משתמש מנהל.');salt=e.salt;
   if(!store){key=derive(b.password,salt);try{data=decrypt(e,key);}catch{key.fill(0);failures++;if(failures>=5){blockedUntil=Date.now()+60000;failures=0;}throw fail(401,'שם המשתמש או הסיסמה שגויים.');}const master=randomBytes(32);user={id:randomUUID(),...identity,role:'admin',wrap:wrapMaster(master,b.password),createdAt:new Date().toISOString()};await persist(data,master,salt);await saveUsers({version:1,users:[user]});key.fill(0);key=master;}
   else{user=store.users.find(x=>x.normalized===identity.normalized);if(!user)throw fail(401,'שם המשתמש או הסיסמה שגויים.');try{key=unwrapMaster(user,b.password);data=decrypt(e,key);}catch{key?.fill(0);failures++;if(failures>=5){blockedUntil=Date.now()+60000;failures=0;}throw fail(401,'שם המשתמש או הסיסמה שגויים.');}}
  }
  failures=0;const current={key,salt,data,username:user.username,userId:user.id,role:user.role,schemas:new Map(),plans:new Map(),runOutcomes:new Map(),exports:new Map(),imports:new Map(),token:randomBytes(32).toString('hex'),last:Date.now()};sessions.set(current.token,current);
  return send(res,200,publicData(current),{'Set-Cookie':`${cookieName}=${current.token}; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}`});
 }
 const s=auth(req,url!=='/api/jobs');
 if(url==='/api/lock'&&method==='POST'){clear(s);return send(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}; Max-Age=0`});}
 if(url==='/api/jobs'&&method==='GET')return send(res,200,{jobs:jobOverview(s.userId),expiresAt:s.last+ttl});
 if(url==='/api/jobs/detail'&&method==='POST'){const b=await bodyOf(req);if(String(b.jobId).startsWith(dryGroupPrefix)){const group=dryGroup(s.userId,String(b.jobId).slice(dryGroupPrefix.length));if(!group)throw fail(404,'התהליך לא נמצא.');return send(res,200,{job:{...group,members:undefined,rows:group.members.filter(([,job])=>job.error).map(([,job])=>({status:'failed',sourceId:'אצווה '+(Number(job.batchIndex)+1),error:{message:job.error}}))},expiresAt:s.last+ttl});}const job=backgroundJobs.get(b.jobId);if(!job||job.ownerId!==s.userId)throw fail(404,'התהליך לא נמצא.');return send(res,200,{job:{...job,key:undefined,rows:(job.rows||[]).slice(-500)},expiresAt:s.last+ttl});}
 if(url==='/api/jobs/delete'&&method==='POST'){const b=await bodyOf(req);if(String(b.jobId).startsWith(dryGroupPrefix)){const group=dryGroup(s.userId,String(b.jobId).slice(dryGroupPrefix.length));if(!group)throw fail(404,'התהליך לא נמצא.');if(group.state==='running')throw fail(409,'יש להמתין לסיום התהליך לפני מחיקתו.');for(const [id] of group.members)backgroundJobs.delete(id);return send(res,200,{ok:true,expiresAt:s.last+ttl});}const job=backgroundJobs.get(b.jobId);if(!job||job.ownerId!==s.userId)throw fail(404,'התהליך לא נמצא.');if(job.state==='running')throw fail(409,'יש לעצור את התהליך לפני מחיקתו.');backgroundJobs.delete(b.jobId);return send(res,200,{ok:true,expiresAt:s.last+ttl});}
 if(url==='/api/connections'&&method==='GET')return send(res,200,publicData(s));
 if(url==='/api/admin/users'&&method==='GET'){
  if(s.role!=='admin')throw fail(403,'הפעולה זמינה למנהל בלבד.');const store=await userStore();return send(res,200,{users:store.users.map(({id,username,role,createdAt})=>({id,username,role,createdAt,current:id===s.userId})),expiresAt:s.last+ttl});
 }
 if(url==='/api/admin/users'&&method==='POST'){
  if(s.role!=='admin')throw fail(403,'הפעולה זמינה למנהל בלבד.');const b=await bodyOf(req),store=await userStore();if(!store)throw fail(409,'ניהול המשתמשים טרם אותחל.');
  if(b.action==='create'){const identity=normalizedUsername(b.username);if(store.users.some(x=>x.normalized===identity.normalized))throw fail(409,'שם המשתמש כבר קיים.');if(typeof b.password!=='string'||b.password.length<10||b.password.length>1024)throw fail(400,'הסיסמה חייבת להכיל לפחות 10 תווים.');store.users.push({id:randomUUID(),...identity,role:'user',wrap:wrapMaster(s.key,b.password),createdAt:new Date().toISOString()});}
  else if(b.action==='reset'){const user=store.users.find(x=>x.id===b.id);if(!user)throw fail(404,'המשתמש לא נמצא.');if(typeof b.password!=='string'||b.password.length<10||b.password.length>1024)throw fail(400,'הסיסמה חייבת להכיל לפחות 10 תווים.');user.wrap=wrapMaster(s.key,b.password);for(const current of [...sessions.values()])if(current.userId===user.id&&current!==s)clear(current);}
  else if(b.action==='delete'){const index=store.users.findIndex(x=>x.id===b.id);if(index<0)throw fail(404,'המשתמש לא נמצא.');if(store.users[index].id===s.userId)throw fail(409,'לא ניתן למחוק את המשתמש המחובר.');if(store.users[index].role==='admin'&&store.users.filter(x=>x.role==='admin').length===1)throw fail(409,'לא ניתן למחוק את המנהל האחרון.');const [removed]=store.users.splice(index,1);for(const current of [...sessions.values()])if(current.userId===removed.id)clear(current);}
  else throw fail(400,'פעולת ניהול משתמשים אינה תקינה.');await saveUsers(store);return send(res,200,{users:store.users.map(({id,username,role,createdAt})=>({id,username,role,createdAt,current:id===s.userId})),expiresAt:s.last+ttl});
 }
 if(['/api/schema/list','/api/schema/structure'].includes(url)&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);
  if(!c||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה. בחרו חיבור מחדש.');
  if(url.endsWith('/structure')&&(typeof b.entityId!=='string'||!b.entityId||b.entityId.length>256))throw fail(400,'מזהה ישות לא תקין.');
  if(url.endsWith('/structure')&&excludedEntity({entity_data_name:b.entityId}))throw fail(400,'מבני משתמשים וקבוצות משתמשים אינם נכללים.');
  let debug;
  try{
  const raw=await readOrigami(c,url.endsWith('/list')?'entities_list':'entity_structure',url.endsWith('/list')?{}:{entity_data_name:b.entityId},value=>{debug=value;},()=>{if(auth(req)!==s||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה במהלך ההמתנה.');});
  if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה במהלך הטעינה. טענו שוב.');
  const skipped=[];
  const result=url.endsWith('/list')?{entities:normalizeEntities(raw,e=>skipped.push(e)),skipped}:{structure:normalizeStructure(raw)};
  if(url.endsWith('/list'))debug.skippedEntities=skipped;
  const schemaKey=c.id+':'+c.updatedAt;
  if(url.endsWith('/list'))s.schemas.set(schemaKey,new Map());
  else {if(!s.schemas.has(schemaKey))s.schemas.set(schemaKey,new Map());s.schemas.get(schemaKey).set(b.entityId,result.structure);}
  return send(res,200,{...result,debug,expiresAt:s.last+ttl});
  }catch(e){if(auth(req)!==s||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה במהלך הטעינה.');if(debug){if(debug.outcome==='success'){debug.outcome='error';debug.failureStage='normalize';debug.error={message:e.message};}e.debug=debug;}throw e;}
 }
 if(url==='/api/export/status'&&method==='POST'){
  const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);
  if(!job||job.ownerId!==s.userId||job.connectionId!==b.connectionId)throw fail(404,'משימת הייצוא לא נמצאה או שפג תוקפה.');
  if(job.state==='running')return send(res,200,{state:'running',progress:job.progress,expiresAt:s.last+ttl});
  if(job.state==='error')return send(res,200,{state:'error',error:job.error,debug:job.debug,progress:job.progress,expiresAt:s.last+ttl});
  return send(res,200,{state:'done',...job.result,progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/export/start'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);
  if(!c||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה.');
  const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map();
  const p=validatePreset({name:b.presetName||'ייצוא ניסוי',entities:[b.entity]},c.id,schemas);
  const config=p.entities[0],range=dateRange(b.dateRange),jobId=randomUUID();
  const job={type:'export',ownerId:s.userId,username:s.username,connectionName:c.name,state:'running',connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),finishedAt:null,debug:null,progress:{phase:'starting',attempt:1,maxAttempts:3,page:0,pageSize:500,records:0,total:null,percent:0}};
  backgroundJobs.set(jobId,job);
  const guard=()=>{};
  void (async()=>{try{
   const entity=await exportAll({connection:c,config,schema:schemas.get(config.entityId),range,onDebug:d=>job.debug=d,onProgress:p=>{job.progress=p;},guard});
   if(job.debug)job.debug.exportSummary={name:entity.meta.name,dataName:config.entityId,records:entity.records.length,totalAvailable:entity.meta.totalAvailable,dateRange:range};
   job.progress={...job.progress,phase:'complete',records:entity.records.length,total:entity.meta.totalAvailable,percent:100};
   job.result={entity,meta:{...createPackage({},p.name).meta,dateRange:range,sourceConnectionId:c.id},debug:job.debug};job.state='done';job.finishedAt=Date.now();
  }catch(e){if(job.debug){job.debug.outcome='error';job.debug.error={message:e.message};}job.error=e.message||'לא ניתן להשלים את הייצוא.';job.state='error';job.finishedAt=Date.now();}})();
  return send(res,202,{jobId,state:'running',progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/export/entity'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);
  if(!c||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה.');
  const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map();
  const p=validatePreset({name:b.presetName||'ייצוא ניסוי',entities:[b.entity]},c.id,schemas);
  const config=p.entities[0],range=dateRange(b.dateRange);let debug;
  const guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה במהלך הייצוא.');};
  try{const entity=await exportAll({connection:c,config,schema:schemas.get(config.entityId),range,onDebug:d=>debug=d,guard});if(debug)debug.exportSummary={name:entity.meta.name,dataName:config.entityId,records:entity.records.length,totalAvailable:entity.meta.totalAvailable,dateRange:range};
   return send(res,200,{entity,meta:{...createPackage({},p.name).meta,dateRange:range,sourceConnectionId:c.id},debug,expiresAt:s.last+ttl});
  }catch(e){if(debug){debug.outcome='error';debug.error={message:e.message};e.debug=debug;}throw e;}
 }
 if(url==='/api/import/prepare/status'&&method==='POST'){
  const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);
  if(!job||job.ownerId!==s.userId||job.connectionId!==b.connectionId)throw fail(404,'משימת ה־Dry Run לא נמצאה או שפג תוקפה.');
  if(job.state==='running')return send(res,200,{state:'running',progress:job.progress,startedAt:job.startedAt,expiresAt:s.last+ttl});
  if(job.state==='error')return send(res,200,{state:'error',error:job.error,debug:job.debug,progress:job.progress,expiresAt:s.last+ttl});
  return send(res,200,{state:'done',...job.result,progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/prepare/start'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');if(b.schemaVersion!=='1.0')throw fail(422,'גרסת חבילה לא נתמכת.');
  const jobId=randomUUID(),job={type:'import_prepare',ownerId:s.userId,username:s.username,connectionName:c.name,transferId:typeof b.transferId==='string'?b.transferId:null,label:b.label||b.fileName||'Dry Run',fileName:b.fileName||'',fileSize:Number(b.fileSize)||0,batchIndex:Number(b.batchIndex)||0,batchCount:Math.max(1,Number(b.batchCount)||1),batchRecords:Math.max(0,Number(b.batchRecords)||0),totalRecords:Math.max(0,Number(b.totalRecords)||0),state:'running',connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),startedAt:new Date().toISOString(),finishedAt:null,debug:null,progress:{phase:'starting',entityIndex:0,entities:Array.isArray(b.mappings)?b.mappings.length:0,records:0}};backgroundJobs.set(jobId,job);
  const guard=()=>{};
  void (async()=>{try{job.result=await buildImportPreparation({s,c,b,guard,onDebug:d=>job.debug=d,onProgress:p=>job.progress=p});job.state='done';job.progress={...job.progress,phase:'complete'};job.finishedAt=Date.now();}catch(e){if(job.debug){job.debug.outcome='error';job.debug.error={message:e.message};}job.error=e.message||'לא ניתן להשלים את ה־Dry Run.';job.state='error';job.finishedAt=Date.now();}})();
  return send(res,202,{jobId,state:'running',progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/prepare'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');if(b.schemaVersion!=='1.0')throw fail(422,'גרסת חבילה לא נתמכת.');
  const guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה במהלך ה־Dry Run.');};
  let debug;try{return send(res,200,{...await buildImportPreparation({s,c,b,guard,onDebug:d=>debug=d}),debug,expiresAt:s.last+ttl});}catch(e){if(debug)e.debug=debug;throw e;}
 }
 if(url==='/api/import/fetch-relations'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');
  const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map(),guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה.');};
  let debug;try{const result=await fetchRelations({connection:c,mappings:b.mappings,rules:b.rules,schemas,guard,onDebug:d=>debug=d});guard();s.relations??=new Map();const token=randomUUID();s.relations.set(token,{connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),entries:result.entries});return send(res,200,{token,report:result.report,debug,expiresAt:s.last+ttl});}catch(e){if(debug)e.debug=debug;throw e;}
 }
 if(url==='/api/import/dry-run'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(x=>x.id===b.connectionId);
  if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');
  if(b.schemaVersion!=='1.0')throw fail(422,'גרסת חבילה לא נתמכת.');
  if(typeof b.targetId!=='string'||excludedEntity({entity_data_name:b.targetId}))throw fail(422,'ישות יעד לא תקינה.');
  const schema=s.schemas.get(c.id+':'+c.updatedAt)?.get(b.targetId);if(!schema)throw fail(422,'טענו את מבנה ישות היעד לפני בדיקה.');
  const guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה. הבדיקה נעצרה.');};
  let relationData={};if(b.relationToken){const fetched=s.relations?.get(b.relationToken),entry=fetched?.entries.find(e=>e.entity.meta.dataName===b.entity?.meta?.dataName);if(!fetched||fetched.connectionId!==c.id||fetched.connectionVersion!==c.updatedAt||Date.now()-fetched.createdAt>ttl||!entry||JSON.stringify(entry.entity)!==JSON.stringify(b.entity)||entry.targetId!==b.targetId||JSON.stringify(entry.targetKey)!==JSON.stringify(b.targetKey)||JSON.stringify(entry.mapping??[])!==JSON.stringify(b.mapping??[]))throw fail(409,'תוכנית הקישורים אינה תואמת או פגה. הפעילו FETCH RELATIONS מחדש.');relationData=entry.relationData;}
  let debug;try{const result=await dryRunEntity({connection:c,entity:b.entity,targetId:b.targetId,targetKey:b.targetKey,schema,mapping:b.mapping,relationStaging:b.relationStaging,relationData,guard,onDebug:d=>debug=d});guard();const planId=randomUUID();runtimePlans.set(planId,{ownerId:s.userId,connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),sourceEntity:structuredClone(b.entity),entity:b.mapping===undefined?structuredClone(b.entity):applyImportMapping(b.entity,schema,b.mapping,b.relationStaging,b.targetId),targetId:b.targetId,targetKey:structuredClone(b.targetKey),mapping:b.mapping===undefined?undefined:structuredClone(b.mapping),relationStaging:b.relationStaging?structuredClone(b.relationStaging):null,schema,result,relationData,halted:false});return send(res,200,{result,planId,debug,expiresAt:s.last+ttl});}catch(e){if(debug)e.debug=debug;throw e;}
 }
 if(url==='/api/import/history'&&method==='POST'){
  const b=await bodyOf(req);if(s.data.activeId!==b.connectionId)throw fail(409,'בחרו חיבור פעיל.');const all=[...(s.data.importLog||[]),...[...runtimeOutcomes.values()].filter(r=>r.ownerId===s.userId)].filter(r=>r.connectionId===b.connectionId);return send(res,200,{rows:all.slice(-500),totalRows:all.length,truncated:all.length>500,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run/status'&&method==='POST'){
  const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);if(!job||job.type!=='import_run'||job.ownerId!==s.userId)throw fail(404,'משימת הייבוא לא נמצאה.');return send(res,200,{state:job.state,progress:job.progress,counts:job.counts,rows:job.rows.slice(-500),truncated:job.rows.length>500,error:job.error,startedAt:job.startedAt,finishedAt:job.finishedAt,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run/stop'&&method==='POST'){const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);if(!job||job.type!=='import_run'||job.ownerId!==s.userId)throw fail(404,'משימת הייבוא לא נמצאה.');job.stopRequested=true;return send(res,200,{ok:true,expiresAt:s.last+ttl});}
 if(url==='/api/import/run/start'&&method==='POST'){
  const b=await bodyOf(req);if([...backgroundJobs.values()].some(job=>job.type==='import_run'&&job.ownerId===s.userId&&job.connectionId===s.data.activeId&&job.state==='running'))throw fail(409,'כבר פועל ייבוא ברקע בחיבור הזה. התקדמותו מוצגת ברשימת התהליכים.');if(!Array.isArray(b.planIds)||!b.planIds.length||!Array.isArray(b.order))throw fail(422,'לא נמצאה תוכנית כתיבה קפואה. בצעו Dry Run חדש.');const selected=b.planIds.map(id=>runtimePlans.get(id));if(selected.some(p=>!p||p.ownerId!==s.userId||p.connectionId!==s.data.activeId))throw fail(409,'תוכנית הייבוא אינה שייכת לחיבור הפעיל.');
  const planSet=new Set(b.planIds),expected=new Set();for(const planId of b.planIds){const plan=runtimePlans.get(planId);for(let index=0;index<plan.result.rows.length;index++)if(plan.result.rows[index].status==='planned')expected.add(planId+':'+index);}
  const order=b.order.map(item=>({planId:item?.planId,index:Number(item?.index)})),seen=new Set();for(const item of order){const key=item.planId+':'+item.index;if(!planSet.has(item.planId)||!Number.isInteger(item.index)||!expected.has(key)||seen.has(key))throw fail(422,'סדר הכתיבה אינו תואם ל־Dry Run. בצעו בדיקה חדשה.');seen.add(key);}if(seen.size!==expected.size)throw fail(422,'סדר הכתיבה חסר רשומות שאושרו ב־Dry Run.');
  const connection=s.data.connections.find(c=>c.id===s.data.activeId),allRows=selected.flatMap(p=>p.result.rows),requestTotal=order.reduce((sum,item)=>sum+(runtimePlans.get(item.planId).result.rows[item.index].requests?.length||1),0),jobId=randomUUID(),worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data)},job={type:'import_run',ownerId:s.userId,username:s.username,connectionName:connection?.name||'',connectionId:s.data.activeId,label:b.label||b.fileName||'ייבוא',fileName:b.fileName||'',fileSize:Number(b.fileSize)||0,state:'running',createdAt:Date.now(),startedAt:new Date().toISOString(),finishedAt:null,stopRequested:false,order:structuredClone(order),progress:{completed:0,total:order.length,percent:0,etaSeconds:null,apiRequestsCompleted:0,apiRequestsTotal:requestTotal},counts:{input:allRows.length,planned:order.length,skipped:allRows.filter(r=>r.status==='skipped').length,blocked:allRows.filter(r=>r.status==='blocked').length,succeeded:0,failed:0,not_sent:0,unknown:0,stopped:0},rows:[],rateLimit:rateSnapshot(connection)};backgroundJobs.set(jobId,job);
  void (async()=>{let cursor=0;const startedAt=Date.now(),concurrency=Math.min(order.length,connection?.maxConcurrentRequests||3),take=()=>cursor<order.length?order[cursor++]:null;const workerLoop=async()=>{for(;;){if(job.stopRequested)return;const item=take();if(!item)return;let result;try{result=await executePlanRow(worker,item,()=>{});}catch(e){const plan=runtimePlans.get(item.planId),planned=plan?.result?.rows?.[item.index];result={row:{entityName:plan?.result?.name,targetEntity:plan?.targetId,sourceId:planned?.sourceId,action:planned?.action,status:'not_sent',sent:false,stop:false,error:{message:e.message}}};}const row=result.row;job.counts[row.status]=(job.counts[row.status]||0)+1;if(row.status!=='succeeded')job.rows.push(row);const completed=job.progress.completed+1,elapsed=Math.max(1,(Date.now()-startedAt)/1000),remaining=order.length-completed;job.progress={...job.progress,completed,percent:order.length?Math.floor(completed*100/order.length):100,etaSeconds:completed?Math.ceil(remaining/(completed/elapsed)):null,apiRequestsCompleted:job.progress.apiRequestsCompleted+(row.completedRequests?.length||row.responses?.length||1)};job.rateLimit=rateSnapshot(connection);}};
  try{await Promise.all(Array.from({length:Math.max(1,concurrency)},workerLoop));job.state=job.stopRequested?'stopped':'done';job.progress={...job.progress,percent:job.stopRequested?job.progress.percent:100,etaSeconds:0};job.finishedAt=Date.now();}catch(e){job.state='error';job.error=e.message;job.finishedAt=Date.now();}finally{worker.key.fill(0);}})();
  return send(res,202,{jobId,state:'running',progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run'&&method==='POST'){const b=await bodyOf(req),result=await executePlanRow(s,b,()=>{if(auth(req)!==s)throw fail(401,'הכספת נעולה.');});return send(res,200,{...result,expiresAt:s.last+ttl});}
 if(url==='/api/import/finish'&&method==='POST'){
  const b=await bodyOf(req);if(!Array.isArray(b.planIds)||!b.planIds.length)throw fail(422,'ריצה לא תקינה.');const plans=b.planIds.map(id=>runtimePlans.get(id));if(plans.some(p=>!p||p.ownerId!==s.userId||p.connectionId!==s.data.activeId))throw fail(409,'הריצה אינה שייכת לחיבור הפעיל.');
  const rows=b.planIds.flatMap((id,i)=>plans[i].entity.records.map((_,index)=>runtimeOutcomes.get(id+':'+index)||s.data.importLog?.find(r=>r.id===id+':'+index)));
  const success=rows.length>0&&rows.every(r=>r?.status==='succeeded');if(success){const next=structuredClone(s.data);next.syncStates??={};const state=next.syncStates[next.activeId]??={lastImportedAt:null,sourceSyncedThrough:null,exportFrom:null};state.lastImportedAt=new Date(rows.reduce((latest,r)=>Math.max(latest,Date.parse(r.finishedAt)),0)).toISOString();await commit(s,next);}
  return send(res,200,{success,sourceWatermarkAdvanced:false,expiresAt:s.last+ttl});
 }
 const b=await bodyOf(req),next=structuredClone(s.data);
 if(['/api/sync/state','/api/sync/save','/api/sync/export-finish'].includes(url)&&method==='POST'){
  const c=next.connections.find(x=>x.id===b.connectionId);if(!c||next.activeId!==c.id)throw fail(409,'בחרו חיבור פעיל.');
  next.syncStates??={};const state=next.syncStates[c.id]||{lastImportedAt:null,sourceSyncedThrough:null,exportFrom:null};
  if(url==='/api/sync/save'){if(b.exportFrom!==null&&!Number.isFinite(Date.parse(b.exportFrom)))throw fail(422,'תאריך לא תקין.');state.exportFrom=b.exportFrom===null?null:new Date(b.exportFrom).toISOString();next.syncStates[c.id]=state;await commit(s,next);}
  if(url==='/api/sync/export-finish'){
   if(typeof b.exportThrough!=='string'||!Number.isFinite(Date.parse(b.exportThrough)))throw fail(422,'תאריך ייצוא לא תקין.');
   state.lastExportedAt=new Date().toISOString();state.exportFrom=new Date(b.exportThrough).toISOString();
   next.syncStates[c.id]=state;await commit(s,next);
  }
  return send(res,200,{state,expiresAt:s.last+ttl});
 }
 if(url.startsWith('/api/import-presets/')&&method==='POST'){
  const c=next.connections.find(c=>c.id===b.connectionId);if(!c||next.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');
  next.importPresets??=[];const current=next.importPresets.find(p=>p.id===b.id&&p.connectionId===c.id);
  if(url==='/api/import-presets/save'){
   if(b.id&&!current)throw fail(404,'פריסט הייבוא לא נמצא.');
   const preset=validateImportPreset(b,c.id,s.schemas.get(c.id+':'+c.updatedAt)||new Map(),current);
   if(next.importPresets.some(p=>p.connectionId===c.id&&p.sourceScope===preset.sourceScope&&p.name===preset.name&&p.id!==preset.id))throw fail(409,'כבר קיים פריסט בשם הזה למקור וליעד.');
   if(current)next.importPresets[next.importPresets.indexOf(current)]=preset;else next.importPresets.push(preset);
  }else if(url==='/api/import-presets/delete'){
   if(!current)throw fail(404,'פריסט הייבוא לא נמצא.');next.importPresets=next.importPresets.filter(p=>p.id!==current.id);
  }else if(url!=='/api/import-presets/list')throw fail(404,'הפעולה לא נמצאה.');
  if(url!=='/api/import-presets/list'){await commit(s,next);}
  return send(res,200,{presets:next.importPresets.filter(p=>p.connectionId===c.id&&p.sourceScope===b.sourceScope),expiresAt:s.last+ttl});
 }
 if(url.startsWith('/api/presets/')&&method==='POST'){
  const c=next.connections.find(c=>c.id===b.connectionId);if(!c||next.activeId!==c.id)throw fail(409,'בחרו את החיבור המתאים ל־Preset.');
  next.presets??=[];next.defaultPresets??={};
  const current=b.id?next.presets.find(p=>p.id===b.id&&p.connectionId===c.id):null;
  if(url==='/api/presets/save'){
   if(b.id&&!current)throw fail(404,'ה־Preset לא נמצא בחיבור הזה.');
   const p=validatePreset(b,c.id,s.schemas.get(c.id+':'+c.updatedAt)||new Map(),current);
   if(next.presets.some(x=>x.connectionId===c.id&&x.id!==p.id&&x.name===p.name))throw fail(409,'כבר קיים Preset בשם הזה בחיבור.');
   if(current)next.presets[next.presets.indexOf(current)]=p;else next.presets.push(p);
   if(b.makeDefault)next.defaultPresets[c.id]=p.id;
   else if(b.makeDefault===false&&next.defaultPresets[c.id]===p.id)delete next.defaultPresets[c.id];
  }else if(url==='/api/presets/default'){
   if(!current)throw fail(404,'ה־Preset לא נמצא בחיבור הזה.');next.defaultPresets[c.id]=current.id;
  }else if(url==='/api/presets/delete'){
   if(!current)throw fail(404,'ה־Preset לא נמצא בחיבור הזה.');next.presets=next.presets.filter(p=>p.id!==current.id);if(next.defaultPresets[c.id]===current.id)delete next.defaultPresets[c.id];
  }else if(url!=='/api/presets/list')throw fail(404,'הפעולה לא נמצאה.');
  if(url!=='/api/presets/list'){await commit(s,next);}
  return send(res,200,{presets:next.presets.filter(p=>p.connectionId===c.id),defaultId:next.defaultPresets[c.id]||null,expiresAt:s.last+ttl});
 }
 if(url==='/api/connections'&&method==='POST'){
  const old=b.id?next.connections.find(c=>c.id===b.id):null;if(b.id&&!old)throw fail(404,'החיבור לא נמצא.');
  const c=clean(b,old);if(next.connections.some(x=>x.id!==c.id&&x.name===c.name))throw fail(409,'כבר קיים חיבור בשם הזה.');
  if(old)next.connections[next.connections.findIndex(x=>x.id===old.id)]=c;else next.connections.push(c);
 }else if(url==='/api/select'&&method==='POST'){
  if(!next.connections.some(c=>c.id===b.id))throw fail(404,'החיבור לא נמצא.');next.activeId=b.id;
 }else if(url==='/api/delete'&&method==='POST'){
  if(!next.connections.some(c=>c.id===b.id))throw fail(404,'החיבור לא נמצא.');next.connections=next.connections.filter(c=>c.id!==b.id);next.presets=(next.presets||[]).filter(p=>p.connectionId!==b.id);if(next.defaultPresets)delete next.defaultPresets[b.id];if(next.activeId===b.id)next.activeId=null;
 }else throw fail(404,'הפעולה לא נמצאה.');
 await commit(s,next);send(res,200,publicData(s));
}
const assets={'/export-package.js':['export-package.js','text/javascript; charset=utf-8'],'/boot.js':['boot.js','text/javascript; charset=utf-8'],'/import-batches.js':['import-batches.js','text/javascript; charset=utf-8'],'/preset-transfer.js':['preset-transfer.js','text/javascript; charset=utf-8'],'/relations.js':['relations.js','text/javascript; charset=utf-8'],'/import-errors.js':['import-errors.js','text/javascript; charset=utf-8'],'/import-mapping.js':['import-mapping.js','text/javascript; charset=utf-8'],'/dry-run.js':['dry-run.js','text/javascript; charset=utf-8'],'/transfer.schema.json':['transfer.schema.json','application/schema+json'],'/export.js':['export.js','text/javascript; charset=utf-8'],'/presets.js':['presets.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/schema.js':['schema.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
 const run=async()=>{try{
  if(req.headers.host!==publicUrl.host)throw fail(403,'כתובת לא מורשית. פתחו דרך הכתובת המוגדרת ב־PUBLIC_URL.');
  const incoming=new URL(req.url,origin);if(incoming.origin!==origin)throw fail(403,'כתובת לא מורשית.');
  if(basePath!=='/'&&incoming.pathname===basePath.slice(0,-1)&&req.method==='GET'){res.writeHead(308,{Location:basePath});return res.end();}
  if(!incoming.pathname.startsWith(basePath))throw fail(404,'הנתיב אינו שייך ליישום.');
  const url='/'+incoming.pathname.slice(basePath.length);req.url=url;
  if(url.startsWith('/api/'))return await api(req,res,url);
  if(req.method!=='GET'||!assets[url])throw fail(404,'הדף לא נמצא.');
   const [file,type]=assets[url];let content=await readFile(path.join(root,'public',file));if(file==='index.html')content=Buffer.from(content.toString('utf8').replaceAll('__APP_VERSION__',appVersion));res.writeHead(200,{'Content-Type':type});res.end(content);
 }catch(e){
  if(e.status)return send(res,e.status,{error:e.message,...(e.debug?{debug:e.debug}:{})});
  const incident=randomUUID().slice(0,8);console.error(`[${incident}] ${req.method} ${req.url}`,e);
  send(res,500,{error:`לא ניתן להשלים את הפעולה. קוד תקלה: ${incident}`});
 }};
 if((req.url.startsWith('/api/schema/')||req.url.startsWith('/api/export/')||req.url==='/api/import/dry-run'))void run();else queue=queue.then(run,run);
});
setInterval(()=>{for(const current of [...sessions.values()])if(Date.now()-current.last>ttl)clear(current);for(const [id,job] of backgroundJobs)if(job.finishedAt&&Date.now()-Number(job.finishedAt)>24*60*60*1000)backgroundJobs.delete(id);for(const [id,plan] of runtimePlans)if(Date.now()-plan.createdAt>planTtl)runtimePlans.delete(id);},30000).unref();
 server.listen(port,listenHost,()=>console.log(`SIMPLY BRIDGE ${appVersion}: ${origin}${basePath}`));
