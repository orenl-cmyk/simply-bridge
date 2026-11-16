import {dryRunEntity} from './sync.mjs';
import {applyImportMapping} from './public/import-mapping.js';
export const nodeKey=(entity,id)=>JSON.stringify([entity,id]);
const placeholder=ref=>({$bridgeDependency:nodeKey(ref.sourceRelatedEntity,ref.sourceId)});
const applyMapped=(entry,schema)=>applyImportMapping(entry.entity,schema,entry.mapping??[],entry.relationStaging,entry.targetId);
export async function prepareImport({connection,mappings,rules,schemas,read,guard,onDebug,onProgress}){
 if(!Array.isArray(mappings))throw Object.assign(new Error('תוכנית ייבוא לא תקינה.'),{status:422});
 const plans=[],nodes=new Map();
 for(const [entityIndex,entry] of mappings.entries()){
  const entityName=entry.entity?.meta?.name||entry.targetId||'',entityRecords=entry.entity?.records?.length||0;
  onProgress?.({phase:'entity',entityIndex,entities:mappings.length,entityName,records:0,totalRecords:entityRecords});
  const schema=schemas.get(entry.targetId);if(!schema)throw Object.assign(new Error('מבנה יעד חסר.'),{status:422});
  const relationData=Object.create(null),result=await dryRunEntity({connection,entity:entry.entity,targetId:entry.targetId,targetKey:entry.targetKey,schema,mapping:entry.mapping,relationStaging:entry.relationStaging,relationData,read,guard,onDebug,onProgress:progress=>onProgress?.({phase:'records',entityIndex,entities:mappings.length,entityName,records:progress.processed,totalRecords:progress.total})});
  const plan={...entry,schema,mapped:applyMapped(entry,schema),relationData,result};plans.push(plan);
  result.rows.forEach((row,index)=>{const key=nodeKey(entry.entity.meta.dataName,row.sourceId),deps=[];nodes.set(key,{key,planIndex:plans.length-1,index,row,deps});row.dependencies=[];});
 }
 const block=(node,reason)=>{node.row.status='blocked';if(!node.row.reasons.includes(reason))node.row.reasons.push(reason);};
 // Different source entities must not schedule writes to the same destination identity.
 const destinations=new Map();for(const node of nodes.values()){const p=plans[node.planIndex],r=node.row,k=JSON.stringify([p.targetId,r.targetId?'id':'key',r.targetId||[p.targetKey,String(r.matchKey)]]);if(!destinations.has(k))destinations.set(k,[]);destinations.get(k).push(node);}for(const group of destinations.values())if(group.length>1)for(const n of group)block(n,'יותר מרשומת מקור אחת מופנית לאותה רשומת יעד בתוכנית.');
 const ordered=[...nodes.values()].filter(node=>node.row.status==='planned');
 for(const plan of plans)plan.result.counts.blocked=plan.result.rows.filter(r=>r.status==='blocked').length;
 const order=[...ordered,...[...nodes.values()].filter(n=>n.row.status==='blocked')].map(n=>({planIndex:n.planIndex,index:n.index,key:n.key,dependencies:n.deps,sourceEntity:plans[n.planIndex].entity.meta.dataName,sourceId:n.row.sourceId,action:n.row.action,status:n.row.status}));
 onProgress?.({phase:'complete',entityIndex:mappings.length,entities:mappings.length,records:[...nodes.values()].length,scheduledRecords:ordered.length});
 return {plans,order,report:{fields:[],blockedFields:0,deferredFields:0,resolvedFields:0,omittedFields:0,dependencies:[],cycles:[],nextStep:'שדות קישור לא נפתרים בזמן הייבוא. המידע נארז בשדה JSON הקישורים לעיבוד מאוחר ב־Node-RED.',scheduledRecords:ordered.length,deferredRecords:0,blockedRecords:[...nodes.values()].filter(n=>n.row.status==='blocked').length}};
}
export function materializeDependencies({planned,relationData,dependencies,outcomes}){
 const ids=new Map();for(const key of dependencies){const result=outcomes.get(key);if(!result)return {notReady:true};if(result.status!=='succeeded'||typeof result.targetId!=='string'||!result.targetId)return {blocked:true,reason:'רשומה מקושרת לא נוצרה בהצלחה: '+key+' ('+result.status+')'};ids.set(key,result.targetId);}
 const replace=value=>{if(Array.isArray(value))return value.map(replace);if(value&&typeof value==='object'){if(Object.hasOwn(value,'$bridgeDependency')){const id=ids.get(value.$bridgeDependency);if(!id)throw Error('Unresolved dependency in write plan');return id;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));}return value;};
 const data=structuredClone(relationData||{});for(const slot of Object.values(data)){if(!slot.deferred)continue;for(const ref of slot.refs)if(ref.waiting){ref.targetId=ids.get(nodeKey(ref.sourceRelatedEntity,ref.sourceId));delete ref.waiting;}slot.value=replace(slot.value);delete slot.deferred;}
 return {planned:replace(planned),relationData:data};
}
