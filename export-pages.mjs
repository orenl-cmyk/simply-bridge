import {exportParams,verifyWindow} from './sync.mjs';
import {exportEntity} from './transfer.mjs';
import {readOrigami} from './origami.mjs';
export async function exportAll({connection,config,schema,range,guard=()=>{},onDebug=()=>{},read=readOrigami}){
 const ids=new Set(),keys=new Set();let total=null,result,offset=0;
 do{
  guard();const params=exportParams(config.entityId,schema,range);params.limit=[offset,100];
  const raw=await read(connection,'instance_data',params,onDebug,guard);guard();verifyWindow(raw,range);
  const count=Number(raw.info?.total_count);
  if(raw.info?.total_count==null||!Number.isSafeInteger(count)||count<0||(total!==null&&total!==count))throw Error('מספר התוצאות חסר או השתנה במהלך הייצוא. נסו שוב.');
  total=count;const page=exportEntity(raw,config,schema);
  for(const record of page.records){if(ids.has(record.id)||keys.has(String(record.matchKey)))throw Error('מזהה או מפתח כפול בין עמודי הייצוא. הייצוא נעצר.');ids.add(record.id);keys.add(String(record.matchKey));}
  if(!result)result={meta:page.meta,records:[]};result.records.push(...page.records);offset+=page.records.length;
  if(offset>total||(!page.records.length&&offset<total))throw Error('ה־API החזיר עמוד חלקי או ריק לפני השלמת הייצוא.');
 }while(offset<total);
 result.meta={...result.meta,dateRange:range,sample:false,recordCount:offset,totalAvailable:total};return result;
}
