import {resolveBlackIssue,validateBlackConfig} from './black-issue-resolver.mjs';
import {createRelationFinalizer,indexImportIdentities,validateRelationRuleSets} from './relation-finalizer.mjs';
import {exportAll} from './export-pages.mjs';
import {prepareImport,materializeDependencies,nodeKey} from './import-plan.mjs';
import {fetchRelations,verifyRelations,checkKey} from './relations.mjs';
import {validateImportPreset} from './import-presets.mjs';
import {applyImportMapping} from './public/import-mapping.js';
import http from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {readOrigami,normalizeEntities,normalizeStructure,excludedEntity} from './origami.mjs';
import {exportEntity,createPackage} from './transfer.mjs';
import {dateRange,exportParams,verifyWindow,dryRunEntity} from './sync.mjs';
import {writeSimply,executeRow} from './run.mjs';
import {rateSnapshot,rateEtaSeconds,setConnectionRateCap,environmentKey} from './rate-limit.mjs';
import {validatePreset} from './presets.mjs';
import {saveWriteIntent,finishWriteIntent,saveRecoveryKey,loadRecoveryKey,saveDurableJob,saveDurablePlan,saveDurablePayload,appendDurableEvent,loadDurableState,deleteDurableJob,deleteDurablePlan,deleteDurablePayload} from './job-store.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const appVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const port=Number(process.env.PORT||4318);
const publicUrl=new URL(process.env.PUBLIC_URL||`http://127.0.0.1:${port}/`);
if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(publicUrl.pathname))throw Error('PUBLIC_URL must be an http(s) URL with a simple path and no credentials/query/fragment');
const origin=publicUrl.origin,basePath=publicUrl.pathname.replace(/\/+$/,'')+'/',listenHost=process.env.HOST||'127.0.0.1';
const cookiePath=basePath,secureCookie=publicUrl.protocol==='https:'?'; Secure':'';
const directory=path.resolve(process.env.DATA_DIR||path.join(root,'data'));
const recoveryKeyFile=process.env.BRIDGE_RECOVERY_KEY_FILE;
const serviceKey=recoveryKeyFile?await readFile(recoveryKeyFile):null;
if(serviceKey&&serviceKey.length!==32)throw Error('BRIDGE_RECOVERY_KEY_FILE must contain 32 raw bytes');
const relationRulesFile=process.env.BRIDGE_RELATION_RULES_FILE;
const relationRules=relationRulesFile?validateRelationRuleSets(JSON.parse(await readFile(relationRulesFile,'utf8'))):new Map();
const blackConfigFile=process.env.BRIDGE_BLACK_CONFIG_FILE;
const blackConfig=blackConfigFile?validateBlackConfig(JSON.parse(await readFile(blackConfigFile,'utf8'))):null;
const blackToken=blackConfig&&process.env.BRIDGE_BLACK_TOKEN_FILE?
 (await readFile(process.env.BRIDGE_BLACK_TOKEN_FILE,'utf8')).trim():null;
