export function sourceLayout(entity){
 const groups=new Map();const add=(g,f)=>{if(typeof g!=='string')return;if(!groups.has(g))groups.set(g,new Set());if(typeof f==='string')groups.get(g).add(f);};
 for(const r of entity.records||[])for(const [g,rows]of Object.entries(r.data||{})){add(g);for(const row of rows)for(const f of Object.keys(row))add(g,f);}
 return [...groups].map(([id,fields])=>({id,fields:[...fields]}));
}
export function applyImportMapping(entity,schema,mapping=[]){
 const bad=m=>{throw Object.assign(new Error(m),{status:422});};
 if(!Array.isArray(mapping))bad('מיפוי הייבוא אינו תקין.');
 const layout=sourceLayout(entity),sourceIds=new Set(),targetIds=new Set(),resolved=new Map();
 for(const m of mapping){if(!m||typeof m.sourceGroup!=='string'||sourceIds.has(m.sourceGroup)||!layout.some(g=>g.id===m.sourceGroup))bad('קבוצת מקור לא תקינה או כפולה במיפוי.');sourceIds.add(m.sourceGroup);}
 for(const source of layout){
  const m=mapping.find(m=>m.sourceGroup===source.id),targetId=m?m.targetGroup:source.id,g=schema.groups.find(g=>g.id===targetId);
  if(!g)bad('יש למפות קבוצת מקור '+source.id+' לקבוצה קיימת ביעד.');
  if(targetIds.has(targetId))bad('שתי קבוצות מקור מופנות לאותה קבוצת יעד: '+targetId);targetIds.add(targetId);
  const pairs=m?.fields??[];if(!Array.isArray(pairs))bad('מיפוי שדות לא תקין.');
  const seen=new Set(),destinations=new Set(),fields=new Map();
  for(const pair of pairs){if(!pair||!source.fields.includes(pair.sourceField)||seen.has(pair.sourceField))bad('שדה מקור לא תקין או כפול במיפוי.');seen.add(pair.sourceField);}
  for(const fid of source.fields){const pair=pairs.find(f=>f.sourceField===fid),targetField=pair?pair.targetField:fid;if(!g.fields.some(f=>f.id===targetField))bad('יש למפות את השדה '+source.id+'/'+fid+' לשדה קיים בקבוצת היעד '+targetId);if(destinations.has(targetField))bad('שני שדות מקור מופנים לאותו שדה יעד: '+targetField);destinations.add(targetField);fields.set(fid,targetField);}
  resolved.set(source.id,{targetId,fields});
 }
 const mapped={...entity,records:entity.records.map(record=>{const data=Object.create(null);for(const [gid,rows]of Object.entries(record.data)){const m=resolved.get(gid);data[m.targetId]=rows.map(row=>Object.fromEntries(Object.entries(row).map(([fid,value])=>[m.fields.get(fid),value])));}return {...record,data};})};
 return mapped;
}
