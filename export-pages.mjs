import {exportParams,verifyWindow} from './sync.mjs';
import {exportEntity} from './transfer.mjs';
import {readOrigami} from './origami.mjs';
const changed=message=>Object.assign(new Error(message),{code:'EXPORT_SNAPSHOT_CHANGED'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const EXPORT_PAGE_SIZE=500;
async function exportAttempt({connection,config,schema,range,guard,onDebug,onProgress,read,attempt,maxAttempts}){
 const ids=new Set(),keys=new Map();let total=null,result,offset=0,pageNumber=0;
 do{
  guard();const params=exportParams(config.entityId,schema,range);params.limit=[offset,EXPORT_PAGE_SIZE];
  const raw=await read(connection,'instance_data',params,onDebug,guard);guard();verifyWindow(raw,range);
  const count=Number(raw.info?.total_count);
  if(raw.info?.total_count==null||!Number.isSafeInteger(count)||count<0)throw Error('מספר התוצאות חסר בתשובת הייצוא.');
  if(total!==null&&total!==count)throw changed('מספר התוצאות השתנה במהלך הייצוא.');
  total=count;const page=exportEntity(raw,config,schema);
  for(const record of page.records){if(ids.has(record.id))throw changed('העמודים השתנו במהלך הייצוא.');ids.add(record.id);const key=String(record.matchKey),owners=keys.get(key)||[];owners.push(record.id);keys.set(key,owners);}
  if(!result)result={meta:page.meta,records:[]};result.records.push(...page.records);offset+=page.records.length;pageNumber++;
  onProgress({phase:'fetching',attempt,maxAttempts,page:pageNumber,pageSize:EXPORT_PAGE_SIZE,records:offset,total,percent:total?Math.min(100,Math.floor(offset*100/total)):100});
  if(offset>total||(!page.records.length&&offset<total))throw changed('ה־API השתנה בין עמודי הייצוא.');
 }while(offset<total);
 result.meta={...result.meta,dateRange:range,sample:false,recordCount:offset,totalAvailable:total};result.conflicts=[...keys].filter(([,recordIds])=>recordIds.length>1).map(([matchKey,recordIds])=>({matchKey,recordIds}));return result;
}
export async function exportAll({connection,config,schema,range,guard=()=>{},onDebug=()=>{},onProgress=()=>{},read=readOrigami,retries=2,retryDelayMs=300}){
 let last;
 for(let attempt=0;attempt<=retries;attempt++){
  try{return await exportAttempt({connection,config,schema,range,guard,onDebug,onProgress,read,attempt:attempt+1,maxAttempts:retries+1});}
  catch(error){if(error?.code!=='EXPORT_SNAPSHOT_CHANGED')throw error;last=error;if(attempt===retries)break;guard();onProgress({phase:'retrying',attempt:attempt+2,maxAttempts:retries+1,page:0,pageSize:EXPORT_PAGE_SIZE,records:0,total:null,percent:0,message:error.message});if(retryDelayMs>0)await wait(retryDelayMs*(attempt+1));}
 }
 throw Object.assign(new Error('הישות השתנתה בזמן הייצוא גם לאחר ניסיונות חוזרים. נסו חלון תאריכים מוקדם יותר.'),{cause:last});
}