if(blackConfig&&(!serviceKey||!blackToken||!/^[A-Za-z0-9_-]{32,256}$/.test(blackToken))){
 throw Error('BLACK resolver requires recovery and webhook keys');
}
if(blackConfig)setConnectionRateCap(blackConfig.connectionId,8);
let blackQueue=Promise.resolve();
const vaultPath=path.join(directory,'connections.vault.json');
const usersPath=path.join(directory,'users.json');
const ttl=15*60*1000,planTtl=30*24*60*60*1000;
const cookieName='ot_session_'+port;
const sessions=new Map(),backgroundJobs=new Map(),runtimePlans=new Map(),runtimeOutcomes=new Map(),runtimeInputs=new Map();let failures=0, blockedUntil=0;
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
 const maxRequestsPerHour=Number(body.maxRequestsPerHour??old?.maxRequestsPerHour??5000);if(!Number.isInteger(maxRequestsPerHour)||maxRequestsPerHour<0||maxRequestsPerHour>1000000)throw fail(400,'מגבלת הקריאות לשעה חייבת להיות מספר שלם בין 0 למיליון.');
 const maxConcurrentRequests=Number(body.maxConcurrentRequests??old?.maxConcurrentRequests??3);if(!Number.isInteger(maxConcurrentRequests)||maxConcurrentRequests<1||maxConcurrentRequests>100)throw fail(400,'מספר הבקשות המקבילות חייב להיות בין 1 ל־100.');
 if(!name||!username)throw fail(400,'יש למלא שם חיבור ושם משתמש.');
 let url;try{url=new URL(baseUrl);}catch{throw fail(400,'יש להזין כתובת מלאה, כולל https:// או http://.');}
 if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw fail(400,'כתובת הבסיס צריכה לכלול דומיין, ויכולה לכלול פורט ונתיב, ללא פרטי התחברות, פרמטרים או #.');
 const secret=body.secret===''&&old?old.secret:str(body.secret,4096);
 if(!secret)throw fail(400,'יש להזין API Secret.');
 return {id:old?.id||randomUUID(),name,baseUrl:url.href.replace(/\/+$/,''),username,note,secret,maxRequestsPerSecond,maxRequestsPerHour,maxConcurrentRequests,color:['teal','red','slate','blue'].includes(body.color)?body.color:'teal',createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
}
async function bodyOf(req){const bulk=['/api/import/dry-run','/api/import/fetch-relations','/api/import/prepare','/api/import/prepare/start','/api/import/pipeline/start','/api/import/run/start','/api/presets/save','/api/import-presets/save','/api/export/entity'].includes(req.url),chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(!bulk&&size>32768)throw fail(413,'הבקשה גדולה מדי.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail(400,'בקשה לא תקינה.');}}
function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
const durablePlan=plan=>({...plan,batch:plan.batch?{...plan.batch,nodes:[...plan.batch.nodes]}:null});
const jobRelationCache=new Map(),completedRelationTasks=new Map();
const livePlan=plan=>({...plan,batch:plan.batch?{...plan.batch,nodes:new Map(plan.batch.nodes||[])}:null});
async function storeJob(id,job,key){await saveDurableJob(directory,key,id,job);}
async function hydrateDurable(s,{recover=false}={}){
 const loaded=await loadDurableState(directory,s.key);
 for(const [id,payload] of loaded.payloads)runtimeInputs.set(id,payload);
 for(const [id,plan] of loaded.plans)if(!runtimePlans.has(id))runtimePlans.set(id,livePlan(plan));
 for(const [jobId,events] of loaded.events)for(const event of events){if(event.type==='outcome'&&event.id)runtimeOutcomes.set(event.id,event.value);if(event.type==='outcome-clear'&&event.id)runtimeOutcomes.set(event.id,undefined);}
 for(const [id,stored] of loaded.jobs){
  if(backgroundJobs.has(id))continue;
  const job=structuredClone(stored),events=loaded.events.get(id)||[];
  if(job.type==='import_run'){
   job.counts=structuredClone(job.baseCounts||job.counts||{});job.progress=structuredClone(job.baseProgress||job.progress||{});job.rows=[];job.completedKeys=[];
   for(const event of events)if(event.type==='retry'){
    job.retries??={};
    job.retries[event.key]=event.retry;
   }
   const cache=new Map();
   for(const event of events)if(event.type==='relation-close')job.relationsClosedAt=event.at;
   if(job.relationsClosedAt)await deleteDurableJob(directory,'cache-'+id);
   else{
    for(const event of loaded.events.get('cache-'+id)||[])cache.set(event.key,event.candidates);
    if(cache.size)jobRelationCache.set(id,cache);
   }
   job.relationCompleted=0;
   job.relationIssues=[];
   const completedRelations=new Set();
   completedRelationTasks.set(id,completedRelations);
   job.pendingRelationRepair=null;
   for(const event of events){
    if(event.type==='relation-repair-queued')job.pendingRelationRepair=event.command;
    if(event.type==='relation-repair-finished')job.pendingRelationRepair=null;
    if(event.type==='relation-repair')replaceRelationIssues(job,event);
    if(event.type==='relation-intent')job.relationInFlight=event.cursor;
    if(event.type==='relation-progress'){
     job.relationInFlight=null;
     if(event.taskId)completedRelations.add(event.taskId);
     job.relationCompleted++;
     if(event.issues.length)job.relationIssues.push(...event.issues);
    }
   }
   const completed=new Set();
   for(const event of events){if(event.type!=='progress'||completed.has(event.key))continue;completed.add(event.key);job.completedKeys.push(event.key);job.counts[event.status]=(job.counts[event.status]||0)+1;if(event.row&&event.status!=='succeeded')job.rows.push(event.row);job.progress.completed++;job.progress.apiRequestsCompleted+=Number(event.apiRequests)||0;}
   for(const event of events){if(event.type!=='repair')continue;const index=job.rows.findIndex(row=>(row.planId+':'+row.index)===event.key);if(index>=0){if(event.row?.status==='succeeded')job.rows.splice(index,1);else job.rows[index]={...job.rows[index],...event.row,...event.meta};}if(event.fromStatus&&event.row?.status&&event.fromStatus!==event.row.status){job.counts[event.fromStatus]=Math.max(0,(job.counts[event.fromStatus]||0)-1);job.counts[event.row.status]=(job.counts[event.row.status]||0)+1;}}
   job.progress.percent=job.progress.total?Math.floor(job.progress.completed*100/job.progress.total):100;
   if(job.state==='running'&&job.stopRequested){job.state='stopped';job.finishedAt=Date.now();}
   if(job.state==='running'&&(!recover||!job.autoRecover)){job.state='paused';job.pauseKind='restart';job.pauseReason='השרת הופעל מחדש. אפשר להמשיך בבטחה מאותה נקודה לאחר בדיקת החיבור.';job.finishedAt=null;}
  }
  backgroundJobs.set(id,job);
 }
}
function scheduleBlackIssue(id,job,key,connection,recover=false){
 const workerKey=Buffer.from(key);
 blackQueue=blackQueue.then(async()=>{
  try{
   job.state='running';
   await storeJob(id,job,workerKey);
   const result=await resolveBlackIssue({config:job.config,connection,issueId:job.issueId,recover});
   job.relationIssues=result.issues;
   job.state=result.issues.some(issue=>issue.kind==='technical_failure')?'needs_attention':result.issues.length?'completed_with_gaps':'done';
  }catch{
   job.state='needs_attention';
   job.error='פתרון קשרי התקלה נכשל. יש לבדוק את החיבור והמיפוי.';
  }finally{
   job.finishedAt=Date.now();
   try{await storeJob(id,job,workerKey);}finally{workerKey.fill(0);}
  }
 }).catch(()=>console.error('Could not persist BLACK job',id));
}

async function blackIssueApi(req,res,url){
 if(!blackConfig)throw fail(404,'הפעולה לא נמצאה.');
 const actual=Buffer.from(req.headers.authorization||'');
 const expected=Buffer.from('Bearer '+blackToken);
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw fail(401,'נדרש אימות שירות.');
 if(req.method!=='POST'||req.headers['content-type']?.split(';')[0]!=='application/json'){
  throw fail(400,'נדרשת בקשת JSON.');
 }
 const body=await bodyOf(req);
 if(url==='/api/issues/status'){
  const job=backgroundJobs.get(body.jobId);
  if(job?.type!=='black_issue')throw fail(404,'משימת התקלה לא נמצאה.');
  return send(res,200,{state:job.state,issues:job.relationIssues,error:job.error});
 }
 if(typeof body.issueId!=='string'||! /^[A-Za-z0-9_-]{1,160}$/.test(body.issueId))throw fail(422,'מזהה תקלה לא תקין.');
 const existing=[...backgroundJobs].find(([,job])=>job.type==='black_issue'&&
  job.state==='queued'&&job.issueId===body.issueId&&job.connectionId===blackConfig.connectionId);
 if(existing)return send(res,202,{jobId:existing[0],state:'queued'});
 const key=await loadRecoveryKey(directory,serviceKey);
 if(!key)throw fail(503,'נדרשת פתיחה ראשונה של הכספת להפעלת שירות התקלות.');
 try{
  const vault=decrypt(await envelope(),key);
  const connection=vault.connections.find(connection=>connection.id===blackConfig.connectionId);
  if(!connection)throw fail(503,'חיבור BLACK אינו זמין.');
  const jobId=randomUUID(),job={type:'black_issue',state:'queued',issueId:body.issueId,
   connectionId:connection.id,connectionVersion:connection.updatedAt,config:blackConfig,createdAt:Date.now()};
  await storeJob(jobId,job,key);
  backgroundJobs.set(jobId,job);
  scheduleBlackIssue(jobId,job,key,connection);
  return send(res,202,{jobId,state:'queued'});
 }finally{key.fill(0);}
}

async function recoverBackgroundImports(){
 if(!serviceKey)return;
 const key=await loadRecoveryKey(directory,serviceKey);
 if(!key)return;
 try{
  const storedVault=await envelope();
  const data=decrypt(storedVault,key);
  await hydrateDurable({key},{recover:true});
  for(const [id,job] of backgroundJobs){
   if(job.type==='black_issue'&&['queued','running'].includes(job.state)){
    const target=data.connections.find(c=>c.id===job.connectionId&&c.updatedAt===job.connectionVersion);
    if(blackConfig?.connectionId===job.connectionId&&target&&
       JSON.stringify(blackConfig)===JSON.stringify(job.config)){
     const interrupted=job.state==='running';
     job.state='queued';
     scheduleBlackIssue(id,job,key,target,interrupted);
    }else{
     job.state='needs_attention';
     job.error='הגדרת BLACK או החיבור המקורי השתנו.';
     await storeJob(id,job,key);
    }
   }
   if(job.type!=='import_run')continue;
   if(job.pendingRelationRepair){
    const target=data.connections.find(c=>c.id===job.connectionId&&c.updatedAt===job.connectionVersion);
    if(target&&runtimeInputs.has(job.inputId)&&job.planIds.every(planId=>runtimePlans.has(planId))){
     scheduleRelationRepair(id,job,target,key);
    }
   }
   if(job.state!=='running')continue;
   const connection=data.connections.find(c=>c.id===job.connectionId);
   if(!connection||connection.updatedAt!==job.connectionVersion||
      (job.pipeline&&!runtimeInputs.has(job.inputId))||
      job.order.some(item=>!runtimePlans.has(item.planId))){
    job.state='paused';
    job.pauseKind='restart';
    job.pauseReason='נתוני המשימה או החיבור המקורי אינם זמינים להמשך אוטומטי.';
    await storeJob(id,job,key);
    continue;
   }
   const worker={key,userId:job.ownerId,data:{...data,activeId:connection.id},schemas:new Map()};
   const run=job.pipeline?runImportPipeline(id,worker):runBackgroundImport(id,worker);
   void run.catch(()=>console.error('Could not persist recovered import state',id));
  }
 }finally{key.fill(0);}
}
async function startDurableImport(id,job,s){
 if(serviceKey)await saveRecoveryKey(directory,serviceKey,s.key);
 job.autoRecover=Boolean(serviceKey);
 await storeJob(id,job,s.key);
 backgroundJobs.set(id,job);
}
async function buildImportPreparation({s,c,b,guard,onDebug,onProgress}){
 const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map();
 const prepared=await prepareImport({connection:c,mappings:b.mappings,rules:b.rules??[],schemas,guard,onDebug,onProgress});guard();
 const ids=prepared.plans.map(()=>randomUUID()),batch={nodes:new Map(),halted:false},createdAt=Date.now();
 prepared.order.forEach(item=>batch.nodes.set(item.key,{planId:ids[item.planIndex],index:item.index,dependencies:item.dependencies}));
 for(let i=0;i<prepared.plans.length;i++){const p=prepared.plans[i],plan={ownerId:s.userId,connectionId:c.id,connectionVersion:c.updatedAt,createdAt,sourceEntity:structuredClone(p.entity),entity:p.mapped,targetId:p.targetId,targetKey:p.targetKey,mapping:p.mapping,relationStaging:p.relationStaging,schema:p.schema,result:p.result,relationData:p.relationData,halted:false,batch};runtimePlans.set(ids[i],plan);await saveDurablePlan(directory,s.key,ids[i],durablePlan(plan));}
 return {plans:prepared.plans.map((p,i)=>({id:ids[i],result:p.result,sourceEntity:p.entity,targetKey:p.targetKey,mapping:p.mapping,relationStaging:p.relationStaging})),order:prepared.order.map(item=>({...item,planId:ids[item.planIndex]})),report:prepared.report};
}
async function executePlanRow(s,b,guard=()=>{}){
 const plan=runtimePlans.get(b.planId),index=b.index;
 if(!plan||plan.ownerId!==s.userId||!Number.isInteger(index)||index<0||index>=plan.entity.records.length)throw fail(422,'בדיקת הייבוא פגה או שהרשומה אינה תקינה. בצעו Dry Run חדש.');
 const c=s.data.connections.find(c=>c.id===plan.connectionId);
 if(!c||s.data.activeId!==c.id||c.updatedAt!==plan.connectionVersion)throw fail(409,'החיבור השתנה. בצעו Dry Run מחדש.');
 const id=b.planId+':'+index,outcome=id=>runtimeOutcomes.has(id)?runtimeOutcomes.get(id):s.data.importLog?.find(r=>r.id===id),previous=outcome(id);
 if(previous?.status==='pending'){
  const interrupted={...previous,status:'unknown',sent:true,stop:false,finishedAt:new Date().toISOString(),error:{message:'הכתיבה שהופסקה לא אומתה ביעד. יש לבדוק אותה במרכז התיקונים.'}};
  if(serviceKey&&s.durableJobId){
   try{
    const entity={...plan.entity,records:[plan.entity.records[index]]};
    const checked=await dryRunEntity({connection:c,entity,targetId:plan.targetId,targetKey:plan.targetKey,schema:plan.schema,relationData:plan.relationData,guard});
    const fresh=checked.rows[0];
    if(fresh.status==='skipped'&&fresh.targetId){
     interrupted.status='succeeded';
     interrupted.targetId=fresh.targetId;
     interrupted.reconciled=true;
     delete interrupted.error;
    }
   }catch{}
  }
  if(s.durableJobId){
   const progress=interrupted.status==='succeeded'&&s.recordWriteProgress?
    {type:'progress',key:id,status:'succeeded',apiRequests:1}:null;
   await finishWriteIntent(directory,s.key,s.durableJobId,id,interrupted,progress);
  }
  runtimeOutcomes.set(id,interrupted);
  return {row:interrupted,replayed:true,progressRecorded:interrupted.status==='succeeded'&&s.recordWriteProgress};
 }
 if(previous)return {row:previous,replayed:true};
 if(plan.halted||plan.batch?.halted||Date.now()-plan.createdAt>planTtl)throw fail(409,'הריצה נעצרה או שהבדיקה פגה. בדקו את הדוח לפני Dry Run חדש.');
 let planned=plan.result.rows[index];let effectiveRelationData=plan.relationData;
 if(plan.batch&&planned.status==='planned'){const item=plan.batch.nodes.get(nodeKey(plan.entity.meta.dataName,planned.sourceId)),outcomes=new Map(item.dependencies.map(key=>{const ref=plan.batch.nodes.get(key);return [key,outcome(ref?.planId+':'+ref?.index)];}));const materialized=materializeDependencies({planned,relationData:plan.relationData?.[planned.sourceId],dependencies:item.dependencies,outcomes});if(materialized.notReady)throw fail(409,'יש לבצע קודם את הרשומות הקודמות בסדר הכתיבה.');if(materialized.blocked)planned={...planned,status:'blocked',reasons:[materialized.reason]};else{planned=materialized.planned;effectiveRelationData={...plan.relationData,[planned.sourceId]:materialized.relationData};}}
 const recordKey=[plan.targetId,plan.targetKey.kind,plan.targetKey.groupId||'',plan.targetKey.fieldId||'',
  String(plan.targetKey.kind==='recordId'?planned.sourceId:planned.matchKey)];
 const key=JSON.stringify([environmentKey(c),...recordKey]),legacyKey=JSON.stringify([c.id,...recordKey]);
 if([...(s.data.importLog||[]),...[...runtimeOutcomes.values()].filter(Boolean)].some(r=>(r.conflictKey===key||r.conflictKey===legacyKey)&&r.id!==id&&['pending','unknown'].includes(r.status)))return {row:{ownerId:s.userId,id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,status:'not_sent',sent:false,stop:false,error:{message:'דולג: קיימת כתיבה קודמת עם תוצאה לא ידועה לאותו מפתח. בדקו את הרשומה ביעד לפני ניסיון ידני נוסף.'}}};
 const base={ownerId:s.userId,relationResolution:effectiveRelationData?.[plan.entity.records[index].id]??{},writePayload:planned.request.body,writePayloads:structuredClone(planned.requests??[]),sourceRecord:structuredClone(plan.sourceEntity.records[index]),sourceEntityMeta:structuredClone(plan.sourceEntity.meta),targetRecord:structuredClone(plan.entity.records[index]),targetKey:structuredClone(plan.targetKey),mapping:plan.mapping??[],id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,startedAt:new Date().toISOString()};
 const compact=row=>({ownerId:s.userId,id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,startedAt:base.startedAt,...row});
 const save=async row=>{const entry=row.status==='succeeded'?compact({
  status:row.status,targetId:row.targetId,finishedAt:row.finishedAt,sent:row.sent,
  reconciled:row.reconciled,apiRequests:row.completedRequests?.length||row.responses?.length||1
 }):row.status==='pending'&&s.durableJobId?compact(row):{...base,...row};if(s.durableJobId){
  if(row.status==='pending')await saveWriteIntent(directory,s.key,s.durableJobId,id,entry);
  else{
   const progress=row.status==='succeeded'&&s.recordWriteProgress?
    {type:'progress',key:id,status:'succeeded',apiRequests:entry.apiRequests}:null;
   await finishWriteIntent(directory,s.key,s.durableJobId,id,entry,progress);
  }
  runtimeOutcomes.set(id,entry);
  return;
 }
 runtimeOutcomes.set(id,entry);await mutateVault(s,next=>{next.importLog??=[];const i=next.importLog.findIndex(x=>x.id===id);if(row.status==='succeeded'){if(i>=0)next.importLog.splice(i,1);return;}if(i<0)next.importLog.push(entry);else next.importLog[i]=entry;});};
 let debug;const write=(r,step)=>writeSimply(c,step.operation,step.body,d=>debug=d,guard);
 const reconcile=async({completed,error})=>{
  const entity={...plan.entity,records:[plan.entity.records[index]]},checked=await dryRunEntity({connection:c,entity,targetId:plan.targetId,targetKey:plan.targetKey,schema:plan.schema,relationData:effectiveRelationData,guard,onDebug:d=>debug=d}),fresh=checked.rows[0];
  if(fresh.status==='skipped')return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:fresh.targetId||planned.targetId,status:'succeeded',sent:true,stop:false,reconciled:true,reconciliation:'הכתיבה נמצאה ביעד לאחר תשובה לא ידועה.',completedRequests:completed,warnings:planned.warnings};
  if(error.kind==='uniqueness'){
   return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,
    targetId:fresh.targetId||null,status:'failed',sent:true,stop:false,
    error:{kind:'uniqueness',message:'Origami דחתה יצירה בגלל ייחודיות. נדרשת בדיקת תוצאת ההצלבה לפני כתיבה נוספת.',details:error.details}};
  }
  return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:fresh.targetId||planned.targetId,status:'unknown',sent:true,stop:false,reconciled:false,completedRequests:completed,error:{kind:'ambiguous_write',message:'לא ניתן לאמת את הכתיבה ביעד: '+(fresh.reasons||[]).join('; '),details:error.details}};
 };
 const row=await executeRow({planned,write,recordIntent:()=>save({status:'pending',sent:true,stop:false}),recordResult:r=>save({...r,finishedAt:new Date().toISOString()}),reconcile});
 if(!row.sent)await save({...row,finishedAt:new Date().toISOString()});
 return {row:row.status==='succeeded'?compact(row):{...base,...row},debug};
}
async function runBackgroundImport(jobId,s,{finalize=true}={}){
 const job=backgroundJobs.get(jobId);if(!job||job.workerActive)return;const connection=s.data.connections.find(c=>c.id===job.connectionId);if(!connection){job.state='paused';job.pauseKind='connection';job.pauseReason='החיבור ששימש לריצה אינו זמין.';await storeJob(jobId,job,s.key);return;}
 job.workerActive=true;job.state='running';job.stopRequested=false;job.pauseKind=null;job.pauseReason=null;const worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data),durableJobId:jobId,recordWriteProgress:true},completed=new Set(job.completedKeys||[]),startedAt=Date.now();let cursor=0,checkpoint=0;
 const readyAgain=[];
 const take=()=>{while(job.state==='running'&&!job.stopRequested&&cursor<job.order.length){const item=job.order[cursor++],key=item.planId+':'+item.index;if(!completed.has(key))return {...item,key};}return job.state==='running'&&!job.stopRequested?readyAgain.shift():null;};
 const workerLoop=async()=>{for(;;){const item=take();if(!item)return;let result;try{
    const retry=job.retries?.[item.key];
    if(retry&&runtimeOutcomes.get(item.key)?.status==='deferred'){
     while(Date.now()<retry.nextAt&&job.state==='running'&&!job.stopRequested){
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,retry.nextAt-Date.now())));
     }
     if(job.state!=='running'||job.stopRequested)return;
     await appendDurableEvent(directory,worker.key,jobId,{type:'outcome-clear',id:item.key});
     runtimeOutcomes.set(item.key,undefined);
    }
    result=await executePlanRow(worker,item,()=>{});
   }catch(e){const plan=runtimePlans.get(item.planId),planned=plan?.result?.rows?.[item.index];result={row:{planId:item.planId,index:item.index,entityName:plan?.result?.name,targetEntity:plan?.targetId,sourceId:planned?.sourceId,action:planned?.action,status:'not_sent',sent:false,stop:false,error:{message:e.message}}};}const row=result.row;
   if(job.autoRecover&&row.status==='deferred'&&!row.partial&&row.error?.kind==='rate_limit'){
    const retry=job.retries?.[item.key]||{attempt:0};
    if(retry.attempt<3){
     retry.attempt++;
     retry.nextAt=Date.now()+1000*2**retry.attempt;
     job.retries??={};
     job.retries[item.key]=retry;
     await appendDurableEvent(directory,worker.key,jobId,{type:'retry',key:item.key,retry});
     readyAgain.push(item);
     continue;
    }
   }
   if(row.status==='deferred'||(row.stop&&['rate_limit','authorization','system'].includes(row.error?.kind))){job.state='paused';job.pauseKind=row.error?.kind||'temporary';job.pauseReason=row.error?.message||'הריצה הושהתה עקב תקלה זמנית.';job.lastDeferred={...row,planId:item.planId,index:item.index};await appendDurableEvent(directory,worker.key,jobId,{type:'pause',key:item.key,kind:job.pauseKind,reason:job.pauseReason,at:new Date().toISOString()});return;}
   completed.add(item.key);(job.completedKeys??=[]).push(item.key);job.counts[row.status]=(job.counts[row.status]||0)+1;if(row.status!=='succeeded')job.rows.push({...row,planId:item.planId,index:item.index});const apiRequests=row.sent===false?0:Math.max(1,row.apiRequests||row.completedRequests?.length||row.responses?.length||0);if(row.status!=='succeeded'||(result.replayed&&!result.progressRecorded))await appendDurableEvent(directory,worker.key,jobId,{
    type:'progress',key:item.key,status:row.status,apiRequests,...(row.status==='succeeded'?{}:{row:{...row,planId:item.planId,index:item.index}})
   });
   const done=completed.size,elapsed=Math.max(1,(Date.now()-startedAt)/1000),remaining=Math.max(0,job.order.length-done),observed=done?Math.ceil(remaining/(done/elapsed)):0;job.rateLimit=rateSnapshot(connection);job.progress={...job.progress,completed:done,percent:job.order.length?Math.floor(done*100/job.order.length):100,etaSeconds:Math.max(observed,rateEtaSeconds(job.rateLimit,Math.max(remaining,job.progress.apiRequestsTotal-(job.progress.apiRequestsCompleted+apiRequests)))),apiRequestsCompleted:job.progress.apiRequestsCompleted+apiRequests,lastProgressAt:Date.now()};checkpoint++;if(checkpoint>=100){checkpoint=0;await storeJob(jobId,job,worker.key);}
  }};
 try{const concurrency=Math.min(Math.max(1,job.order.length-completed.size),connection.maxConcurrentRequests||3);await Promise.all(Array.from({length:concurrency},workerLoop));if(finalize&&job.state==='running')job.state=job.stopRequested?'stopped':'done';if(finalize&&job.state==='done')job.progress={...job.progress,percent:100,etaSeconds:0};if(finalize&&job.state!=='paused')job.finishedAt=Date.now();await storeJob(jobId,job,worker.key);}catch(e){job.state='paused';job.pauseKind='system';job.pauseReason=e.message||'הריצה הושהתה עקב תקלה פנימית.';await storeJob(jobId,job,worker.key);}finally{job.workerActive=false;worker.key.fill(0);}
}
function issueGroupKey(issue){return JSON.stringify([issue.kind,issue.entity,issue.fieldId,issue.sourceEntity,issue.role,issue.message]);}
const relationRepairWorkers=new Set();

