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
import {validatePreset} from './presets.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4318);
const publicUrl=new URL(process.env.PUBLIC_URL||`http://127.0.0.1:${port}/`);
if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(publicUrl.pathname))throw Error('PUBLIC_URL must be an http(s) URL with a simple path and no credentials/query/fragment');
const origin=publicUrl.origin,basePath=publicUrl.pathname.replace(/\/+$/,'')+'/',listenHost=process.env.HOST||'127.0.0.1';
const cookiePath=basePath,secureCookie=publicUrl.protocol==='https:'?'; Secure':'';
const directory=path.resolve(process.env.DATA_DIR||path.join(root,'data'));
const vaultPath=path.join(directory,'connections.vault.json');
const ttl=15*60*1000;
const cookieName='ot_session_'+port;
let session=null, failures=0, blockedUntil=0;
let queue=Promise.resolve();
const fail=(status,message)=>Object.assign(new Error(message),{status});
async function envelope(){try{return JSON.parse(await readFile(vaultPath,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
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
function clear(){if(session)session.key.fill(0);session=null;}
function auth(req,touch=true){if(session&&Date.now()-session.last>ttl)clear();const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!session||token!==session.token)throw fail(401,'הכספת נעולה. יש להזין שוב את סיסמת הפתיחה.');if(touch)session.last=Date.now();return session;}
const publicData=s=>({activeId:s.data.activeId,connections:s.data.connections.map(({secret,...c})=>({...c,hasSecret:!!secret})),expiresAt:s.last+ttl});
function clean(body,old){
 const str=(v,max)=>{if(typeof v!=='string'||v.length>max)throw fail(400,'אחד הפרטים חסר או ארוך מדי.');return v.trim();};
 const name=str(body.name,80),baseUrl=str(body.baseUrl,2048),username=str(body.username,320),note=str(body.note||'',300);
 if(!name||!username)throw fail(400,'יש למלא שם חיבור ושם משתמש.');
 let url;try{url=new URL(baseUrl);}catch{throw fail(400,'יש להזין כתובת מלאה, כולל https:// או http://.');}
 if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw fail(400,'כתובת הבסיס צריכה לכלול דומיין, ויכולה לכלול פורט ונתיב, ללא פרטי התחברות, פרמטרים או #.');
 const secret=body.secret===''&&old?old.secret:str(body.secret,4096);
 if(!secret)throw fail(400,'יש להזין API Secret.');
 return {id:old?.id||randomUUID(),name,baseUrl:url.href.replace(/\/+$/,''),username,note,secret,color:['teal','red','slate','blue'].includes(body.color)?body.color:'teal',createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
}
async function bodyOf(req){const bulk=['/api/import/dry-run','/api/import/fetch-relations','/api/import/prepare','/api/presets/save','/api/import-presets/save','/api/export/entity'].includes(req.url),chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(!bulk&&size>32768)throw fail(413,'הבקשה גדולה מדי.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail(400,'בקשה לא תקינה.');}}
function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
async function api(req,res,url){
 const method=req.method;
 if(method!=='GET'&&(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0]!=='application/json'))throw fail(403,'בקשה ממקור לא מורשה.');
 if(url==='/api/status'&&method==='GET'){let unlocked=false;try{auth(req,false);unlocked=true;}catch{}return send(res,200,{initialized:!!await envelope(),unlocked});}
 if(['/api/setup','/api/unlock'].includes(url)&&method==='POST'){
  if(Date.now()<blockedUntil)throw fail(429,'יותר מדי ניסיונות. אפשר לנסות שוב בעוד דקה.');
  const b=await bodyOf(req);if(typeof b.password!=='string'||b.password.length>1024)throw fail(400,'יש להזין סיסמה תקינה.');
  const e=await envelope();let key,data,salt;
  if(url==='/api/setup'){
   if(e)throw fail(409,'כבר הוגדרה סיסמת פתיחה.');
   if(b.password.length<10)throw fail(400,'בחרו סיסמה באורך 10 תווים לפחות.');
   salt=randomBytes(16).toString('base64');key=derive(b.password,salt);data={connections:[],activeId:null};await persist(data,key,salt);
  }else{
   if(!e)throw fail(409,'יש להגדיר תחילה סיסמת פתיחה.');
   salt=e.salt;key=derive(b.password,salt);
   try{data=decrypt(e,key);}catch{key.fill(0);failures++;if(failures>=5){blockedUntil=Date.now()+60000;failures=0;}throw fail(401,'הסיסמה שגויה או שקובץ הכספת אינו תקין.');}
  }
  clear();failures=0;session={key,salt,data,schemas:new Map(),plans:new Map(),token:randomBytes(32).toString('hex'),last:Date.now()};
  return send(res,200,publicData(session),{'Set-Cookie':`${cookieName}=${session.token}; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}`});
 }
 const s=auth(req);
 if(url==='/api/lock'&&method==='POST'){clear();return send(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookie}; Max-Age=0`});}
 if(url==='/api/connections'&&method==='GET')return send(res,200,publicData(s));
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
 if(url==='/api/import/prepare'&&method==='POST'){
  const b=await bodyOf(req),c=s.data.connections.find(c=>c.id===b.connectionId);if(!c||s.data.activeId!==c.id)throw fail(409,'בחרו חיבור יעד פעיל.');if(b.schemaVersion!=='1.0')throw fail(422,'גרסת חבילה לא נתמכת.');
  const schemas=s.schemas.get(c.id+':'+c.updatedAt)||new Map(),guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||s.data.connections.find(x=>x.id===c.id)?.updatedAt!==c.updatedAt)throw fail(409,'החיבור השתנה.');};
  let debug;try{const prepared=await prepareImport({connection:c,mappings:b.mappings,rules:b.rules??[],schemas,guard,onDebug:d=>debug=d});guard();const ids=prepared.plans.map(()=>randomUUID()),batch={nodes:new Map(),halted:false},createdAt=Date.now();
   prepared.order.forEach(item=>batch.nodes.set(item.key,{planId:ids[item.planIndex],index:item.index,dependencies:item.dependencies}));
   prepared.plans.forEach((p,i)=>s.plans.set(ids[i],{connectionId:c.id,connectionVersion:c.updatedAt,createdAt,sourceEntity:structuredClone(p.entity),entity:p.mapped,targetId:p.targetId,targetKey:p.targetKey,mapping:p.mapping,schema:p.schema,result:p.result,relationData:p.relationData,halted:false,batch}));
   return send(res,200,{plans:prepared.plans.map((p,i)=>({id:ids[i],result:p.result,sourceEntity:p.entity,targetKey:p.targetKey,mapping:p.mapping})),order:prepared.order.map(item=>({...item,planId:ids[item.planIndex]})),report:prepared.report,debug,expiresAt:s.last+ttl});
  }catch(e){if(debug)e.debug=debug;throw e;}
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
  let debug;try{const result=await dryRunEntity({connection:c,entity:b.entity,targetId:b.targetId,targetKey:b.targetKey,schema,mapping:b.mapping,relationData,guard,onDebug:d=>debug=d});guard();const planId=randomUUID();s.plans.set(planId,{connectionId:c.id,connectionVersion:c.updatedAt,createdAt:Date.now(),sourceEntity:structuredClone(b.entity),entity:b.mapping===undefined?structuredClone(b.entity):applyImportMapping(b.entity,schema,b.mapping),targetId:b.targetId,targetKey:structuredClone(b.targetKey),mapping:b.mapping===undefined?undefined:structuredClone(b.mapping),schema,result,relationData,halted:false});return send(res,200,{result,planId,debug,expiresAt:s.last+ttl});}catch(e){if(debug)e.debug=debug;throw e;}
 }
 if(url==='/api/import/history'&&method==='POST'){
  const b=await bodyOf(req);if(s.data.activeId!==b.connectionId)throw fail(409,'בחרו חיבור פעיל.');return send(res,200,{rows:(s.data.importLog||[]).filter(r=>r.connectionId===b.connectionId),expiresAt:s.last+ttl});
 }
 if(url==='/api/import/run'&&method==='POST'){
  const b=await bodyOf(req),plan=s.plans.get(b.planId),index=b.index;
  if(!plan||!Number.isInteger(index)||index<0||index>=plan.entity.records.length)throw fail(422,'בדיקת הייבוא פגה או שהרשומה אינה תקינה. בצעו Dry Run חדש.');
  const c=s.data.connections.find(c=>c.id===plan.connectionId);
  if(!c||s.data.activeId!==c.id||c.updatedAt!==plan.connectionVersion)throw fail(409,'החיבור השתנה. בצעו Dry Run מחדש.');
  const id=b.planId+':'+index,previous=s.data.importLog?.find(r=>r.id===id);
  if(previous)return send(res,200,{row:previous,replayed:true,expiresAt:s.last+ttl});
  if(plan.halted||plan.batch?.halted||Date.now()-plan.createdAt>ttl)throw fail(409,'הריצה נעצרה או שהבדיקה פגה. בדקו את הדוח לפני Dry Run חדש.');
  let planned=plan.result.rows[index];let effectiveRelationData=plan.relationData;
  if(plan.batch&&planned.status==='planned'){const item=plan.batch.nodes.get(nodeKey(plan.entity.meta.dataName,planned.sourceId)),outcomes=new Map(item.dependencies.map(key=>{const ref=plan.batch.nodes.get(key);return [key,(s.data.importLog||[]).find(r=>r.planId===ref?.planId&&r.id===ref.planId+':'+ref.index)];}));const materialized=materializeDependencies({planned,relationData:plan.relationData?.[planned.sourceId],dependencies:item.dependencies,outcomes});if(materialized.notReady)throw fail(409,'יש לבצע קודם את הרשומות הקודמות בסדר הכתיבה.');if(materialized.blocked)planned={...planned,status:'blocked',reasons:[materialized.reason]};else{planned=materialized.planned;effectiveRelationData={...plan.relationData,[planned.sourceId]:materialized.relationData};}}
  const key=JSON.stringify([c.id,plan.targetId,plan.targetKey.kind,plan.targetKey.groupId||'',plan.targetKey.fieldId||'',String(plan.targetKey.kind==='recordId'?planned.sourceId:planned.matchKey)]);
  if((s.data.importLog||[]).some(r=>r.conflictKey===key&&['pending','unknown'].includes(r.status)))throw fail(409,'יש כתיבה קודמת עם תוצאה לא ידועה לאותו מפתח. נדרשת בדיקה ביעד לפני ניסיון נוסף.');
  const guard=()=>{if(auth(req)!==s||s.data.activeId!==c.id||c.updatedAt!==plan.connectionVersion)throw fail(409,'החיבור או ההרשאה השתנו.');};
  const base={relationResolution:effectiveRelationData?.[plan.entity.records[index].id]??{},writePayload:planned.request.body,sourceRecord:structuredClone(plan.sourceEntity.records[index]),sourceEntityMeta:structuredClone(plan.sourceEntity.meta),targetRecord:structuredClone(plan.entity.records[index]),targetKey:structuredClone(plan.targetKey),mapping:plan.mapping??[],id,planId:b.planId,connectionId:c.id,connectionName:c.name,targetEntity:plan.targetId,entityName:plan.result.name,sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,conflictKey:key,startedAt:new Date().toISOString()};
  const save=async row=>{const next=structuredClone(s.data);next.importLog??=[];const i=next.importLog.findIndex(x=>x.id===id);if(i<0)next.importLog.push({...base,...row});else next.importLog[i]={...base,...row};await persist(next,s.key,s.salt);s.data=next;};
  let debug;
  const row=await executeRow({planned,recheck:async()=>{await verifyRelations({connection:c,data:effectiveRelationData?.[plan.entity.records[index].id],guard,onDebug:d=>debug=d});const r=await dryRunEntity({connection:c,entity:{...plan.entity,records:[plan.entity.records[index]]},targetId:plan.targetId,targetKey:plan.targetKey,schema:plan.schema,relationData:effectiveRelationData,guard,onDebug:d=>debug=d});return r.rows[0];},write:r=>writeSimply(c,r.action==='create'?'create_instance':'update_instance_fields',r.request.body,d=>debug=d,guard),recordIntent:()=>save({status:'pending',sent:true,stop:true}),recordResult:r=>save({...r,finishedAt:new Date().toISOString()})});
  if(!row.sent)await save({...row,finishedAt:new Date().toISOString()});
  if(row.stop){plan.halted=true;if(plan.batch)plan.batch.halted=true;}return send(res,200,{row:{...base,...row},debug,expiresAt:s.last+ttl});
 }
 if(url==='/api/import/finish'&&method==='POST'){
  const b=await bodyOf(req);if(!Array.isArray(b.planIds)||!b.planIds.length)throw fail(422,'ריצה לא תקינה.');const plans=b.planIds.map(id=>s.plans.get(id));if(plans.some(p=>!p||p.connectionId!==s.data.activeId))throw fail(409,'הריצה אינה שייכת לחיבור הפעיל.');
  const rows=b.planIds.flatMap((id,i)=>plans[i].entity.records.map((_,index)=>s.data.importLog?.find(r=>r.id===id+':'+index)));
  const success=rows.length>0&&rows.every(r=>r?.status==='succeeded');if(success){const next=structuredClone(s.data);next.syncStates??={};const state=next.syncStates[next.activeId]??={lastImportedAt:null,sourceSyncedThrough:null,exportFrom:null};state.lastImportedAt=new Date(rows.reduce((latest,r)=>Math.max(latest,Date.parse(r.finishedAt)),0)).toISOString();await persist(next,s.key,s.salt);s.data=next;}
  return send(res,200,{success,sourceWatermarkAdvanced:false,expiresAt:s.last+ttl});
 }
 const b=await bodyOf(req),next=structuredClone(s.data);
 if(['/api/sync/state','/api/sync/save','/api/sync/export-finish'].includes(url)&&method==='POST'){
  const c=next.connections.find(x=>x.id===b.connectionId);if(!c||next.activeId!==c.id)throw fail(409,'בחרו חיבור פעיל.');
  next.syncStates??={};const state=next.syncStates[c.id]||{lastImportedAt:null,sourceSyncedThrough:null,exportFrom:null};
  if(url==='/api/sync/save'){if(b.exportFrom!==null&&!Number.isFinite(Date.parse(b.exportFrom)))throw fail(422,'תאריך לא תקין.');state.exportFrom=b.exportFrom===null?null:new Date(b.exportFrom).toISOString();next.syncStates[c.id]=state;await persist(next,s.key,s.salt);s.data=next;}
  if(url==='/api/sync/export-finish'){
   if(typeof b.exportThrough!=='string'||!Number.isFinite(Date.parse(b.exportThrough)))throw fail(422,'תאריך ייצוא לא תקין.');
   state.lastExportedAt=new Date().toISOString();state.exportFrom=new Date(b.exportThrough).toISOString();
   next.syncStates[c.id]=state;await persist(next,s.key,s.salt);s.data=next;
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
  if(url!=='/api/import-presets/list'){await persist(next,s.key,s.salt);s.data=next;}
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
  if(url!=='/api/presets/list'){await persist(next,s.key,s.salt);s.data=next;}
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
 await persist(next,s.key,s.salt);s.data=next;send(res,200,publicData(s));
}
const assets={'/preset-transfer.js':['preset-transfer.js','text/javascript; charset=utf-8'],'/relations.js':['relations.js','text/javascript; charset=utf-8'],'/import-errors.js':['import-errors.js','text/javascript; charset=utf-8'],'/import-mapping.js':['import-mapping.js','text/javascript; charset=utf-8'],'/dry-run.js':['dry-run.js','text/javascript; charset=utf-8'],'/transfer.schema.json':['transfer.schema.json','application/schema+json'],'/export.js':['export.js','text/javascript; charset=utf-8'],'/presets.js':['presets.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/schema.js':['schema.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
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
  const [file,type]=assets[url];res.writeHead(200,{'Content-Type':type});res.end(await readFile(path.join(root,'public',file)));
 }catch(e){send(res,e.status||500,{error:e.status?e.message:'לא ניתן להשלים את הפעולה. בדקו שהיישום יכול לקרוא ולשמור את קובץ הכספת.',...(e.debug?{debug:e.debug}:{})});}};
 if((req.url.startsWith('/api/schema/')||req.url.startsWith('/api/export/')||req.url==='/api/import/dry-run'))void run();else queue=queue.then(run,run);
});
setInterval(()=>{if(session&&Date.now()-session.last>ttl)clear();},30000).unref();
server.listen(port,listenHost,()=>console.log(`SIMPLY BRIDGE: ${origin}${basePath}`));
