import {randomUUID} from 'node:crypto';
const bad=message=>{throw Object.assign(new Error(message),{status:422});};
export const isFile=f=>/upload|file|attachment|signature/i.test(f.type);
export function exportEntity(raw,config,schema){
 if(!Array.isArray(raw.data))bad('תשובת הרשומות אינה במבנה מוכר.');
 if(raw.entity_data?.entity_data_name&&raw.entity_data.entity_data_name!==config.entityId)bad('התקבלו רשומות מישות אחרת.');
 const excludedFields=config.fields.filter(f=>isFile(schema.groups.find(g=>g.id===f.groupId).fields.find(x=>x.id===f.fieldId)));
 if(config.key.kind==='field'&&excludedFields.some(f=>f.groupId===config.key.groupId&&f.fieldId===config.key.fieldId))bad('שדה קובץ אינו יכול לשמש מפתח הצלבה.');
 const fields=config.fields.filter(f=>!excludedFields.includes(f)).map(selection=>{const group=schema.groups.find(g=>g.id===selection.groupId),field=group.fields.find(f=>f.id===selection.fieldId);return {...selection,groupName:group.name||group.id,fieldName:field.name||field.id,type:field.type};});
 if(!fields.length)bad('אין שדות לייצוא לאחר החרגת קבצים: '+config.entityId);
 const ids=new Set();
 const records=raw.data.map(item=>{
  const r=item.instance_data;if(!r||typeof r._id!=='string'||!r._id||!Array.isArray(r.field_groups))bad('רשומה ללא מזהה או קבוצות מוכרות.');
  if(ids.has(r._id))bad('מזהה רשומה כפול בתשובה.');ids.add(r._id);
  const data=Object.create(null),groupIndexes=Object.create(null);
  for(const gid of new Set(fields.map(f=>f.groupId))){
   const group=r.field_groups.find(g=>g.field_group_data?.group_data_name===gid);
   if(!group)continue;
   if(group.empty==='1'||String(group.field_group_data?.empty)==='1'){data[gid]=[];continue;}
   if(!Array.isArray(group.fields_data)||!group.fields_data.every(Array.isArray))bad('מבנה שורות לא מוכר בקבוצה '+gid);
   data[gid]=group.fields_data.map(row=>{const out=Object.create(null);for(const f of row){if(fields.some(x=>x.groupId===gid&&x.fieldId===f.field_data_name)&&Object.hasOwn(f,'value'))out[f.field_data_name]=f.value;}return out;});
   if(schema.groups.find(g=>g.id===gid)?.repeatable)groupIndexes[gid]=group.fields_data.map((row,index)=>{const stored=row.map(cell=>Number(cell?.group_index)).find(Number.isFinite);return stored??index;});
  }
  const matchKey=config.key.kind==='recordId'?r._id:data[config.key.groupId]?.[0]?.[config.key.fieldId];
  if(!['string','number'].includes(typeof matchKey)||String(matchKey).trim()===''||!Number.isFinite(typeof matchKey==='number'?matchKey:0))bad('מפתח הצלבה חסר או אינו ערך פשוט ברשומה '+r._id);
  return {id:r._id,matchKey,...(r.lastModified?{updatedAt:r.lastModified}:{}),data,...(Object.keys(groupIndexes).length?{groupIndexes}:{})};
 });
 return {meta:{dataName:config.entityId,name:raw.entity_data?.entity_name||schema.raw?.entity_data?.entity_name||config.entityId,key:config.key,fields,excludedFields,recordCount:records.length,totalAvailable:raw.info?.total_count??null,exportedAt:new Date().toISOString(),dateRange:null},records};
}
export function createPackage(entities,presetName){return {meta:{schemaVersion:'1.0',packageId:randomUUID(),createdAt:new Date().toISOString(),application:'SIMPLY BRIDGE',mode:'full',presetName,dateRange:null},entities};}