function hasImportGaps(job){
 return Boolean(job.relationIssues?.length||['failed','blocked','unknown','not_sent'].some(status=>job.counts?.[status]>0));
}

function replaceRelationIssues(job,event){
 const retried=new Set(event.retried);
 if(job.pendingRelationRepair?.id===event.commandId){
  job.pendingRelationRepair.next=Math.max(job.pendingRelationRepair.next,event.next);
 }
 if(event.choices)job.relationChoices={...job.relationChoices,...event.choices};
 for(const rule of event.mappingOverride||[]){
  job.relationRuleOverrides??={};
  job.relationRuleOverrides[JSON.stringify([rule.sourceEntity,rule.groupId,rule.fieldId])]=rule;
 }
 job.relationIssues=job.relationIssues.filter(issue=>
  issueGroupKey(issue)!==event.group||!retried.has(issue.cursor)
 );
 job.relationIssues.push(...event.issues);
 if(['done','completed_with_gaps'].includes(job.state)){
  job.state=hasImportGaps(job)?'completed_with_gaps':'done';
 }
}

function scheduleRelationRepair(jobId,job,connection,key){
 if(relationRepairWorkers.has(jobId))return;
 relationRepairWorkers.add(jobId);
 void retryRelationGroup(jobId,job,job.pendingRelationRepair,connection,Buffer.from(key))
  .catch(()=>console.error('Relation retry interrupted',jobId));
}

