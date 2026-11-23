import {randomUUID} from 'node:crypto';
import {applyImportMapping} from './public/import-mapping.js';
import {validateImportRelationRules} from './relation-finalizer.mjs';
export function validateImportPreset(b,connectionId,schemas,current){
 const bad=m=>{throw Object.assign(new Error(m),{status:422});};
 if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>80)bad('שם פריסט נדרש, עד 80 תווים.');
 if(typeof b.sourceScope!=='string'||b.sourceScope.length>200)bad('הקשר מקור לא תקין.');
 if(!Array.isArray(b.rules)||!b.rules.length)bad('מיפוי פריסט חסר או גדול מדי.');
 const seen=new Set();const rules=b.rules.map(r=>{
  if(typeof r.sourceId!=='string'||!r.sourceId||r.sourceId.length>200||seen.has(r.sourceId))bad('ישות מקור חסרה או כפולה.');seen.add(r.sourceId);
  const schema=schemas.get(r.targetId);if(!schema)bad('מבנה ישות היעד אינו זמין.');
  if(!Array.isArray(r.mapping))bad('מיפוי קבוצות לא תקין.');
  const mapping=r.mapping.map(m=>{if(typeof m.sourceGroup!=='string'||typeof m.targetGroup!=='string'||!Array.isArray(m.fields))bad('מיפוי קבוצה לא תקין.');return {sourceGroup:m.sourceGroup,targetGroup:m.targetGroup,fields:m.fields.map(f=>({sourceField:f.sourceField,targetFields:Array.isArray(f.targetFields)?[...new Set(f.targetFields)]:[f.targetField]}))};});
  const fake={meta:{dataName:r.sourceId},records:[{id:'preset-validation',matchKey:'preset-validation',data:Object.fromEntries(mapping.map(m=>[m.sourceGroup,[Object.fromEntries(m.fields.map(f=>[f.sourceField,null]))]]))}]};
  const k=r.targetKey;if(k?.kind!=='recordId'){const g=schema.groups.find(g=>g.id===k?.groupId),f=g?.fields.find(f=>f.id===k?.fieldId);if(k?.kind!=='field'||!f||g.repeatable||f.readonly||f.reference||/metadata|formula|file/i.test(f.type))bad('מפתח הצלבה אינו מתאים.');}
  const relationStaging=r.relationStaging?{groupId:r.relationStaging.groupId,fieldId:r.relationStaging.fieldId}:null;applyImportMapping(fake,schema,mapping,relationStaging,r.targetId);
  return {sourceId:r.sourceId,targetId:r.targetId,targetKey:k.kind==='recordId'?{kind:'recordId'}:{kind:'field',groupId:k.groupId,fieldId:k.fieldId},mapping,relationStaging};
 });
 let relations;
 try{relations=validateImportRelationRules(b.relations??[],{mappings:rules,schemas});}
 catch(error){bad(error.message||'כללי הקישור בפריסט אינם תקינים.');}
 return {relations,id:current?.id||randomUUID(),connectionId,sourceScope:b.sourceScope,name:b.name.trim(),rules,updatedAt:new Date().toISOString()};
}
