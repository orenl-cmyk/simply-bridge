import {randomUUID} from 'node:crypto';
import {excludedEntity} from './origami.mjs';
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
export function validatePreset(body,connectionId,schemas,previous){
 const name=typeof body.name==='string'?body.name.trim():'';
 if(!name||name.length>80)invalid('יש להזין שם Preset באורך של עד 80 תווים.');
 if(!Array.isArray(body.entities)||!body.entities.length)invalid('בחרו לפחות ישות אחת.');
 const seen=new Set();
 const entities=body.entities.map(e=>{
  if(!e||typeof e.entityId!=='string'||seen.has(e.entityId)||excludedEntity({entity_data_name:e.entityId}))invalid('בחירת ישות לא תקינה.');seen.add(e.entityId);
  const schema=schemas.get(e.entityId);if(!schema)invalid('טענו את מבנה הישות לפני שמירת Preset: '+e.entityId);
  if(!Array.isArray(e.fields)||!e.fields.length)invalid('בחרו לפחות שדה אחד בישות '+e.entityId);
  const fields=[],fieldKeys=new Set();
  for(const f of e.fields){if(!f||typeof f.groupId!=='string'||typeof f.fieldId!=='string')invalid('הגדרת שדה לא תקינה.');const g=schema.groups.find(g=>g.id===f.groupId);if(!g?.fields.some(x=>x.id===f.fieldId))invalid('שדה אינו קיים במבנה העדכני: '+e.entityId);const key=JSON.stringify([f.groupId,f.fieldId]);if(fieldKeys.has(key))invalid('שדה נבחר פעמיים.');fieldKeys.add(key);fields.push({groupId:f.groupId,fieldId:f.fieldId});}
  let key={kind:'recordId'};
  if(e.key?.kind==='field'){
   const g=schema.groups.find(g=>g.id===e.key.groupId);if(!g||g.repeatable||!g.fields.some(f=>f.id===e.key.fieldId))invalid('מפתח ההצלבה חייב להיות שדה בקבוצה שאינה חוזרת.');
   key={kind:'field',groupId:e.key.groupId,fieldId:e.key.fieldId};if(!fieldKeys.has(JSON.stringify([key.groupId,key.fieldId])))invalid('שדה מפתח ההצלבה חייב להיכלל בשדות לייצוא.');
  }else if(e.key?.kind!=='recordId')invalid('בחרו מפתח הצלבה לכל ישות.');
  return {entityId:e.entityId,fields,key};
 });
 return {id:previous?.id||randomUUID(),connectionId,name,entities,createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
}
