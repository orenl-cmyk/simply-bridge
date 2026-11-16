export const relationFieldType=type=>/^(?:(?:multi-)?select-from-entity|user-field|assign-field)$/.test(type||'');
export const textFieldType=type=>/text|textarea|input-area|multi.?line|long.?text/i.test(type||'');
const bad=m=>{throw Object.assign(new Error(m),{status:422});};

export function validateRelationStaging(schema,staging){
 if(!staging||typeof staging.groupId!=='string'||typeof staging.fieldId!=='string')bad('בחרו שדה אזור טקסט לשמירת JSON הקישורים.');
 const group=schema?.groups.find(g=>g.id===staging.groupId),field=group?.fields.find(f=>f.id===staging.fieldId);
 if(!field||group.repeatable||field.readonly||field.reference)bad('שדה JSON הקישורים חייב להיות שדה כתיב רגיל בקבוצה שאינה חוזרת.');
 return {groupId:group.id,fieldId:field.id};
}

export function sourceLayout(entity){
 const groups=new Map();const add=(g,f)=>{if(typeof g!=='string')return;if(!groups.has(g))groups.set(g,new Set());if(typeof f==='string')groups.get(g).add(f);};
 for(const field of entity?.meta?.fields||[])add(field?.groupId,field?.fieldId);
 for(const r of entity.records||[])for(const [g,rows]of Object.entries(r.data||{}))for(const row of rows||[])for(const f of Object.keys(row||{}))add(g,f);
 return [...groups].map(([id,fields])=>({id,fields:[...fields]}));
}

const valuesOf=value=>Array.isArray(value)?value:[value];
const compact=values=>[...new Set(values.filter(v=>v!==undefined&&v!==null&&v!=='').map(v=>String(v)))];
function candidates(value,record){
 const values=valuesOf(value),objects=values.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)),scalars=values.filter(v=>['string','number','boolean'].includes(typeof v));
 return {ID:compact([...objects.flatMap(v=>[v.instance_id,v._id,v.id]),...scalars]),TEXT:compact([...objects.map(v=>v.text??v.name??v.label),...scalars]),VALUE:compact(scalars),SOURCE_RECORD_ID:record.id==null?[]:[String(record.id)],SOURCE_MATCH_KEY:record.matchKey==null?[]:[String(record.matchKey)]};
}

