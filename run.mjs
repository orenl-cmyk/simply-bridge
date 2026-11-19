import {rateOptions,noteRateLimit,rateSnapshot} from './rate-limit.mjs';
import {postJson} from './transport.mjs';
import {classifyOrigamiResult} from './origami-result.mjs';
const retryDelay=response=>{const header=response?.headers?.get?.('retry-after'),numeric=header==null?NaN:Number(header),parsed=header?Date.parse(header)-Date.now():NaN;return Number.isFinite(numeric)?Math.max(1000,numeric*1000):Number.isFinite(parsed)?Math.max(1000,parsed):1000;};
// Unknown transport outcomes are never retried here. HTTP 429 is a definite rejection,
// so it is safe to reduce the rate and retry without risking a duplicate write.
export async function writeSimply(connection,operation,params,onDebug=()=>{},guard=()=>{}){
 if(!['create_instance','update_instance_fields','add_group_repetition'].includes(operation))throw Error('Unsupported write operation');
 const attempts=[];let lastDebug;
 for(let attempt=0;attempt<5;attempt++){
  const {state,spacingMs,maxConcurrent,maxRequestsPerHour}=rateOptions(connection);
  try{return await state.limiter.run(async()=>{
  guard();const started=Date.now(),url=connection.baseUrl.replace(/\/+$/,'')+'/entities/api/'+operation+'/format/json';
  const redact=x=>{if(typeof x==='string'){for(const value of [connection.secret,connection.username].filter(Boolean))x=x.split(value).join('[REDACTED]');return x;}if(Array.isArray(x))return x.map(redact);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,/secret|password|token|authorization|cookie|username/i.test(k)?'[REDACTED]':redact(v)]));return x;};
  const debug=lastDebug={startedAt:new Date(started).toISOString(),operation,request:{url,method:'POST',body:{...params,username:'[REDACTED]',api_secret:'[REDACTED]'},timeoutMs:30000},response:null};
  const fail=(kind,message,details)=>Object.assign(new Error(message),{kind,details});
  try{
   const response=await postJson(url,{...params,username:connection.username,api_secret:connection.secret},{timeoutMs:30000});
   const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
   debug.response={status:response.status,headers:Object.fromEntries(['retry-after','date'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null)),bodyPreview:JSON.stringify(redact(data??text)).slice(0,12000)};
   const classified=classifyOrigamiResult({status:response.status,data,responseOk:response.ok});
   if(classified.kind==='validation')throw fail('validation','הרשומה נדחתה בוולידציה של SIMPLY.',redact(classified.error));
   if(classified.kind==='rate_limit')throw Object.assign(fail('rate_limit','SIMPLY הגבילה את קצב הבקשות. הקצב יופחת והריצה תמתין.',redact(classified.error??data)),{pauseMs:retryDelay(response)});
   if(classified.kind==='authorization')throw fail('authorization','הבקשה נדחתה בהרשאה. בדקו את משתמש ה־API והמפתח בחיבור.',redact(classified.error??data));
   if(classified.kind==='system')throw fail('system','SIMPLY החזירה שגיאת מערכת. הפעולה תושהה כדי לא להציף תקלות זהות.',redact(classified.error??data));
   if(['api_error','http_error'].includes(classified.kind))throw fail('api_error','SIMPLY דחתה את הבקשה.',redact(classified.error??data));
   if(!response.ok||data?.success!=='ok')throw fail('unknown','לא התקבל אישור כתיבה חד־משמעי. יש לבדוק ביעד לפני ניסיון נוסף.',redact(data??text));
   if(operation==='create_instance'&&(typeof data.results?._id!=='string'||!data.results._id))throw fail('unknown','תשובת יצירה ללא מזהה רשומה.',redact(data));
   if(operation==='update_instance_fields'&&Number(data.results?.instances_updated)!==1)throw fail('unknown','העדכון לא אישר שינוי של רשומה אחת בדיוק.',redact(data));
   if(operation==='add_group_repetition'&&data.results?.new_max_group_index!==undefined&&!Number.isFinite(Number(data.results.new_max_group_index)))throw fail('unknown','הוספת שורת קבוצה לא החזירה אינדקס תקין.',redact(data));
   debug.outcome='success';return {targetId:operation==='create_instance'?data.results._id:operation==='update_instance_fields'?params.filter[0][2]:params._id,response:redact(data)};
  }catch(e){debug.outcome='error';debug.error={kind:e.kind||'unknown',message:redact(e.message),details:e.details};if(e.kind)throw e;throw fail('unknown','החיבור נקטע או פג הזמן; ייתכן שהכתיבה בוצעה.',{message:redact(e.message)});}
  finally{debug.durationMs=Date.now()-started;debug.attempts=structuredClone(attempts);debug.rateLimit={...rateSnapshot(connection),spacingMs};onDebug(redact(debug));}
  },{spacingMs,maxConcurrent,maxRequestsPerHour});}
  catch(e){attempts.push({attempt:attempt+1,status:lastDebug?.response?.status??null,kind:e.kind,message:e.message});if(e.kind!=='rate_limit'||attempt===4)throw e;noteRateLimit(connection,e.pauseMs||1000);}
 }
}
export async function executeRow({planned,write,recordIntent,recordResult,reconcile}){
 if(planned.status==='blocked')return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,status:'blocked',reasons:planned.reasons,warnings:planned.warnings,sent:false,stop:false};
 const sequence=row=>row.requests?.length?row.requests:[{operation:row.request.operation||(row.action==='create'?'create_instance':'update_instance_fields'),body:row.request.body}];
 try{await recordIntent();}catch(e){return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,status:'not_sent',sent:false,stop:false,error:{message:'לא ניתן לשמור יומן כתיבה לפני השליחה: '+e.message}};}
 let result,completed=[];
 try{let targetId=planned.targetId;for(const step of sequence(planned)){const response=await write(planned,step);targetId=response.targetId||targetId;completed.push({operation:step.operation,response:response.response});}result={sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId,status:'succeeded',sent:true,stop:false,responses:completed,warnings:planned.warnings};}
 catch(e){
  if(e.kind==='unknown'&&reconcile)try{result=await reconcile({planned,completed,error:e});}catch(reconcileError){result={sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:planned.targetId,status:'unknown',sent:true,partial:completed.length>0,completedRequests:completed,stop:false,error:{message:'לא ניתן להכריע אם הכתיבה בוצעה: '+reconcileError.message,details:e.details}};}
  else {const deferred=['rate_limit','authorization','system'].includes(e.kind);result={sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:planned.targetId,status:deferred?'deferred':e.kind==='validation'||e.kind==='api_error'?'failed':'unknown',sent:deferred?false:e.kind!=='rate_limit',partial:completed.length>0,completedRequests:completed,stop:deferred,error:{kind:e.kind||'unknown',message:e.message,details:e.details}};}
 }
 await recordResult(result);return result;
}