async function retryRelationGroup(jobId,job,command,connection,key){
 const {group,items,choices,rules,mappingOverride,actor}=command;
 try{
  const input=runtimeInputs.get(job.inputId);
  const identities=indexImportIdentities(job.planIds.map(id=>[id,runtimePlans.get(id)]),runtimeOutcomes);
  const finalize=createRelationFinalizer({connection,rules,identities,schemas:new Map(input.schemas)});
  for(let index=command.next;index<items.length;index++){
   const item=items[index];
   const {planId,sourceId,entity,fieldId,cursor}=item;
   const plan=runtimePlans.get(planId);
   const record=plan.entity.records.find(record=>record.id===sourceId);
   const staging=plan.relationStaging;
   const envelope=JSON.parse(record.data[staging.groupId][0][staging.fieldId]);
   if(fieldId)envelope.relations=envelope.relations.filter(entry=>entry.target.fieldId===fieldId);
   const target=identities.get(JSON.stringify([plan.sourceEntity.meta.dataName,entity,sourceId]));
   if(!target?.id)continue;
   const problems=await finalize({envelope,entity,id:target.id,schema:plan.schema,indexes:record.groupIndexes,recover:true,choices:{...job.relationChoices,...choices}});
   const event={type:'relation-repair',commandId:command.id,next:index+1,group,retried:[cursor],actor,choices,mappingOverride,mapping:rules.filter(rule=>rule.sourceEntity===plan.sourceEntity.meta.dataName&&(!fieldId||rule.fieldId===fieldId)),at:new Date().toISOString(),
    issues:problems.map(problem=>({...problem,entity,sourceId,sourceEntity:plan.sourceEntity.meta.dataName,planId,cursor}))};
   await appendDurableEvent(directory,key,jobId,event);
   replaceRelationIssues(job,event);
  }
  await appendDurableEvent(directory,key,jobId,{type:'relation-repair-finished',id:command.id});
  job.pendingRelationRepair=null;
  await storeJob(jobId,job,key);
 }finally{
  key.fill(0);
  relationRepairWorkers.delete(jobId);
 }
}

function reportPipelineProgress(job,active){
 const progress={...job.progress};
 const records=Number(progress.checkTotal)||0;
 const checked=Number(progress.checked)||0;
 const written=(Number(progress.completed)||0)+(job.counts.skipped||0);
 const links=Number(job.relationCompleted)||0;
 const relationTotal=Number(progress.relationsTotal)||0;
 const expected=records*2+relationTotal;
 const completed=checked+written+links;
 const elapsed=(Date.now()-Date.parse(job.startedAt))/1000;
 progress.overallPercent=progress.phase==='complete'?100:expected?
  Math.min(99,Math.floor(100*completed/expected)):0;
 progress.overallEtaSeconds=completed>=3&&elapsed>0?
  Math.ceil(Math.max(0,expected-completed)/completed*elapsed):null;
 progress.activity=active?'active':job.state==='running'?'stalled':job.state;
 return progress;
}

