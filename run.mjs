import {origamiLimiter} from './rate-limit.mjs';
// Writes are deliberately single-attempt: a timeout does not prove the write failed.
export async function writeSimply(connection,operation,params,onDebug=()=>{},guard=()=>{}){
 if(!['create_instance','update_instance_fields'].includes(operation))throw Error('Unsupported write operation');
 return origamiLimiter.run(async()=>{
  guard();const started=Date.now(),url=connection.baseUrl.replace(/\/+$/,'')+'/entities/api/'+operation+'/format/json';
  const redact=x=>{if(typeof x==='string'){for(const value of [connection.secret,connection.username].filter(Boolean))x=x.split(value).join('[REDACTED]');return x;}if(Array.isArray(x))return x.map(redact);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,/secret|password|token|authorization|cookie|username/i.test(k)?'[REDACTED]':redact(v)]));return x;};
  const debug={startedAt:new Date(started).toISOString(),operation,request:{url,method:'POST',body:{...params,username:'[REDACTED]',api_secret:'[REDACTED]'},timeoutMs:30000},response:null};
  const fail=(kind,message,details)=>Object.assign(new Error(message),{kind,details});
  try{
   const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({...params,username:connection.username,api_secret:connection.secret})});
   const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
   debug.response={status:response.status,bodyPreview:JSON.stringify(redact(data??text)).slice(0,12000)};
   if(data?.error?.type==='validation'&&[200,400,422].includes(response.status))throw fail('validation','הרשומה נדחתה בוולידציה של SIMPLY.',redact(data.error));
   if([401,403,429].includes(response.status))throw fail('stopped','השרת עצר את הבקשה: HTTP '+response.status,redact(data));
   if(!response.ok||data?.success!=='ok')throw fail('unknown','לא התקבל אישור כתיבה חד־משמעי. יש לבדוק ביעד לפני ניסיון נוסף.',redact(data??text));
   if(operation==='create_instance'&&(typeof data.results?._id!=='string'||!data.results._id))throw fail('unknown','תשובת יצירה ללא מזהה רשומה.',redact(data));
   if(operation==='update_instance_fields'&&Number(data.results?.instances_updated)!==1)throw fail('unknown','העדכון לא אישר שינוי של רשומה אחת בדיוק.',redact(data));
   debug.outcome='success';return {targetId:operation==='create_instance'?data.results._id:params.filter[0][2],response:redact(data)};
  }catch(e){debug.outcome='error';debug.error={kind:e.kind||'unknown',message:redact(e.message),details:e.details};if(e.kind)throw e;throw fail('unknown','החיבור נקטע או פג הזמן; ייתכן שהכתיבה בוצעה.',{message:redact(e.message)});}
  finally{debug.durationMs=Date.now()-started;onDebug(redact(debug));}
 });
}
export async function executeRow({planned,recheck,write,recordIntent,recordResult}){
 if(planned.status==='blocked')return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,status:'blocked',reasons:planned.reasons,warnings:planned.warnings,sent:false,stop:false};
 let fresh;
 try{fresh=await recheck();}catch(e){return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,status:'not_sent',sent:false,stop:true,error:{message:e.message}};}
 if(fresh.status!=='planned'||JSON.stringify(fresh.request.body)!==JSON.stringify(planned.request.body)||fresh.action!==planned.action)return {sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,status:'changed',sent:false,stop:true,error:{message:'הנתונים ביעד השתנו מאז ה־Dry Run. יש לבצע בדיקה חדשה.'}};
 await recordIntent();
 let result;
 try{const response=await write(fresh);result={sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:response.targetId,status:'succeeded',sent:true,stop:false,response:response.response,warnings:planned.warnings};}
 catch(e){result={sourceId:planned.sourceId,matchKey:planned.matchKey,action:planned.action,targetId:planned.targetId,status:e.kind==='validation'?'failed':e.kind==='stopped'?'stopped':'unknown',sent:true,stop:e.kind!=='validation',error:{message:e.message,details:e.details}};}
 await recordResult(result);return result;
}
