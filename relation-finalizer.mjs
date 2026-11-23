import {batchLookup,checkKey} from './relations.mjs';
import {normalizeStructure,readOrigami} from './origami.mjs';
import {relationId,writeRelations} from './relation-write.mjs';

const key=(...values)=>JSON.stringify(values);
const present=value=>['number','string'].includes(typeof value)&&String(value).trim()!=='';

export function indexImportIdentities(plans,outcomes){
 const identities=new Map();
 for(const [planId,plan] of plans){
  for(const [index,row] of plan.result.rows.entries()){
   const outcome=outcomes.get(planId+':'+index);
   const id=outcome?.status==='succeeded'?outcome.targetId:row.status==='skipped'?row.targetId:null;
   const identity=key(plan.sourceEntity.meta.dataName,plan.targetId,row.sourceId);
   identities.set(identity,{id,matchKey:row.matchKey,failed:!id&&row.status!=='skipped'});
  }
 }
 return identities;
}

export function validateRelationRuleSets(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Relation rules must be keyed by connection ID');
 for(const rules of Object.values(raw)){
  if(!Array.isArray(rules))throw Error('Expected relation rules array');
  const seen=new Set();
  for(const rule of rules){
   if(!rule||!['sourceEntity','sourceRelatedEntity','targetEntity','groupId','fieldId'].every(field=>present(rule[field]))||
      !['packageKey','sourceText','sourceId'].includes(rule.valueMode)||
      rule.targetKey?.kind!=='field'||!present(rule.targetKey.groupId)||!present(rule.targetKey.fieldId)){
    throw Error('Invalid relation mapping rule');
   }
   const slot=key(rule.sourceEntity,rule.groupId,rule.fieldId);
   if(seen.has(slot))throw Error('Duplicate relation mapping rule');
   seen.add(slot);
  }
 }
 return new Map(Object.entries(raw));
}

export function validateImportRelationRules(raw,{mappings,schemas,allowMissingRelated=false}={}){
 const bad=message=>{throw Object.assign(new Error(message),{status:422});};
 if(!Array.isArray(raw))bad('כללי הקישור של הייבוא אינם תקינים.');
 if(!Array.isArray(mappings)||!(schemas instanceof Map))bad('חסר הקשר לאימות כללי הקישור.');
 let rules;
 try{rules=validateRelationRuleSets({run:raw}).get('run');}
 catch{bad('אחד מכללי הקישור חסר או אינו תקין.');}
 const bySource=new Map();
 for(const mapping of mappings){
  const source=mapping?.sourceId||mapping?.entity?.meta?.dataName;
  if(typeof source!=='string'||!source||typeof mapping.targetId!=='string')continue;
  const current=bySource.get(source);
  if(current&&current.targetId!==mapping.targetId)bad('ישות מקור אחת מופנית ליותר מישות יעד אחת.');
  bySource.set(source,mapping);
 }
 const normalized=[];
 for(const rule of rules){
  const owner=bySource.get(rule.sourceEntity);
  if(!owner)bad('כלל קישור מתייחס לישות מקור שאינה בחבילת הייבוא.');
  const ownerSchema=schemas.get(owner.targetId),group=ownerSchema?.groups?.find(item=>item.id===rule.groupId),field=group?.fields?.find(item=>item.id===rule.fieldId);
  if(!field||!['select-from-entity','multi-select-from-entity'].includes(field.type)||field.readonly||field.reference){
   bad('כלל קישור מתייחס לשדה יעד שאינו שדה קישור תקין.');
  }
  if(!owner.relationStaging||typeof owner.relationStaging.groupId!=='string'||typeof owner.relationStaging.fieldId!=='string'){
   bad('לישות המקור חסר שדה JSON לשמירת מעטפת הקישורים.');
  }
  const groupMappings=owner.mapping||[];
  const mapped=groupMappings.some(item=>item.targetGroup===rule.groupId&&
   (item.fields||[]).some(pair=>Array.isArray(pair.targetFields)?pair.targetFields.includes(rule.fieldId):pair.targetField===rule.fieldId))||
   (!groupMappings.some(item=>item.targetGroup===rule.groupId)&&
    (owner.sourceFields||[]).includes(JSON.stringify([rule.groupId,rule.fieldId])));
  if(!mapped)bad('כלל קישור אינו תואם למיפוי שדות הייבוא.');
  const targetSchema=schemas.get(rule.targetEntity);
  if(!targetSchema)bad('מבנה ישות היעד של כלל הקישור אינו זמין בחיבור הנוכחי.');
  try{checkKey(targetSchema,rule.targetKey);}catch{bad('מפתח החיפוש בכלל הקישור אינו מתאים לסכמת היעד.');}
  const related=bySource.get(rule.sourceRelatedEntity);
  if(related&&related.targetId!==rule.targetEntity)bad('ישות היעד של כלל הקישור אינה תואמת למיפוי הישות המקושרת.');
  if(rule.valueMode==='packageKey'&&!related&&!allowMissingRelated)bad('חיפוש לפי מפתח החבילה מחייב לכלול את הישות המקושרת בייבוא.');
  if(rule.onMissing!==undefined&&!['block','omit'].includes(rule.onMissing))bad('מדיניות החוסר בכלל הקישור אינה תקינה.');
  if(rule.resolutions!==undefined&&(!rule.resolutions||typeof rule.resolutions!=='object'||Array.isArray(rule.resolutions)||
   Object.entries(rule.resolutions).some(([value,id])=>!value||typeof id!=='string'||!id)))bad('בחירות התאמה ידניות בכלל הקישור אינן תקינות.');
  normalized.push({sourceEntity:rule.sourceEntity,sourceRelatedEntity:rule.sourceRelatedEntity,targetEntity:rule.targetEntity,
   groupId:rule.groupId,fieldId:rule.fieldId,valueMode:rule.valueMode,targetKey:structuredClone(rule.targetKey),
   onMissing:rule.onMissing||'block',resolutions:structuredClone(rule.resolutions||{})});
 }
 return normalized;
}

