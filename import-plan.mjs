import {fetchRelations} from './relations.mjs';
import {dryRunEntity} from './sync.mjs';
export const nodeKey=(entity,id)=>JSON.stringify([entity,id]);
const placeholder=ref=>({$bridgeDependency:nodeKey(ref.sourceRelatedEntity,ref.sourceId)});
export async function prepareImport({connection,mappings,rules,schemas,read,guard,onDebug}){
 if(!Array.isArray(mappings))throw Object.assign(new Error('תוכנית ייבוא לא תקינה.'),{status:422});
 const fetched=await fetchRelations({connection,mappings,rules,schemas,read,guard,onDebug}),plans=[],nodes=new Map();
 for(const entry of fetched.entries){
  const relationData=structuredClone(entry.relationData);
  for(const slots of Object.values(relationData))for(const slot of Object.values(slots)){
   if(slot.status==='blocked'&&slot.refs.length&&slot.refs.every(r=>r.targetId||r.waiting)){
    slot.status='resolved';slot.deferred=true;delete slot.reason;const values=slot.refs.map(r=>r.targetId||placeholder(r));slot.value=slot.multi?values:values[0];
   }
  }
  const result=await dryRunEntity({connection,entity:entry.entity,targetId:entry.targetId,targetKey:entry.targetKey,schema:entry.schema,mapping:entry.mapping,relationData,read,guard,onDebug});
  const plan={...entry,relationData,result};plans.push(plan);
  result.rows.forEach((row,index)=>{const key=nodeKey(entry.entity.meta.dataName,row.sourceId),deps=[...new Set(Object.values(relationData[row.sourceId]).filter(s=>s.deferred).flatMap(s=>s.refs.filter(r=>r.waiting).map(r=>nodeKey(r.sourceRelatedEntity,r.sourceId))))];nodes.set(key,{key,planIndex:plans.length-1,index,row,deps});row.dependencies=deps.map(k=>JSON.parse(k));});
 }
 const block=(node,reason)=>{node.row.status='blocked';if(!node.row.reasons.includes(reason))node.row.reasons.push(reason);};
 // Different source entities must not schedule writes to the same destination identity.
 const destinations=new Map();for(const node of nodes.values()){const p=plans[node.planIndex],r=node.row,k=JSON.stringify([p.targetId,r.targetId?'id':'key',r.targetId||[p.targetKey,String(r.matchKey)]]);if(!destinations.has(k))destinations.set(k,[]);destinations.get(k).push(node);}for(const group of destinations.values())if(group.length>1)for(const n of group)block(n,'יותר מרשומת מקור אחת מופנית לאותה רשומת יעד בתוכנית.');
 let changed;do{changed=false;for(const node of nodes.values())if(node.row.status==='planned'){const invalid=node.deps.find(k=>!nodes.has(k)||nodes.get(k).row.status!=='planned');if(invalid){block(node,'תלות חסומה או חסרה בחבילה: '+invalid);changed=true;}}}while(changed);
 const ordered=[],done=new Set();do{changed=false;for(const node of nodes.values())if(node.row.status==='planned'&&!done.has(node.key)&&node.deps.every(k=>done.has(k))){ordered.push(node);done.add(node.key);changed=true;}}while(changed);
 for(const node of nodes.values())if(node.row.status==='planned'&&!done.has(node.key))block(node,'תלות מעגלית או תלות ברשומה שנמצאת במעגל; אין סדר כתיבה בטוח.');
 for(const plan of plans)plan.result.counts.blocked=plan.result.rows.filter(r=>r.status==='blocked').length;
 const order=[...ordered,...[...nodes.values()].filter(n=>n.row.status==='blocked')].map(n=>({planIndex:n.planIndex,index:n.index,key:n.key,dependencies:n.deps,sourceEntity:plans[n.planIndex].entity.meta.dataName,sourceId:n.row.sourceId,action:n.row.action,status:n.row.status}));
 const fields=fetched.report.fields.map(field=>{const plan=plans.find(p=>p.entity.meta.dataName===field.sourceEntity),slot=plan.relationData[field.sourceId]?.[JSON.stringify([field.groupId,field.fieldId])],row=plan.result.rows.find(r=>r.sourceId===field.sourceId);return slot?.deferred?{...field,status:row.status==='planned'?'deferred':'blocked',reason:row.status==='planned'?'המזהה יושלם אחרי כתיבת הרשומה המקושרת':row.reasons.join(' | ')}:field;});
 return {plans,order,report:{...fetched.report,fields,blockedFields:fields.filter(f=>f.status==='blocked').length,deferredFields:fields.filter(f=>f.status==='deferred').length,nextStep:'התוכנית כוללת סדר כתיבה. RUN ייצור רשומות נדרשות, ישמור את מזהי היעד ויחבר אליהן את הרשומות התלויות באותה ריצה. כשל ברשומה חוסם את התלויים בה.',scheduledRecords:ordered.length,deferredRecords:ordered.filter(n=>n.deps.length).length,blockedRecords:[...nodes.values()].filter(n=>n.row.status==='blocked').length}};
}
export function materializeDependencies({planned,relationData,dependencies,outcomes}){
 const ids=new Map();for(const key of dependencies){const result=outcomes.get(key);if(!result)return {notReady:true};if(result.status!=='succeeded'||typeof result.targetId!=='string'||!result.targetId)return {blocked:true,reason:'רשומה מקושרת לא נוצרה בהצלחה: '+key+' ('+result.status+')'};ids.set(key,result.targetId);}
 const replace=value=>{if(Array.isArray(value))return value.map(replace);if(value&&typeof value==='object'){if(Object.hasOwn(value,'$bridgeDependency')){const id=ids.get(value.$bridgeDependency);if(!id)throw Error('Unresolved dependency in write plan');return id;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));}return value;};
 const data=structuredClone(relationData||{});for(const slot of Object.values(data)){if(!slot.deferred)continue;for(const ref of slot.refs)if(ref.waiting){ref.targetId=ids.get(nodeKey(ref.sourceRelatedEntity,ref.sourceId));delete ref.waiting;}slot.value=replace(slot.value);delete slot.deferred;}
 return {planned:replace(planned),relationData:data};
}
