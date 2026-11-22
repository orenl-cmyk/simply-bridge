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
     const chosen=choices?.[cacheKey];
     if(candidates.length===1)ids.add(candidates[0]);
     else if(candidates.length>1&&candidates.includes(chosen))ids.add(chosen);
     else if(candidates.length>1){
      issue('ambiguous_match','נמצאו כמה רשומות יעד למפתח הקישור.',
       {matchKey:cacheKey,originalValue:match,options:candidates.slice(0,100)});
      throw Error('נדרשת בחירת רשומת יעד.');
     }
     else issue('not_found','לא נמצאה רשומת יעד לקישור.');
    }
    fields.push({fieldId:target.fieldId,index,multi,value:multi?[...ids]:[...ids][0]??''});
   }catch(error){if(!issues.some(problem=>problem.fieldId===target.fieldId&&problem.kind==='ambiguous_match'))issue('needs_attention',error.message);}
  }
  try{await write({connection,entity,id,fields,recover});}
  catch(error){issues.push({kind:'verification',message:error.message});}
  return issues;
 };
}