export function createRelationFinalizer({connection,rules,identities,schemas,cache=new Map(),loadSchema=async entity=>normalizeStructure(await readOrigami(connection,'entity_structure',{entity_data_name:entity})),onCache=async()=>{},lookup=batchLookup,write=writeRelations}){
 const byField=new Map(rules.map(rule=>[key(rule.sourceEntity,rule.groupId,rule.fieldId),rule]));

 return async ({envelope,entity,id,schema,indexes,recover,choices})=>{
  const fields=[],issues=[];
  for(const entry of envelope.relations){
   const {source,target}=entry;
   const group=schema.groups.find(group=>group.id===target.groupId);
   const field=group?.fields.find(field=>field.id===target.fieldId);
   const multi=field?.type==='multi-select-from-entity';
   const issue=(kind,message,details={})=>issues.push({kind,message,fieldId:target.fieldId,...details});
   if(!field||!['select-from-entity','multi-select-from-entity'].includes(field.type)){
    issue('invalid_mapping','סוג שדה הקישור דורש מיפוי נתמך.');
    continue;
   }
   const index=group.repeatable?indexes?.[target.groupId]?.[source.rowIndex]:0;
   if(!Number.isInteger(index)||index<0){
    issue('invalid_mapping','חסר אינדקס מאומת לשורת הקבוצה החוזרת.');
    continue;
   }
   const values=source.value===''||source.value===null?[]:multi?source.value:[source.value];
   if(!Array.isArray(values)){
    issue('invalid_mapping','ערך קישור מרובה אמור להיות מערך.');
    continue;
   }
   const rule=byField.get(key(source.entity,target.groupId,target.fieldId));
   try{
    const ids=new Set();
    let omitted=false;
    for(const value of values){
     if(!rule)throw Error('חסרה הגדרת הצלבה לשדה הקישור.');
     const sourceId=relationId(value);
     const known=identities.get(key(rule.sourceRelatedEntity,rule.targetEntity,sourceId));
     if(known?.id){ids.add(known.id);continue;}
     if(known?.failed)throw Error('ייבוא הרשומה המקושרת לא הושלם.');
     const match=rule.valueMode==='packageKey'?known?.matchKey:
      rule.valueMode==='sourceText'?(value?.text??value):sourceId;
     if(!present(match)||rule.targetKey.kind==='recordId'){
      throw Error('חסר מפתח הצלבה מאומת לחיפוש ביעד.');
     }
     if(!schemas.has(rule.targetEntity))schemas.set(rule.targetEntity,await loadSchema(rule.targetEntity));
     checkKey(schemas.get(rule.targetEntity),rule.targetKey);
     const cacheKey=key(rule.targetEntity,rule.targetKey,String(match));
     if(!cache.has(cacheKey)){
      const result=await lookup({connection,targetId:rule.targetEntity,key:rule.targetKey,values:[match]});
      const candidates=result.get(String(match));
      await onCache(cacheKey,candidates);
      cache.set(cacheKey,candidates);
     }
     const candidates=cache.get(cacheKey);
     const chosen=choices?.[cacheKey]||rule.resolutions?.[String(match)];
     if(candidates.length===1)ids.add(candidates[0]);
     else if(candidates.length>1&&candidates.includes(chosen))ids.add(chosen);
     else if(candidates.length>1){
      issue('ambiguous_match','נמצאו כמה רשומות יעד למפתח הקישור.',
       {matchKey:cacheKey,originalValue:match,options:candidates.slice(0,100)});
      throw Error('נדרשת בחירת רשומת יעד.');
     }
     else if(rule.onMissing==='omit')omitted=true;
     else issue('not_found','לא נמצאה רשומת יעד לקישור.');
    }
    const unresolved=issues.some(problem=>problem.fieldId===target.fieldId&&['not_found','ambiguous_match','needs_attention'].includes(problem.kind));
    if((!unresolved&&!omitted)||multi&&ids.size)fields.push({fieldId:target.fieldId,index,multi,value:multi?[...ids]:[...ids][0]??''});
   }catch(error){if(!issues.some(problem=>problem.fieldId===target.fieldId&&problem.kind==='ambiguous_match'))issue('needs_attention',error.message);}
  }
  try{await write({connection,entity,id,fields,recover});}
  catch(error){issues.push({kind:'verification',message:error.message});}
  return issues;
 };
}
