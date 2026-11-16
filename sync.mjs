import {applyImportMapping} from './public/import-mapping.js';
import {readOrigami} from './origami.mjs';
const bad=m=>{throw Object.assign(new Error(m),{status:422});};
export function updatedField(schema){let found;function walk(x){if(!x||typeof x!=='object')return;if(x.field_type_name==='metadata-field'&&x.possible_values==='last_modified'&&!x.original_field_type_name)found=x.field_data_name;for(const [k,v]of Object.entries(x))if(k!=='possible_values'&&v&&typeof v==='object'){if(Array.isArray(v))v.forEach(walk);else walk(v);}}walk(schema.raw);return found;}
export function dateRange(input){if(!input)return null;const from=Date.parse(input.from),to=Date.parse(input.to);if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)bad('טווח תאריכים לא תקין.');return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};}
export function exportParams(entityId,schema,range){const params={entity_data_name:entityId,limit:[0,100]};if(range){const field=updatedField(schema);if(!field)bad('אין בישות שדה מטא־דאטה מסוג תאריך עדכון. לא ניתן לאמת סינון: '+entityId);params.filter=[[field,'>=',range.from],[field,'<',range.to]];}return params;}
export function verifyWindow(raw,range){if(!Array.isArray(raw.data))bad('מבנה תשובה לא מוכר.');if(range)for(const r of raw.data){const t=Date.parse(r.instance_data?.lastModified);if(!Number.isFinite(t)||t<Date.parse(range.from)||t>=Date.parse(range.to))bad('ה־API החזיר רשומה מחוץ לטווח או ללא תאריך עדכון. הייצוא נעצר.');}}
export function validateEntity(entity){
 if(!entity||typeof entity.meta?.dataName!=='string'||!Array.isArray(entity.records))bad('חבילת ייבוא לא תקינה.');
 const ids=new Set(),keys=new Set();for(const r of entity.records){if(!r||typeof r.id!=='string'||!r.id||!['string','number'].includes(typeof r.matchKey)||!String(r.matchKey).trim()||!r.data||typeof r.data!=='object'||Array.isArray(r.data))bad('רשומה לא תקינה בחבילה.');if(ids.has(r.id)||keys.has(String(r.matchKey)))bad('מזהה או מפתח כפול בחבילה.');ids.add(r.id);keys.add(String(r.matchKey));for(const rows of Object.values(r.data)){if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))bad('מבנה קבוצות לא תקין בחבילה.');}}
 return entity;
}
function lookupValue(instance,key){if(key.kind==='recordId')return instance?._id;const g=instance?.field_groups?.find(g=>g.field_group_data?.group_data_name===key.groupId);return g?.fields_data?.[0]?.find(f=>f.field_data_name===key.fieldId)?.value;}
const storedGroupIndex=row=>{const values=(row||[]).map(cell=>Number(cell?.group_index)).filter(Number.isFinite);return values.length?values[0]:null;};
const targetRepeatRows=(target,gid)=>target?.field_groups?.find(group=>group.field_group_data?.group_data_name===gid)?.fields_data||[];
const comparable=value=>{
 if(value&&typeof value==='object'&&!Array.isArray(value)){if(value.text!==undefined)return comparable(value.text);if(value.value!==undefined)return comparable(value.value);}
 if(value===null||value===undefined)return '';if(typeof value==='boolean')return value?'1':'0';return String(value);
};
const existingValue=(target,gid,fid,index=0)=>{const rows=target?.field_groups?.find(group=>group.field_group_data?.group_data_name===gid)?.fields_data||[];const row=rows.find(r=>storedGroupIndex(r)===index)||rows[index]||[];return row.find(f=>f.field_data_name===fid)?.value;};
const writableValue=(value,field)=>{
 if(/datetime|input-time/i.test(field.type||'')&&value&&typeof value==='object'&&!Array.isArray(value)&&['string','number'].includes(typeof value.text))return String(value.text);
 return value;
};
export async function dryRunEntity({connection,entity,targetId,targetKey,schema,mapping,relationStaging,relationData={},read=readOrigami,guard=()=>{},onDebug=()=>{},onProgress=()=>{}}){
 validateEntity(entity);
 if(mapping!==undefined)entity=applyImportMapping(entity,schema,mapping,relationStaging,targetId);
 if(targetKey?.kind==='field'){const g=schema.groups.find(g=>g.id===targetKey.groupId),f=g?.fields.find(f=>f.id===targetKey.fieldId);if(!f||g.repeatable||f.readonly||/metadata|file|formula/i.test(f.type))bad('שדה הצלבה ביעד אינו מתאים.');}
 else if(targetKey?.kind!=='recordId')bad('בחרו שדה הצלבה ביעד.');
 const rows=[];let processedRecords=0;const totalRecords=entity.records.length;
 for(const record of entity.records){
  guard();const key=targetKey.kind==='recordId'?'_id':targetKey.fieldId,value=record.matchKey;
  const search={entity_data_name:targetId,filter:[[key,'=',value]],limit:[0,2]};
  const raw=await read(connection,'instance_data',search,onDebug,guard);guard();
  if(!Array.isArray(raw.data))bad('תשובת חיפוש לא מוכרת.');
  const matches=raw.data.map(x=>x.instance_data),total=Number(raw.info?.total_count??matches.length),reasons=[],warnings=[];
  if(!Number.isFinite(total)||total!==matches.length||total>1)reasons.push('החיפוש אינו חד־משמעי או שהתשובה חלקית.');
  if(matches.some(r=>String(lookupValue(r,targetKey))!==String(value)))reasons.push('תוצאת החיפוש אינה תואמת את המפתח. ייתכן שהפילטר לא הופעל.');
  const target=matches.length===1?matches[0]:null,form=[],fields=[],additional=[];if(target&&(typeof target._id!=='string'||!target._id))bad('תוצאת יעד ללא מזהה.');
  for(const [gid,dataRows]of Object.entries(record.data)){
   const g=schema.groups.find(g=>g.id===gid);if(!g){reasons.push('קבוצה חסרה ביעד: '+gid);continue;}
   if(!g.repeatable&&dataRows.length>1){reasons.push('מספר שורות בקבוצה רגילה: '+gid);continue;}
   const sourceRows=g.repeatable?dataRows:dataRows.slice(0,1),outRows=[];
   if(g.repeatable&&target&&dataRows.length&&!Array.isArray(record.groupIndexes?.[gid]))warnings.push('חבילה ישנה ללא group_index שמור; הקבוצה החוזרת הותאמה לפי סדר השורות: '+gid);
   const existingRepeatIndexes=g.repeatable&&target?new Set(targetRepeatRows(target,gid).map(storedGroupIndex).filter(Number.isFinite)):new Set();
   for(let rowIndex=0;rowIndex<sourceRows.length;rowIndex++){
    const sourceGroupIndex=g.repeatable&&Number.isFinite(Number(record.groupIndexes?.[gid]?.[rowIndex]))?Number(record.groupIndexes[gid][rowIndex]):rowIndex;
    const out=Object.create(null);
    for(let [fid,value]of Object.entries(sourceRows[rowIndex]||{})){
    const f=g.fields.find(f=>f.id===fid);if(!f){reasons.push('שדה חסר ביעד: '+fid);continue;}
    if(f.readonly||f.reference||/metadata|formula|file|upload|signature/i.test(f.type)){warnings.push('שדה מחושב/קריאה בלבד/קובץ הוחרג: '+fid);continue;}
    const isRelation=/^(?:(?:multi-)?select-from-entity|user-field|assign-field)$/.test(f.type||'');if(isRelation){const resolved=relationData[record.id]?.[JSON.stringify([gid,fid])];if(resolved?.status==='omitted'){warnings.push('שדה קישור דולג לפי ההגדרה: '+(f.name||fid)+' ('+fid+')');continue;}if(resolved?.status!=='resolved'){reasons.push(resolved?.reason||'יש להשלים FETCH RELATIONS לשדה '+fid);continue;}value=resolved.value;}
    value=writableValue(value,f);
    if(/telephone/i.test(f.type)&&typeof value!=='string'){reasons.push('שדה טלפון דורש מחרוזת; לא ניתן להמיר אוטומטית: '+(f.name||fid)+' ('+fid+')');continue;}
    if(!isRelation&&(/entity|assign|user-field|address|api-field/i.test(f.type)||value&&typeof value==='object')){reasons.push('נדרשת המרה או מיפוי ערך: '+(f.name||fid)+' ('+fid+')');continue;}
    out[fid]=value;
    }
    if(Object.keys(out).length){
     outRows.push(out);
     if(!target||!g.repeatable)for(const [fid,value]of Object.entries(out))fields.push([fid,value,0]);
     else if(existingRepeatIndexes.has(sourceGroupIndex))for(const [fid,value]of Object.entries(out))fields.push([fid,value,sourceGroupIndex]);
     else additional.push({operation:'add_group_repetition',body:{entity_data_name:targetId,_id:target._id,group_data_name:gid,group_data:out},groupId:gid,sourceGroupIndex});
    }
   }
   if(outRows.length&&!target)form.push({group_data_name:gid,data:outRows});
  }
  if(targetKey.kind==='field'){
   let g=form.find(g=>g.group_data_name===targetKey.groupId);if(!g){g={group_data_name:targetKey.groupId,data:[Object.create(null)]};form.push(g);}g.data[0][targetKey.fieldId]=record.matchKey;
   const existing=fields.find(f=>f[0]===targetKey.fieldId);if(existing)existing[1]=record.matchKey;else fields.push([targetKey.fieldId,record.matchKey,0]);
  }
  const supportedWrites=fields.length+additional.length;
  if(target&&fields.length)fields.splice(0,fields.length,...fields.filter(([fid,value,index])=>{const group=schema.groups.find(g=>g.fields.some(f=>f.id===fid));return comparable(existingValue(target,group?.id,fid,index))!==comparable(value);}));
  const noChanges=!!target&&supportedWrites>0&&!fields.length&&!additional.length;
  if(!target&&!form.length||target&&!supportedWrites)reasons.push('אין שדות נתמכים לכתיבה.');
  if(!target&&targetKey.kind==='recordId')reasons.push('מפתח ההצלבה מהייצוא לא נמצא ב־_id של היעד. לא ניתן ליצור רשומה עם _id כפוי; בדקו את ערך המפתח או בחרו שדה מזהה חיצוני ביעד.');
  const action=target?'update':'create';
  const requests=[];
  if(target&&fields.length)requests.push({operation:'update_instance_fields',body:{entity_data_name:targetId,filter:[['_id','=',target._id]],field:fields}});
  if(!target)requests.push({operation:'create_instance',body:{entity_data_name:targetId,form_data:form}});
  requests.push(...additional);
  const first=requests[0]||{operation:target?'update_instance_fields':'create_instance',body:{}};
  const request={method:'POST',operation:first.operation,url:connection.baseUrl.replace(/\/+$/,'')+'/entities/api/'+first.operation+'/format/json',body:first.body};
  rows.push({sourceId:record.id,matchKey:record.matchKey,targetId:target?._id||null,action,status:reasons.length?'blocked':noChanges?'skipped':'planned',reasons:[...new Set(reasons)],warnings:[...new Set(warnings),...(noChanges?['לא נמצאו שינויים לעדכון.']:[])],search,request:{...request,sent:false},requests:requests.map(step=>({...step,sent:false})),validation:'תכנון מקומי בלבד; ולידציות עסקיות של כתיבה לא נבדקו'});
  processedRecords++;onProgress({processed:processedRecords,total:totalRecords});
 }
 return {sourceEntity:entity.meta.dataName,name:entity.meta.name||entity.meta.dataName,targetEntity:targetId,mapping:mapping??[],relationStaging:relationStaging??null,dryRun:true,writeRequestsSent:0,counts:{records:rows.length,update:rows.filter(r=>r.action==='update'&&r.status==='planned').length,create:rows.filter(r=>r.action==='create'&&r.status==='planned').length,skipped:rows.filter(r=>r.status==='skipped').length,blocked:rows.filter(r=>r.status==='blocked').length},rows};
}