export function applyImportMapping(entity,schema,mapping=[],relationStaging=null,targetEntity=''){
 if(!Array.isArray(mapping))bad('מיפוי הייבוא אינו תקין.');
 const mappedValue=(value,field)=>{
  const link=value&&typeof value==='object'&&!Array.isArray(value)&&('instance_id'in value||'text'in value);
  if(link&&textFieldType(field.type)&&['string','number'].includes(typeof value.text))return value.text;
  if(/datetime|input-time/i.test(field.type||'')&&value&&typeof value==='object'&&!Array.isArray(value)&&['string','number'].includes(typeof value.text))return String(value.text);
  return value;
 };
 const layout=sourceLayout(entity),sourceIds=new Set(),targetIds=new Set(),resolved=new Map();
 for(const m of mapping){if(!m||typeof m.sourceGroup!=='string'||sourceIds.has(m.sourceGroup)||!layout.some(g=>g.id===m.sourceGroup))bad('קבוצת מקור לא תקינה או כפולה במיפוי.');sourceIds.add(m.sourceGroup);}
 for(const source of layout){
  const m=mapping.find(m=>m.sourceGroup===source.id),targetId=m?m.targetGroup:source.id,g=schema.groups.find(g=>g.id===targetId);
  if(!g)bad('יש למפות קבוצת מקור '+source.id+' לקבוצה קיימת ביעד.');
  if(targetIds.has(targetId))bad('שתי קבוצות מקור מופנות לאותה קבוצת יעד: '+targetId);targetIds.add(targetId);
  const pairs=m?.fields??[];if(!Array.isArray(pairs))bad('מיפוי שדות לא תקין.');
  const normalizedPairs=new Map(),destinations=new Map(),fields=new Map(),targetFields=new Map();
  for(const pair of pairs){
   if(!pair||!source.fields.includes(pair.sourceField))bad('שדה מקור אינו קיים בקובץ: '+String(pair?.sourceField||''));
   const targets=Array.isArray(pair.targetFields)?pair.targetFields:[pair.targetField];
   normalizedPairs.set(pair.sourceField,[...(normalizedPairs.get(pair.sourceField)||[]),...targets]);
  }
  for(const fid of source.fields){const targetIds=normalizedPairs.has(fid)?normalizedPairs.get(fid):(m?[]:[fid]),unique=[...new Set(targetIds.filter(x=>typeof x==='string'&&x))];if(!unique.length){fields.set(fid,[]);targetFields.set(fid,[]);continue;}const targetSchemas=unique.map(id=>g.fields.find(f=>f.id===id));if(targetSchemas.some(f=>!f))bad('שדה היעד שנבחר עבור '+source.id+'/'+fid+' אינו קיים בקבוצת היעד '+targetId);for(const targetField of targetSchemas){if(targetField.readonly||targetField.reference||/metadata|formula|file|upload|signature/i.test(targetField.type||''))bad('לא ניתן לכתוב לשדה היעד '+targetField.id);const owner=destinations.get(targetField.id);if(owner&&owner!==fid)bad('שני שדות מקור מופנים לאותו שדה יעד: '+targetField.id);destinations.set(targetField.id,fid);}fields.set(fid,unique);targetFields.set(fid,targetSchemas);}
  resolved.set(source.id,{targetId,group:g,fields,targetFields});
 }
 const hasRelations=[...resolved.values()].some(r=>[...r.targetFields.values()].flat().some(f=>relationFieldType(f.type)));
 const staging=hasRelations?validateRelationStaging(schema,relationStaging):null;
 const stagingField=staging&&schema.groups.find(g=>g.id===staging.groupId)?.fields.find(f=>f.id===staging.fieldId);
 if(staging&&[...resolved.values()].some(m=>m.targetId===staging.groupId&&[...m.fields.values()].flat().includes(staging.fieldId)))bad('שדה JSON הקישורים אינו יכול לשמש גם יעד של שדה רגיל.');
 const sourceMeta=new Map((entity?.meta?.fields||[]).map(f=>[JSON.stringify([f.groupId,f.fieldId]),f]));
 return {...entity,records:(entity.records||[]).map(record=>{
  const data=Object.create(null),relations=[];
  for(const [gid,rows]of Object.entries(record.data||{})){
   const m=resolved.get(gid);if(!m)continue;const normal=[];
   (rows||[]).forEach((row,rowIndex)=>{const out={};for(const [fid,value]of Object.entries(row||{})){
    const targets=m.targetFields.get(fid),targetIds=m.fields.get(fid);if(!targets)continue;
    for(let targetIndex=0;targetIndex<targets.length;targetIndex++){const targetField=targets[targetIndex],targetFieldId=targetIds[targetIndex];
     if(relationFieldType(targetField.type)){const source=sourceMeta.get(JSON.stringify([gid,fid]));relations.push({source:{entity:entity.meta?.dataName||'',recordId:record.id??null,matchKey:record.matchKey??null,groupId:gid,groupName:source?.groupName||gid,fieldId:fid,fieldName:source?.fieldName||fid,rowIndex,value:structuredClone(value)},target:{entity:targetEntity||'',groupId:m.targetId,groupName:m.group?.name||m.targetId,fieldId:targetFieldId,fieldName:targetField.name||targetFieldId},candidates:candidates(value,record)});continue;}
     out[targetFieldId]=mappedValue(value,targetField);
    }
   }normal.push(out);});data[m.targetId]=normal;
  }
  if(staging){const payload={version:1,sourceEntity:entity.meta?.dataName||'',sourceRecordId:record.id??null,sourceMatchKey:record.matchKey??null,targetEntity:targetEntity||'',relations},json=JSON.stringify(payload);if(textFieldType(stagingField?.type)&&json.length>9999)bad('JSON הקישורים ארוך מ־9,999 תווים עבור שדה הטקסט שנבחר ברשומה '+record.id);data[staging.groupId]??=[{}];data[staging.groupId][0]??={};data[staging.groupId][0][staging.fieldId]=json;}
  const groupIndexes=Object.fromEntries(Object.entries(record.groupIndexes||{}).map(([sourceId,indexes])=>[resolved.get(sourceId)?.targetId||sourceId,structuredClone(indexes)]));
  return {...record,data,...(Object.keys(groupIndexes).length?{groupIndexes}:{})};
 })};
}
