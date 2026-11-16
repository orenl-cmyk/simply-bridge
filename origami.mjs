import {rateOptions,noteRateLimit,rateSnapshot} from './rate-limit.mjs';
import {postJson} from './transport.mjs';
const error=(status,message)=>Object.assign(new Error(message),{status});
export async function readOrigami(connection,operation,params={},onDebug=()=>{},beforeRequest=()=>{}){
 const attempts=[];let last;
 for(let attempt=0;attempt<3;attempt++){
  const {state,spacingMs,maxConcurrent}=rateOptions(connection);
  const queued=Date.now();
  try{
   const data=await state.limiter.run(async()=>{beforeRequest();return performRead(connection,operation,params,d=>{last=d;d.queueWaitMs=Date.now()-queued-d.durationMs;});},{spacingMs,maxConcurrent});
   onDebug({...last,attempts,rateLimit:{...rateSnapshot(connection),spacingMs}});return data;
  }catch(e){
   if(!last)throw e;
   attempts.push({attempt:attempt+1,status:last.response?.status??null,durationMs:last.durationMs,error:last.error});
   if(last.response?.status!==429||attempt===2){onDebug({...last,attempts,rateLimit:{...rateSnapshot(connection),spacingMs}});throw e;}
   const header=last.response.headers['retry-after'];const numeric=header==null?NaN:Number(header);
   const wait=Number.isFinite(numeric)?numeric*1000:header?Date.parse(header)-Date.now():1000*2**attempt;
   const pause=Number.isFinite(wait)?Math.max(1000,wait):1000*2**attempt;
   noteRateLimit(connection,pause);last=null;
  }
 }
}
async function performRead(connection,operation,params={},onDebug=()=>{}){
 if(!['entities_list','entity_structure','instance_data'].includes(operation))throw error(400,'פעולה לא נתמכת.');
 const url=connection.baseUrl.replace(/\/+$/,'')+'/entities/api/'+operation+'/format/json';
 const started=Date.now(),debug={startedAt:new Date(started).toISOString(),operation,request:{url,method:'POST',headers:{'Content-Type':'application/json'},body:{username:'[REDACTED]',api_secret:'[REDACTED]',...params},timeoutMs:30000,redirect:'error'},runtime:{node:process.version,platform:process.platform,execution:'local Node.js server'},response:null};
 const redact=value=>{if(typeof value==='string'){let text=value;for(const v of [connection.secret,connection.username].filter(Boolean)){for(const variant of [v,encodeURIComponent(v),JSON.stringify(v).slice(1,-1)])text=text.split(variant).join('[REDACTED]');}return text.replace(/((?:api_secret|password|authorization|access_token|refresh_token|cookie)["']?\s*[:=]\s*)["']?[^\s,"'<>}]+/gi,'$1[REDACTED]');}if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k, /secret|password|token|authorization|cookie|username/i.test(k)?'[REDACTED]':redact(v)]));return value;};
 function causes(e,depth=0){if(!e||depth>4)return undefined;return {name:e.name,code:e.code,message:redact(String(e.message||'')),syscall:e.syscall,hostname:e.hostname,address:e.address,port:e.port,cause:causes(e.cause,depth+1),errors:e.errors?.slice(0,5).map(x=>causes(x,depth+1))};}
 let stage='connect';
 try{
  const response=await postJson(url,{username:connection.username,api_secret:connection.secret,...params},{timeoutMs:30000});
  stage='read-response';debug.response={status:response.status,statusText:response.statusText,headers:Object.fromEntries(['content-type','content-length','server','date','retry-after'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null))};
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
  const preview=typeof data==='undefined'?redact(text):JSON.stringify(redact(data),null,2);
  debug.response.bodyPreview=preview.slice(0,12000);debug.response.truncated=preview.length>12000;
  if(!response.ok)throw error(502,`סימפלי החזירה HTTP ${response.status}. בדקו הרשאות ופרטי חיבור.`);
  stage='parse-json';if(typeof data==='undefined')throw error(502,'סימפלי החזירה תשובה שאינה JSON. בדקו את כתובת הבסיס.');
  stage='api-result';if(operation==='instance_data'&&data?.error?.type==='query'&&data.error.message==='No Results'){debug.outcome='success';return {data:[],info:{total_count:0}};}if(!data||typeof data!=='object'||data.error||data.errors||data.success===false)throw error(502,'סימפלי דיווחה על שגיאה. בדקו את פרטי ה־API ואת הרשאות הגישה למבנה הישויות.');
  debug.outcome='success';return data;
 }catch(e){debug.outcome='error';debug.failureStage=stage;debug.error=causes(e);if(e.status)throw e;throw error(502,'לא ניתן להשלים את הבקשה לסימפלי. פרטי הרשת והשגיאה זמינים בקונסול הדיבוג.');}
 finally{debug.durationMs=Date.now()-started;onDebug(redact(debug));}
}
export function excludedEntity(e){
 const id=String(e?.entity_data_name||e?.data_name||'').trim().toLowerCase();
 const name=String(e?.entity_name||e?.name||'').trim().toLowerCase();
 return String(e?.protected_entity)==='1'||e?.protected_entity===true||['users','user_groups','users_groups','origami_users','origami_groups','origami_user_groups','origami_users_groups'].includes(id)||['משתמשים','קבוצות משתמשים','users','user groups','users groups'].includes(name);
}
export function normalizeEntities(data,onSkipped=()=>{}){
 let source=data;for(let i=0;i<4&&!Array.isArray(source);i++){if(source&&typeof source==='object'&&(source.entities!==undefined||source.data!==undefined)){source=source.entities??source.data;}else break;}
 if(!source||typeof source!=='object')throw error(502,'מבנה רשימת הישויות אינו מוכר.');
 const items=Array.isArray(source)?source:Object.values(source),result=[],seen=new Set();
 for(const item of items){const e=item?.entity_data||item;if(excludedEntity(e)){onSkipped({id:String(e.entity_data_name||e.data_name||''),name:String(e.entity_name||e.name||''),reason:'משתמשים וקבוצות משתמשים אינם נכללים בטעינת המבנים.'});continue;}if(!e||typeof e.entity_data_name!=='string'||!e.entity_data_name)throw error(502,'רשימת הישויות כוללת פריט ללא entity_data_name.');if(seen.has(e.entity_data_name))continue;seen.add(e.entity_data_name);result.push({id:e.entity_data_name,name:String(e.entity_name||e.entity_data_name)});}
 return result.sort((a,b)=>a.name.localeCompare(b.name,'he'));
}
export function normalizeStructure(raw){
 const groups=new Map(),fields=new Map();let recognized=false;
 const groupOf=g=>{const id=String(g.group_data_name||g.group_id||g.group_name||'ungrouped');if(!groups.has(id))groups.set(id,{id,name:String(g.group_name||g.group_data_name||'ללא קבוצה'),repeatable:String(g.repeatable_group)==='1',fields:[]});return id;};
 function walk(value,group=null,depth=0){
  if(!value||typeof value!=='object'||depth>25)return;
  if(Array.isArray(value)){value.forEach(v=>walk(v,group,depth+1));return;}
  let current=group;
  if(value.field_group_data&&typeof value.field_group_data==='object'){current=groupOf(value.field_group_data);recognized=true;}
  else if(value.group_data_name){current=groupOf(value);recognized=true;}
  if('field_groups' in value||'fields_data' in value||'fields' in value)recognized=true;
  if(value.field_data_name){const gid=current||groupOf({group_data_name:'ungrouped',group_name:'ללא קבוצה'}),id=String(value.field_data_name),key=gid+'/'+id;if(!fields.has(key)){const f={id,name:String(value.field_name||id),type:String(value.field_type_name||value.field_type||'לא צוין'),readonly:String(value.custom_validation?.writable)==='0',reference:!!value.original_field_type_name};fields.set(key,f);groups.get(gid).fields.push(f);}recognized=true;}
  for(const [key,v]of Object.entries(value))if(key!=='field_group_data'&&key!=='possible_values'&&key!=='value'&&key!=='default_value')walk(v,current,depth+1);
 }
 walk(raw);
 if(!recognized)throw error(502,'התקבלה תשובה ללא מבנה שדות מוכר.');
 return {groups:[...groups.values()],fieldCount:fields.size,raw};
}