function pipelineRelationWorker(jobId,job,worker,input){
 const identities=new Map(),tasks=new Map(),waiting=new Map(),ready=[];
 const completed=completedRelationTasks.get(jobId)||new Set();
 completedRelationTasks.set(jobId,completed);
 const cache=jobRelationCache.get(jobId)||new Map();
 jobRelationCache.set(jobId,cache);
 const connection=worker.data.connections.find(c=>c.id===job.connectionId);
 const finalize=createRelationFinalizer({connection,rules:input.finalizerRules,identities,schemas:new Map(input.schemas),cache,
  onCache:(key,candidates)=>appendDurableEvent(directory,worker.key,'cache-'+jobId,{type:'relation-cache',key,candidates})
 });
 const remaining=new Map();
 const sourceDependency=name=>JSON.stringify(['source',name]);
 const targetDependency=name=>JSON.stringify(['target',name]);
 const batchDependencies=batch=>[sourceDependency(batch.entity.meta.dataName),targetDependency(batch.targetId)];
 for(const batch of input.batches){
  for(const key of batchDependencies(batch))remaining.set(key,(remaining.get(key)||0)+1);
 }
 const relationsTotal=input.batches.reduce((total,batch)=>total+(batch.relationStaging?batch.entity.records.length:0),0);
 job.progress.relationsTotal=relationsTotal;
 const rules=new Map(input.finalizerRules.map(rule=>[
  JSON.stringify([rule.sourceEntity,rule.groupId,rule.fieldId]),rule
 ]));
 let previousAt=Date.now(),rate=0;
 const register=index=>{
  const planId=job.planIds[index],plan=runtimePlans.get(planId);
  if(!plan)throw Error('תוכנית הייבוא הדרושה להשלמת קישורים אינה זמינה.');
  for(const [key,value] of indexImportIdentities([[planId,plan]],runtimeOutcomes))identities.set(key,value);
  const source=plan.sourceEntity.meta.dataName;
  for(const dependency of batchDependencies(input.batches[index])){
   remaining.set(dependency,remaining.get(dependency)-1);
   if(remaining.get(dependency)!==0)continue;
   for(const task of waiting.get(dependency)||[]){
    task.dependencies.delete(dependency);
    if(!task.dependencies.size)ready.push(task);
   }
   waiting.delete(dependency);
  }
  if(!plan.relationStaging)return;
  const {groupId,fieldId}=plan.relationStaging;
  for(const [recordIndex,record] of plan.entity.records.entries()){
   const taskId=planId+':'+recordIndex;
   if(completed.has(taskId))continue;
   const envelope=JSON.parse(record.data[groupId]?.[0]?.[fieldId]??'{"relations":[]}');
   const dependencies=new Set();
   for(const relation of envelope.relations){
    const rule=rules.get(JSON.stringify([source,relation.target.groupId,relation.target.fieldId]));
    const value=relation.source.value;
    if(!rule||value===''||value===null||(Array.isArray(value)&&!value.length))continue;
    for(const dependency of [sourceDependency(rule.sourceRelatedEntity),targetDependency(rule.targetEntity)]){
     if(remaining.get(dependency)>0)dependencies.add(dependency);
    }
   }
   const task={taskId,planId,plan,record,envelope,dependencies};
   tasks.set(taskId,task);
   for(const dependency of dependencies){
    if(!waiting.has(dependency))waiting.set(dependency,[]);
    waiting.get(dependency).push(task);
   }
   if(!dependencies.size)ready.push(task);
  }
 };
 const drain=async()=>{
  if(job.stopRequested||(!ready.length&&!job.relationInFlight))return;
  const interrupted=tasks.get(job.relationInFlight);
  if(interrupted&&!interrupted.dependencies.size)ready.unshift(interrupted);
  job.progress.phase='relations';
  for(const {taskId,planId,plan,record,envelope} of ready){
   if(job.stopRequested)break;
   if(completed.has(taskId))continue;
   const identity=JSON.stringify([plan.sourceEntity.meta.dataName,plan.targetId,record.id]);
   const id=identities.get(identity)?.id;
   let problems=[];
   if(envelope.relations.length&&id){
    const recover=job.relationInFlight===taskId;
    if(!recover){
     await appendDurableEvent(directory,worker.key,jobId,{type:'relation-intent',cursor:taskId});
     job.relationInFlight=taskId;
    }
    problems=await finalize({envelope,entity:plan.targetId,id,schema:plan.schema,indexes:record.groupIndexes,recover});
   }else if(envelope.relations.length)problems=[{kind:'needs_attention',message:'רשומת הייבוא אינה זמינה להשלמת קישורים.'}];
   const issues=problems.map(problem=>({...problem,entity:plan.targetId,sourceId:record.id,sourceEntity:plan.sourceEntity.meta.dataName,planId,cursor:taskId}));
   await appendDurableEvent(directory,worker.key,jobId,{type:'relation-progress',taskId,issues});
   job.relationInFlight=null;
   completed.add(taskId);
   tasks.delete(taskId);
   job.relationCompleted=completed.size;
   const now=Date.now(),sample=1000/Math.max(1,now-previousAt);
   rate=rate?0.85*rate+0.15*sample:sample;
   previousAt=now;
   job.progress.relationEtaSeconds=completed.size>=3?Math.ceil((job.progress.relationsTotal-completed.size)/rate):null;
   job.progress.lastProgressAt=now;
   if(issues.length)(job.relationIssues??=[]).push(...issues);
  }
  ready.length=0;
 };
 return {register,drain};
}
async function runImportPipeline(jobId,s){
 const job=backgroundJobs.get(jobId),input=job&&runtimeInputs.get(job.inputId);if(!job||!input||job.pipelineWorkerActive)return;job.pipelineWorkerActive=true;const worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data),schemas:new Map(s.schemas)};worker.schemas.set(job.connectionId+':'+job.connectionVersion,new Map(input.schemas||[]));try{
  const relations=input.finalizerRules?pipelineRelationWorker(jobId,job,worker,input):null;
  if(relations){
   for(let index=0;index<job.nextBatch;index++)relations.register(index);
   await relations.drain();
  }
  while(job.nextBatch<input.batches.length&&job.state==='running'&&!job.stopRequested){
   const mapping=input.batches[job.nextBatch],connection=worker.data.connections.find(c=>c.id===job.connectionId);if(!connection)throw Error('חיבור היעד אינו זמין.');
   if(job.preparedBatch!==job.nextBatch){job.progress.phase='checking';job.progress.activeBatch=job.nextBatch+1;await storeJob(jobId,job,worker.key);const prepared=await buildImportPreparation({s:worker,c:connection,b:{schemaVersion:input.schemaVersion,mappings:[mapping],rules:input.rules||[]},guard:()=>{},onDebug:d=>job.debug=d,onProgress:p=>{job.progress.checked=job.checkedBeforeBatch+Number(p.records||0);}});job.planIds.push(...prepared.plans.map(p=>p.id));job.order.push(...prepared.order.map(({planId,index})=>({planId,index})));job.progress.checked=job.checkedBeforeBatch+mapping.entity.records.length;job.checkedBeforeBatch=job.progress.checked;job.baseProgress.checked=job.progress.checked;job.baseProgress.total=job.order.length;job.baseProgress.apiRequestsTotal=job.order.reduce((sum,item)=>sum+(runtimePlans.get(item.planId)?.result?.rows?.[item.index]?.requests?.length||1),0);job.progress.total=job.baseProgress.total;job.progress.apiRequestsTotal=job.baseProgress.apiRequestsTotal;const rows=prepared.plans.flatMap(p=>p.result.rows);job.baseCounts.input+=rows.length;job.baseCounts.planned+=prepared.order.length;job.baseCounts.skipped+=rows.filter(r=>r.status==='skipped').length;job.baseCounts.blocked+=rows.filter(r=>r.status==='blocked').length;for(const key of ['input','planned','skipped','blocked'])job.counts[key]=job.baseCounts[key];job.preparedBatch=job.nextBatch;job.progress.phase='writing';await storeJob(jobId,job,worker.key);}
   await runBackgroundImport(jobId,worker,{finalize:false});
   if(job.state!=='running'||job.stopRequested)break;
   relations?.register(job.nextBatch);
   job.nextBatch++;
   job.preparedBatch=null;
   await storeJob(jobId,job,worker.key);
   await relations?.drain();
  }
  if(job.state==='running'){job.state=job.stopRequested?'stopped':hasImportGaps(job)?'completed_with_gaps':'done';job.progress={...job.progress,phase:'complete',percent:100,etaSeconds:0};job.finishedAt=Date.now();}await storeJob(jobId,job,worker.key);
 }catch(error){job.state='paused';job.pauseKind='system';job.pauseReason=error.message||'התהליך הושהה.';await storeJob(jobId,job,worker.key);}finally{job.pipelineWorkerActive=false;worker.key.fill(0);}
}
const dryGroupPrefix='dry-group:';
function dryGroup(ownerId,transferId){
 const history=[...backgroundJobs.entries()].filter(([,job])=>job.ownerId===ownerId&&job.type==='import_prepare'&&job.transferId===transferId);
 if(!history.length)return null;
 const latest=new Map();for(const member of history){const index=Number(member[1].batchIndex)||0,current=latest.get(index);if(!current||Number(member[1].createdAt)>=Number(current[1].createdAt))latest.set(index,member);}const members=[...latest.values()];
 const jobs=members.map(([,job])=>job),failed=jobs.some(job=>job.state==='error'),batchesTotal=Math.max(1,...jobs.map(job=>Number(job.batchCount)||1)),allBatchesRegistered=jobs.length>=batchesTotal,running=!failed&&(jobs.some(job=>job.state==='running')||!allBatchesRegistered),doneRecords=jobs.filter(job=>job.state==='done').reduce((sum,job)=>sum+Number(job.batchRecords||0),0),activeRecords=jobs.filter(job=>job.state==='running').reduce((sum,job)=>sum+Math.min(Number(job.batchRecords||0),Number(job.progress?.records||0)),0),total=Number(jobs[0].totalRecords)||jobs.reduce((sum,job)=>sum+Number(job.batchRecords||0),0),completed=Math.min(total,doneRecords+activeRecords),percent=total?Math.floor(completed*100/total):(running?0:100),errors=jobs.filter(job=>job.error).map(job=>job.error);
 const activeEtas=jobs.filter(job=>job.state==='running'&&Number.isFinite(job.progress?.etaSeconds)).map(job=>Number(job.progress.etaSeconds)),etaSeconds=running?(activeEtas.length?Math.max(...activeEtas):null):0;
 return {id:dryGroupPrefix+transferId,type:'import_prepare',state:failed?'error':running?'running':'done',connectionId:jobs[0].connectionId,connectionName:jobs[0].connectionName,label:jobs[0].label||jobs[0].fileName||'Dry Run',fileName:jobs[0].fileName||'',fileSize:Number(jobs[0].fileSize)||0,createdAt:Math.min(...jobs.map(job=>job.createdAt)),startedAt:jobs.map(job=>job.startedAt).sort()[0],finishedAt:running?null:Math.max(...jobs.map(job=>Number(job.finishedAt)||0)),progress:{completed,total,percent,etaSeconds,batchesCompleted:jobs.filter(job=>job.state==='done').length,batchesTotal},error:errors.join(' | ')||null,members};
}
function refreshJobRate(job,connections=[]){
 if(job?.state!=='running')return;const connection=connections.find(c=>c.id===job.connectionId);if(!connection)return;
 const progress=job.progress||{},completed=Number(progress.completed??progress.records??0),total=Number(progress.total??job.totalRecords??job.batchRecords),elapsed=Math.max(1,(Date.now()-Number(job.createdAt||Date.parse(job.startedAt)))/1000),observed=Number.isFinite(total)&&completed>0?Math.ceil(Math.max(0,total-completed)/(completed/elapsed)):0;
 job.rateLimit=rateSnapshot(connection);let remaining=0;if(job.type==='export'&&Number.isFinite(total))remaining=Math.ceil(Math.max(0,total-completed)/Math.max(1,Number(progress.pageSize)||500));else if(job.type==='import_run')remaining=Math.max(0,(Number(progress.apiRequestsTotal)||Number(total)||0)-(Number(progress.apiRequestsCompleted)||completed));else if(Number.isFinite(total))remaining=Math.max(0,total-completed);
 job.progress={...progress,etaSeconds:Math.max(observed,rateEtaSeconds(job.rateLimit,remaining))};
}
function jobOverview(ownerId,connections){
 const grouped=new Map(),plain=[];
 for(const [id,job] of backgroundJobs){if(job.ownerId!==ownerId)continue;refreshJobRate(job,connections);if(job.type==='import_prepare'&&job.transferId){if(!grouped.has(job.transferId))grouped.set(job.transferId,dryGroup(ownerId,job.transferId));}else plain.push({id,...job});}
 return [...plain,...grouped.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(job=>({id:job.id,type:job.type,state:job.state,connectionId:job.connectionId,connectionName:job.connectionName,label:job.label,fileName:job.fileName,fileSize:job.fileSize,createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,progress:job.progress,counts:job.counts,error:job.error,rateLimit:job.rateLimit}));
}
function completedDryRecovery(ownerId,transferId){
 const group=dryGroup(ownerId,transferId);if(!group)return null;
 const members=group.members.map(([,job])=>job).filter(job=>job.state==='done'&&job.result).sort((a,b)=>(Number(a.batchIndex)||0)-(Number(b.batchIndex)||0));
 const plans=members.flatMap(job=>job.result.plans||[]),order=members.flatMap(job=>job.result.order||[]),report={};
 for(const job of members)for(const [key,value]of Object.entries(job.result.report||{}))if(typeof value==='number')report[key]=(report[key]||0)+value;
 const planIds=plans.map(plan=>plan.id),canRun=group.state==='done'&&order.length>0&&planIds.every(id=>runtimePlans.has(id));
 const createdAt=planIds.map(id=>runtimePlans.get(id)?.createdAt).filter(Number.isFinite);
 return {plans,order,report,canRun,expiresAt:createdAt.length?new Date(Math.min(...createdAt)+planTtl).toISOString():null};
}
function artifactFor(ownerId,id,failedOnly=false){
 if(String(id).startsWith(dryGroupPrefix)){
  const transferId=String(id).slice(dryGroupPrefix.length),group=dryGroup(ownerId,transferId),recovery=completedDryRecovery(ownerId,transferId);if(!group)throw fail(404,'התהליך לא נמצא.');
  return {fileName:'simply-dry-run-report.json',value:{mode:'Dry Run',createdAt:new Date().toISOString(),job:{id:group.id,state:group.state,progress:group.progress,error:group.error},results:(recovery?.plans||[]).map(plan=>plan.result),writeOrder:recovery?.order||[],relations:recovery?.report||{}}};
 }
 const job=backgroundJobs.get(id);if(!job||job.ownerId!==ownerId)throw fail(404,'התהליך לא נמצא.');
 if(job.type==='export'){
  const entity=job.result?.entity,meta=job.result?.meta;if(!entity||!meta)throw fail(409,'תוצאת הייצוא אינה זמינה.');const entityId=entity.meta?.dataName||'entity';
  return {fileName:'simply-recovered-'+entityId+'.json',value:{meta,entities:{[entityId]:entity}},hasConflicts:!!entity.conflicts?.length};
 }
 const rows=job.rows||[],selected=failedOnly?rows.filter(row=>row.status!=='succeeded'):rows;
 return {fileName:failedOnly?'simply-run-errors.json':'simply-run-report.json',value:{mode:'RUN',createdAt:new Date().toISOString(),job:{id,state:job.state,connectionName:job.connectionName,label:job.label,startedAt:job.startedAt,finishedAt:job.finishedAt,progress:job.progress,counts:job.counts,error:job.error,rateLimit:job.rateLimit},writeResults:selected}};
}
function repairIssues(s,{reportedOnly=false,status='',connectionId='',entity=''}={}){const issues=[];for(const [jobId,job] of backgroundJobs){if(job.type!=='import_run'||(s.role!=='admin'&&job.ownerId!==s.userId))continue;if(connectionId&&job.connectionId!==connectionId)continue;for(const row of job.rows||[]){if(row.status==='succeeded')continue;if(reportedOnly&&!row.reportedAt)continue;if(status&&row.repairStatus!==status&&row.status!==status)continue;if(entity&&row.targetEntity!==entity&&row.entityName!==entity)continue;issues.push({issueId:jobId+'|'+row.planId+':'+row.index,jobId,key:row.planId+':'+row.index,ownerId:job.ownerId,username:job.username,connectionId:job.connectionId,connectionName:job.connectionName,jobLabel:job.label,jobStartedAt:job.startedAt,...row});}}return issues.sort((a,b)=>Date.parse(b.reportedAt||b.finishedAt||b.jobStartedAt)-Date.parse(a.reportedAt||a.finishedAt||a.jobStartedAt));}
function findRepairIssue(s,issueId){const split=String(issueId||'').indexOf('|');if(split<1)throw fail(422,'מזהה התקלה אינו תקין.');const jobId=issueId.slice(0,split),key=issueId.slice(split+1),job=backgroundJobs.get(jobId);if(!job||job.type!=='import_run'||(s.role!=='admin'&&job.ownerId!==s.userId))throw fail(404,'התקלה לא נמצאה.');const row=job.rows.find(item=>(item.planId+':'+item.index)===key);if(!row)throw fail(404,'התקלה לא נמצאה.');return {jobId,key,job,row};}
async function api(req,res,url){
 const method=req.method;
 if(['/api/issues/resolve','/api/issues/status'].includes(url))return blackIssueApi(req,res,url);
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
  failures=0;const current={key,salt,data,username:user.username,userId:user.id,role:user.role,schemas:new Map(),plans:new Map(),runOutcomes:new Map(),exports:new Map(),imports:new Map(),token:randomBytes(32).toString('hex'),last:Date.now()};await hydrateDurable(current);if(blackConfig&&current.role==='admin')await saveRecoveryKey(directory,serviceKey,key);sessions.set(current.token,current);
  return send(res,200,publicData(current),{'Set-Cookie':`${cookieName}=${current.token}; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}`});
 }
 const s=auth(req,url!=='/api/jobs');
 if(url==='/api/lock'&&method==='POST'){clear(s);return send(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}; Max-Age=0`});}
 if(url==='/api/jobs'&&method==='GET')return send(res,200,{jobs:jobOverview(s.userId,s.data.connections),expiresAt:s.last+ttl});
 if(url==='/api/jobs/detail'&&method==='POST'){const b=await bodyOf(req);if(String(b.jobId).startsWith(dryGroupPrefix)){const transferId=String(b.jobId).slice(dryGroupPrefix.length),group=dryGroup(s.userId,transferId);if(!group)throw fail(404,'התהליך לא נמצא.');return send(res,200,{job:{...group,members:undefined,recovery:completedDryRecovery(s.userId,transferId),rows:group.members.filter(([,job])=>job.error).map(([,job])=>({status:'failed',sourceId:'אצווה '+(Number(job.batchIndex)+1),error:{message:job.error}}))},expiresAt:s.last+ttl});}const job=backgroundJobs.get(b.jobId);if(!job||job.ownerId!==s.userId)throw fail(404,'התהליך לא נמצא.');const problems=(job.rows||[]).filter(row=>row.status!=='succeeded');return send(res,200,{job:{...job,key:undefined,rows:problems.slice(-500),hasMoreRows:problems.length>500},expiresAt:s.last+ttl});}
 if(url==='/api/jobs/artifact'&&method==='POST'){const b=await bodyOf(req),artifact=artifactFor(s.userId,b.jobId,!!b.failedOnly);return send(res,200,{...artifact,expiresAt:s.last+ttl});}
 if(url==='/api/jobs/delete'&&method==='POST'){const b=await bodyOf(req);if(String(b.jobId).startsWith(dryGroupPrefix)){const group=dryGroup(s.userId,String(b.jobId).slice(dryGroupPrefix.length));if(!group)throw fail(404,'התהליך לא נמצא.');if(group.state==='running')throw fail(409,'יש להמתין לסיום התהליך לפני מחיקתו.');for(const [id] of group.members){const member=backgroundJobs.get(id);backgroundJobs.delete(id);jobRelationCache.delete(id);completedRelationTasks.delete(id);await deleteDurableJob(directory,'cache-'+id);await deleteDurableJob(directory,id);if(member?.inputId){runtimeInputs.delete(member.inputId);await deleteDurablePayload(directory,member.inputId);}}return send(res,200,{ok:true,expiresAt:s.last+ttl});}const job=backgroundJobs.get(b.jobId);if(!job||job.ownerId!==s.userId)throw fail(404,'התהליך לא נמצא.');if(job.state==='running'||relationRepairWorkers.has(b.jobId))throw fail(409,'יש לעצור את התהליך לפני מחיקתו.');backgroundJobs.delete(b.jobId);jobRelationCache.delete(b.jobId);completedRelationTasks.delete(b.jobId);await deleteDurableJob(directory,'cache-'+b.jobId);await deleteDurableJob(directory,b.jobId);if(job.inputId){runtimeInputs.delete(job.inputId);await deleteDurablePayload(directory,job.inputId);}return send(res,200,{ok:true,expiresAt:s.last+ttl});}
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
 if(url==='/api/jobs/close-relations'&&method==='POST'){
  const {jobId}=await bodyOf(req),job=backgroundJobs.get(jobId);
  if(!job||job.type!=='import_run'||(s.role!=='admin'&&job.ownerId!==s.userId)){
   throw fail(404,'המשימה לא נמצאה.');
  }
  if(job.relationsClosedAt)return send(res,200,{ok:true,expiresAt:s.last+ttl});
  if(job.pendingRelationRepair||relationRepairWorkers.has(jobId)||!['done','completed_with_gaps'].includes(job.state)){
   throw fail(409,'ניתן לסגור משימה לאחר סיום העיבוד.');
  }
  if(job.relationIssues?.length&&s.role!=='admin')throw fail(403,'סגירה עם חריגים דורשת מנהל.');
  const at=new Date().toISOString();
  await appendDurableEvent(directory,s.key,jobId,{type:'relation-close',at,actor:s.userId});
  job.relationsClosedAt=at;
  jobRelationCache.delete(jobId);
  await deleteDurableJob(directory,'cache-'+jobId);
  return send(res,200,{ok:true,expiresAt:s.last+ttl});
 }
 if(url==='/api/repairs/retry-relations'&&method==='POST'){
  if(s.role!=='admin')throw fail(403,'הפעולה זמינה למנהל בלבד.');
  const {jobId,groupId,matchKey,targetId,mapping}=await bodyOf(req),job=backgroundJobs.get(jobId);
  if(!job||job.relationsClosedAt||job.pendingRelationRepair||!['running','done','completed_with_gaps'].includes(job.state)||relationRepairWorkers.has(jobId)){
   throw fail(409,'המשימה אינה זמינה לניסיון חוזר.');
  }
  const connection=s.data.connections.find(c=>c.id===job.connectionId&&c.updatedAt===job.connectionVersion);
  const input=runtimeInputs.get(job.inputId);
  if(!connection||!input?.finalizerRules||job.planIds.some(id=>!runtimePlans.has(id))){
   throw fail(409,'תוכנית הקישורים או החיבור המקורי אינם זמינים.');
  }
  let matching=job.relationIssues.filter(issue=>issue.planId&&issueGroupKey(issue)===groupId);
  let choices;
  if(targetId!==undefined){
   matching=matching.filter(issue=>issue.matchKey===matchKey&&issue.options?.includes(targetId));
   choices={[matchKey]:targetId};
  }
  const items=[...new Map(matching.map(issue=>[issue.cursor,issue])).values()];
  if(!items.length)throw fail(404,'קבוצת החריגים או רשומת היעד לא נמצאו.');
  const keyOf=rule=>JSON.stringify([rule.sourceEntity,rule.groupId,rule.fieldId]);
  const rulesByKey=new Map((relationRules.get(job.connectionId)||input.finalizerRules).map(rule=>[keyOf(rule),rule]));
  for(const rule of Object.values(job.relationRuleOverrides||{}))rulesByKey.set(keyOf(rule),rule);
  let mappingOverride;
  if(mapping!==undefined){
   if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw fail(422,'פרטי מיפוי הקישור אינם תקינים.');
   const item=items[0],plan=runtimePlans.get(item.planId);
   const fieldGroup=plan.schema.groups.find(group=>group.fields.some(field=>field.id===item.fieldId));
   if(!fieldGroup||items.some(other=>other.sourceEntity!==item.sourceEntity||other.fieldId!==item.fieldId)){
    throw fail(422,'בחרו קבוצת חריגים של שדה קישור יחיד.');
   }
   const rule={sourceEntity:plan.sourceEntity.meta.dataName,groupId:fieldGroup.id,fieldId:item.fieldId,
    sourceRelatedEntity:mapping.sourceRelatedEntity,targetEntity:mapping.targetEntity,valueMode:mapping.valueMode,
    targetKey:{kind:'field',groupId:mapping.targetGroup,fieldId:mapping.targetField}};
   try{validateRelationRuleSets({rules:[rule]});}
   catch{throw fail(422,'פרטי מיפוי הקישור אינם תקינים.');}
   const targetSchema=normalizeStructure(await readOrigami(connection,'entity_structure',{entity_data_name:rule.targetEntity}));
   checkKey(targetSchema,rule.targetKey);
   rulesByKey.set(keyOf(rule),rule);
   mappingOverride=[rule];
  }
  const rules=[...rulesByKey.values()];
  const command={id:randomUUID(),next:0,group:groupId,items,choices,rules,mappingOverride,actor:s.userId};
  await appendDurableEvent(directory,s.key,jobId,{type:'relation-repair-queued',command});
  job.pendingRelationRepair=command;
  scheduleRelationRepair(jobId,job,connection,s.key);
  return send(res,202,{scheduled:items.length,expiresAt:s.last+ttl});
 }
 if(url==='/api/repairs/groups'&&method==='POST'){
  if(s.role!=='admin')throw fail(403,'הפעולה זמינה למנהל בלבד.');
  const groups=new Map();
  const add=(jobId,issue)=>{
   const groupId=issueGroupKey(issue),key=JSON.stringify([jobId,groupId]);
   if(!groups.has(key))groups.set(key,{jobId,groupId,...issue,count:0,records:[],
    canRetry:!!issue.planId&&!backgroundJobs.get(jobId)?.pendingRelationRepair&&!backgroundJobs.get(jobId)?.relationsClosedAt&&['running','done','completed_with_gaps'].includes(backgroundJobs.get(jobId)?.state),
    retryActive:relationRepairWorkers.has(jobId),matches:[],canMap:!!issue.fieldId&&!!issue.planId});
   const group=groups.get(key);
   group.count++;
   if(issue.matchKey&&group.matches.length<50&&!group.matches.some(match=>match.key===issue.matchKey)){
    group.matches.push({key:issue.matchKey,value:issue.originalValue,options:issue.options});
   }
   if(issue.sourceId&&group.records.length<50)group.records.push(issue.sourceId);
  };
  for(const [jobId,job] of backgroundJobs){
   for(const issue of job.relationIssues||[])add(jobId,issue);
   if(job.type==='black_issue'&&job.error)add(jobId,{kind:job.state,message:job.error,sourceId:job.issueId});
   for(const row of job.rows||[])add(jobId,{kind:row.error?.kind||row.status,entity:row.targetEntity,
    message:row.error?.message||row.reasons?.join(' '),sourceId:row.sourceId});
  }
  return send(res,200,{groups:[...groups.values()].slice(0,500),totalGroups:groups.size,expiresAt:s.last+ttl});
 }
 if(url==='/api/repairs/list'&&method==='POST'){const b=await bodyOf(req),rows=repairIssues(s,b);return send(res,200,{rows:rows.slice(0,500),totalRows:rows.length,truncated:rows.length>500,expiresAt:s.last+ttl});}
 if(url==='/api/repairs/action'&&method==='POST'){
  const b=await bodyOf(req),ids=Array.isArray(b.issueIds)?b.issueIds:[b.issueId];if(!ids.length||ids.length>500)throw fail(422,'יש לבחור בין תקלה אחת ל־500 תקלות.');const results=[];
  for(const issueId of ids){const issue=findRepairIssue(s,issueId),{jobId,key,job,row}=issue;if(b.action==='report'){if(job.ownerId!==s.userId)throw fail(403,'ניתן לדווח רק על תקלה בריצה שלך.');const meta={reportedAt:new Date().toISOString(),repairStatus:'reported',reportNote:String(b.note||'').slice(0,1000)};Object.assign(row,meta);await appendDurableEvent(directory,s.key,jobId,{type:'repair',key,row,meta});await storeJob(jobId,job,s.key);results.push({issueId,status:'reported'});continue;}
   if(s.role!=='admin')throw fail(403,'הפעולה זמינה למנהל בלבד.');if(b.action==='close'||b.action==='reopen'){const meta={repairStatus:b.action==='close'?'closed':'reported',closedAt:b.action==='close'?new Date().toISOString():null,adminNote:String(b.note||'').slice(0,1000)};Object.assign(row,meta);await appendDurableEvent(directory,s.key,jobId,{type:'repair',key,row,meta});await storeJob(jobId,job,s.key);results.push({issueId,status:meta.repairStatus});continue;}
   if(b.action==='retry'){if(!['failed','not_sent'].includes(row.status))throw fail(409,'תוצאה לא ידועה מחייבת אימות יעד לפני ניסיון חוזר; ניתן לסגור ידנית לאחר האימות.');const [planId,indexText]=key.split(':'),index=Number(indexText),plan=runtimePlans.get(planId);if(!plan)throw fail(409,'תוכנית הכתיבה אינה זמינה. יש להפעיל Dry Run חדש לתיקון ממוקד.');if(Array.isArray(b.writePayloads)){if(!b.writePayloads.length||b.writePayloads.length>50)throw fail(422,'רשימת בקשות התיקון אינה תקינה.');const allowed=new Set((plan.result.rows[index].requests||[]).map(item=>item.operation));if(b.writePayloads.some(item=>!allowed.has(item?.operation)||!item.body||typeof item.body!=='object'))throw fail(422,'בקשת התיקון חורגת מפעולות התוכנית המקורית.');plan.result.rows[index].requests=structuredClone(b.writePayloads);await saveDurablePlan(directory,s.key,planId,durablePlan(plan));}
    const fromStatus=row.status;runtimeOutcomes.set(key,undefined);await appendDurableEvent(directory,s.key,jobId,{type:'outcome-clear',id:key});const worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data),durableJobId:jobId};let retried;try{retried=(await executePlanRow(worker,{planId,index},()=>{})).row;}finally{worker.key.fill(0);}const rowIndex=job.rows.indexOf(row);if(retried.status==='succeeded')job.rows.splice(rowIndex,1);else job.rows[rowIndex]={...retried,planId,index,repairStatus:'retry_failed'};job.counts[fromStatus]=Math.max(0,(job.counts[fromStatus]||0)-1);job.counts[retried.status]=(job.counts[retried.status]||0)+1;await appendDurableEvent(directory,s.key,jobId,{type:'repair',key,fromStatus,row:{...retried,planId,index},meta:{repairStatus:retried.status==='succeeded'?'resolved':'retry_failed',retriedAt:new Date().toISOString()}});await storeJob(jobId,job,s.key);results.push({issueId,status:retried.status});continue;}
   throw fail(422,'פעולת התיקון אינה תקינה.');
  }return send(res,200,{results,expiresAt:s.last+ttl});
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
  if(job.state==='running')return send(res,200,{state:'running',progress:job.progress,rateLimit:job.rateLimit,expiresAt:s.last+ttl});
  if(job.state==='error')return send(res,200,{state:'error',error:job.error,debug:job.debug,progress:job.progress,rateLimit:job.rateLimit,expiresAt:s.last+ttl});
  return send(res,200,{state:'done',...job.result,progress:job.progress,rateLimit:job.rateLimit,expiresAt:s.last+ttl});
 }
 if(url==='/api/export/start'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);
  if(!c||s.data.activeId!==c.id)throw fail(409,'החיבור השתנה.');
  const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map();
  const p=validatePreset({name:b.presetName||'ייצוא ניסוי',entities:[b.entity]},c.id,schemas);
  const config=p.entities[0],range=dateRange(b.dateRange),jobId=randomUUID(),worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data)};
  const job={type:'export',ownerId:s.userId,username:s.username,connectionName:c.name,state:'running',connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),finishedAt:null,debug:null,rateLimit:rateSnapshot(c),progress:{phase:'starting',attempt:1,maxAttempts:3,page:0,pageSize:500,records:0,total:null,percent:0,etaSeconds:null}};
  backgroundJobs.set(jobId,job);await storeJob(jobId,job,worker.key);
  const guard=()=>{};
  void (async()=>{try{
   const entity=await exportAll({connection:c,config,schema:schemas.get(config.entityId),range,onDebug:d=>job.debug=d,onProgress:p=>{const quota=rateSnapshot(c),remaining=p.total==null?0:Math.max(0,Math.ceil((p.total-p.records)/Math.max(1,p.pageSize)));job.rateLimit=quota;job.progress={...p,etaSeconds:Math.max(Number(p.etaSeconds)||0,rateEtaSeconds(quota,remaining))};},guard});
   if(job.debug)job.debug.exportSummary={name:entity.meta.name,dataName:config.entityId,records:entity.records.length,totalAvailable:entity.meta.totalAvailable,dateRange:range};
   job.progress={...job.progress,phase:'complete',records:entity.records.length,total:entity.meta.totalAvailable,percent:100};
   job.result={entity,meta:{...createPackage({},p.name).meta,dateRange:range,sourceConnectionId:c.id},debug:job.debug};job.state='done';job.finishedAt=Date.now();
  }catch(e){if(job.debug){job.debug.outcome='error';job.debug.error={message:e.message};}job.error=e.message||'לא ניתן להשלים את הייצוא.';job.state='error';job.finishedAt=Date.now();}finally{await storeJob(jobId,job,worker.key);worker.key.fill(0);}})();
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
  if(job.state==='running')return send(res,200,{state:'running',progress:job.progress,rateLimit:job.rateLimit,startedAt:job.startedAt,expiresAt:s.last+ttl});
  if(job.state==='error')return send(res,200,{state:'error',error:job.error,debug:job.debug,progress:job.progress,rateLimit:job.rateLimit,expiresAt:s.last+ttl});
  return send(res,200,{state:'done',...job.result,progress:job.progress,rateLimit:job.rateLimit,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/prepare/start'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');if(b.schemaVersion!=='1.0')throw fail(422,'גרסת חבילה לא נתמכת.');
  const jobId=randomUUID(),worker={...s,key:Buffer.from(s.key),data:structuredClone(s.data)},job={type:'import_prepare',ownerId:s.userId,username:s.username,connectionName:c.name,transferId:typeof b.transferId==='string'?b.transferId:null,label:b.label||b.fileName||'Dry Run',fileName:b.fileName||'',fileSize:Number(b.fileSize)||0,batchIndex:Number(b.batchIndex)||0,batchCount:Math.max(1,Number(b.batchCount)||1),batchRecords:Math.max(0,Number(b.batchRecords)||0),totalRecords:Math.max(0,Number(b.totalRecords)||0),state:'running',connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),startedAt:new Date().toISOString(),finishedAt:null,debug:null,rateLimit:rateSnapshot(c),progress:{phase:'starting',entityIndex:0,entities:Array.isArray(b.mappings)?b.mappings.length:0,records:0,etaSeconds:null}};backgroundJobs.set(jobId,job);await storeJob(jobId,job,worker.key);
  const guard=()=>{};
  void (async()=>{try{job.result=await buildImportPreparation({s:worker,c,b,guard,onDebug:d=>job.debug=d,onProgress:p=>{const quota=rateSnapshot(c),remaining=Math.max(0,Number(p.totalRecords||b.batchRecords||0)-Number(p.records||0));job.rateLimit=quota;job.progress={...p,etaSeconds:rateEtaSeconds(quota,remaining)};}});job.state='done';job.progress={...job.progress,phase:'complete',etaSeconds:0};job.finishedAt=Date.now();}catch(e){if(job.debug){job.debug.outcome='error';job.debug.error={message:e.message};}job.error=e.message||'לא ניתן להשלים את ה־Dry Run.';job.state='error';job.finishedAt=Date.now();}finally{await storeJob(jobId,job,worker.key);worker.key.fill(0);}})();
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
  let debug;try{const result=await dryRunEntity({connection:c,entity:b.entity,targetId:b.targetId,targetKey:b.targetKey,schema,mapping:b.mapping,relationStaging:b.relationStaging,relationData,guard,onDebug:d=>debug=d});guard();const planId=randomUUID(),plan={ownerId:s.userId,connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),sourceEntity:structuredClone(b.entity),entity:b.mapping===undefined?structuredClone(b.entity):applyImportMapping(b.entity,schema,b.mapping,b.relationStaging,b.targetId),targetId:b.targetId,targetKey:structuredClone(b.targetKey),mapping:b.mapping===undefined?undefined:structuredClone(b.mapping),relationStaging:b.relationStaging?structuredClone(b.relationStaging):null,schema,result,relationData,halted:false};runtimePlans.set(planId,plan);await saveDurablePlan(directory,s.key,planId,durablePlan(plan));return send(res,200,{result,planId,debug,expiresAt:s.last+ttl});}catch(e){if(debug)e.debug=debug;throw e;}
 }
 if(url==='/api/import/history'&&method==='POST'){
  const b=await bodyOf(req);if(s.data.activeId!==b.connectionId)throw fail(409,'בחרו חיבור פעיל.');const all=[...(s.data.importLog||[]),...[...runtimeOutcomes.values()].filter(r=>r.ownerId===s.userId)].filter(r=>r.connectionId===b.connectionId);return send(res,200,{rows:all.slice(-500),totalRows:all.length,truncated:all.length>500,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/pipeline/start'&&method==='POST'){
  const b=await bodyOf(req),connection=s.data.connections.find(c=>c.id===b.connectionId);if(!connection||s.data.activeId!==connection.id)throw fail(409,'בחרו חיבור יעד פעיל.');if(b.schemaVersion!=='1.0'||!Array.isArray(b.batches)||!b.batches.length)throw fail(422,'קובץ הייבוא או גרסתו אינם תקינים.');if([...backgroundJobs.values()].some(job=>job.type==='import_run'&&job.ownerId===s.userId&&job.connectionId===connection.id&&job.state==='running'))throw fail(409,'כבר פועל ייבוא ברקע בחיבור הזה.');
  const schemas=s.schemas.get(connection.id+':'+connection.updatedAt);if(!schemas?.size)throw fail(422,'יש לטעון את מבנה ישות היעד לפני הפעלת הייבוא.');const checkTotal=b.batches.reduce((sum,item)=>sum+(Array.isArray(item?.entity?.records)?item.entity.records.length:0),0);if(!checkTotal)throw fail(422,'לא נמצאו רשומות לייבוא.');const jobId=randomUUID(),inputId='input-'+jobId,input={schemaVersion:b.schemaVersion,batches:structuredClone(b.batches),rules:structuredClone(b.rules||[]),finalizerRules:relationRules.get(connection.id),schemas:[...schemas]},baseProgress={phase:'starting',checked:0,checkTotal,completed:0,total:0,percent:0,etaSeconds:null,apiRequestsCompleted:0,apiRequestsTotal:0},baseCounts={input:0,planned:0,skipped:0,blocked:0,succeeded:0,failed:0,not_sent:0,unknown:0,stopped:0},job={type:'import_run',pipeline:true,inputId,ownerId:s.userId,username:s.username,connectionName:connection.name,connectionId:connection.id,connectionVersion:connection.updatedAt,label:b.label||b.fileName||'ייבוא',fileName:b.fileName||'',fileSize:Number(b.fileSize)||0,state:'running',createdAt:Date.now(),startedAt:new Date().toISOString(),finishedAt:null,stopRequested:false,nextBatch:0,checkedBeforeBatch:0,planIds:[],order:[],completedKeys:[],baseProgress,progress:structuredClone(baseProgress),baseCounts,counts:structuredClone(baseCounts),rows:[],rateLimit:rateSnapshot(connection)};await saveDurablePayload(directory,s.key,inputId,input);await startDurableImport(jobId,job,s);runtimeInputs.set(inputId,input);void runImportPipeline(jobId,s);return send(res,202,{jobId,state:'running',progress:job.progress,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run/status'&&method==='POST'){
  const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);if(!job||job.type!=='import_run'||job.ownerId!==s.userId)throw fail(404,'משימת הייבוא לא נמצאה.');return send(res,200,{state:job.state,progress:job.pipeline?reportPipelineProgress(job,job.pipelineWorkerActive):job.progress,rateLimit:job.rateLimit,counts:job.counts,relationCompleted:job.relationCompleted,relationIssueCount:job.relationIssues?.length||0,retryAt:Math.min(...Object.entries(job.retries||{}).filter(([key])=>runtimeOutcomes.get(key)?.status==='deferred').map(([,retry])=>retry.nextAt)),rows:job.rows.slice(-500),truncated:job.rows.length>500,error:job.error,pauseKind:job.pauseKind,pauseReason:job.pauseReason,startedAt:job.startedAt,finishedAt:job.finishedAt,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run/stop'&&method==='POST'){const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);if(!job||job.type!=='import_run'||job.ownerId!==s.userId)throw fail(404,'משימת הייבוא לא נמצאה.');job.stopRequested=true;await storeJob(b.jobId,job,s.key);return send(res,200,{ok:true,expiresAt:s.last+ttl});}
 if(url==='/api/import/run/resume'&&method==='POST'){const b=await bodyOf(req),job=backgroundJobs.get(b.jobId);if(!job||job.type!=='import_run'||job.ownerId!==s.userId)throw fail(404,'משימת הייבוא לא נמצאה.');if(job.connectionId!==s.data.activeId)throw fail(409,'בחרו את החיבור ששימש לריצה לפני ההמשך.');if(!['paused','stopped','error'].includes(job.state))throw fail(409,'הריצה אינה מושהית.');job.state='running';job.finishedAt=null;job.stopRequested=false;await startDurableImport(b.jobId,job,s);if(job.pipeline)void runImportPipeline(b.jobId,s);else void runBackgroundImport(b.jobId,s);return send(res,202,{jobId:b.jobId,state:'running',progress:job.progress,expiresAt:s.last+ttl});}
 if(url==='/api/import/run/start'&&method==='POST'){
  const b=await bodyOf(req);if([...backgroundJobs.values()].some(job=>job.type==='import_run'&&job.ownerId===s.userId&&job.connectionId===s.data.activeId&&job.state==='running'))throw fail(409,'כבר פועל ייבוא ברקע בחיבור הזה. התקדמותו מוצגת ברשימת התהליכים.');if(!Array.isArray(b.planIds)||!b.planIds.length||!Array.isArray(b.order))throw fail(422,'לא נמצאה תוכנית כתיבה קפואה. בצעו Dry Run חדש.');const selected=b.planIds.map(id=>runtimePlans.get(id));if(selected.some(p=>!p||p.ownerId!==s.userId||p.connectionId!==s.data.activeId))throw fail(409,'תוכנית הייבוא אינה שייכת לחיבור הפעיל.');
  const planSet=new Set(b.planIds),expected=new Set();for(const planId of b.planIds){const plan=runtimePlans.get(planId);for(let index=0;index<plan.result.rows.length;index++)if(plan.result.rows[index].status==='planned')expected.add(planId+':'+index);}
  const order=b.order.map(item=>({planId:item?.planId,index:Number(item?.index)})),seen=new Set();for(const item of order){const key=item.planId+':'+item.index;if(!planSet.has(item.planId)||!Number.isInteger(item.index)||!expected.has(key)||seen.has(key))throw fail(422,'סדר הכתיבה אינו תואם ל־Dry Run. בצעו בדיקה חדשה.');seen.add(key);}if(seen.size!==expected.size)throw fail(422,'סדר הכתיבה חסר רשומות שאושרו ב־Dry Run.');
  const connection=s.data.connections.find(c=>c.id===s.data.activeId),allRows=selected.flatMap(p=>p.result.rows),requestTotal=order.reduce((sum,item)=>sum+(runtimePlans.get(item.planId).result.rows[item.index].requests?.length||1),0),jobId=randomUUID(),baseProgress={completed:0,total:order.length,percent:0,etaSeconds:null,apiRequestsCompleted:0,apiRequestsTotal:requestTotal},baseCounts={input:allRows.length,planned:order.length,skipped:allRows.filter(r=>r.status==='skipped').length,blocked:allRows.filter(r=>r.status==='blocked').length,succeeded:0,failed:0,not_sent:0,unknown:0,stopped:0},job={type:'import_run',ownerId:s.userId,username:s.username,connectionName:connection?.name||'',connectionId:s.data.activeId,connectionVersion:connection?.updatedAt,label:b.label||b.fileName||'ייבוא',fileName:b.fileName||'',fileSize:Number(b.fileSize)||0,state:'running',createdAt:Date.now(),startedAt:new Date().toISOString(),finishedAt:null,stopRequested:false,order:structuredClone(order),completedKeys:[],baseProgress,progress:structuredClone(baseProgress),baseCounts,counts:structuredClone(baseCounts),rows:[],rateLimit:rateSnapshot(connection)};await startDurableImport(jobId,job,s);
  void runBackgroundImport(jobId,s);
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
async function cleanupExpired(){for(const current of [...sessions.values()])if(Date.now()-current.last>ttl)clear(current);for(const [id,job] of backgroundJobs)if(!relationRepairWorkers.has(id)&&job.finishedAt&&Date.now()-Number(job.finishedAt)>planTtl){backgroundJobs.delete(id);jobRelationCache.delete(id);completedRelationTasks.delete(id);await deleteDurableJob(directory,'cache-'+id);await deleteDurableJob(directory,id);if(job.inputId){runtimeInputs.delete(job.inputId);await deleteDurablePayload(directory,job.inputId);}}for(const [id,plan] of runtimePlans)if(Date.now()-plan.createdAt>planTtl){runtimePlans.delete(id);await deleteDurablePlan(directory,id);}}
setInterval(()=>{void cleanupExpired().catch(error=>console.error('Durable cleanup failed',error));},30000).unref();
 await recoverBackgroundImports();
 server.listen(port,listenHost,()=>console.log(`SIMPLY BRIDGE ${appVersion}: ${origin}${basePath}`));
