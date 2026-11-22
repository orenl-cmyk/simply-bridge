import {readOrigami} from './origami.mjs';
import {relationId,writeRelations} from './relation-write.mjs';

function fieldValue(record,name){
 if(name==='_id')return record._id;
 for(const group of record.field_groups||[]){
  for(const row of group.fields_data||[]){
   const field=row.find(cell=>cell.field_data_name===name);
   if(field)return field.value;
  }
 }
}

const hasValue=value=>['string','number'].includes(typeof value)&&String(value).trim()!=='';

export function validateBlackConfig(config){
 const id=value=>typeof value==='string'&&/^[\w-]+$/.test(value);
 if(!id(config?.connectionId)||!id(config.issueEntity))throw Error('Invalid BLACK connection or entity');
 for(const role of ['base','building','floor','room','topic','item']){
  if(!id(config.source?.[role]))throw Error('Missing BLACK issue source field: '+role);
 }
 for(const role of ['base','building','floor','room','inventory']){
  if(!id(config.destination?.[role]))throw Error('Missing BLACK issue destination field: '+role);
 }
 const required={base:['name'],building:['name','base'],floor:['name','building'],
  room:['name','floor'],catalog:['name','topic'],inventory:['catalog','topic','base','building','floor']};
 for(const [role,fields] of Object.entries(required)){
  if(!id(config[role]?.entity)||fields.some(field=>!id(config[role][field]))){
   throw Error('Invalid BLACK lookup configuration: '+role);
  }
 }
 return config;
}

export async function resolveBlackIssue({config,connection,issueId,recover=false,read=readOrigami,write=writeRelations}){
 async function find(entity,filters){
  const matches=new Set();
  let total,offset=0;
  do{
   const result=await read(connection,'instance_data',{
    entity_data_name:entity,filter:filters,limit:[offset,100],with_archive:0
   });
   const count=Number(result.info?.total_count);
   if(!Number.isSafeInteger(count)||count<0||(total!==undefined&&count!==total)||!Array.isArray(result.data)){
    throw Error('תשובת חיפוש חלקית או לא תקינה.');
   }
   total=count;
   for(const {instance_data:record} of result.data){
    if(!record||!hasValue(record._id)||matches.has(record._id)||
       filters.some(([field,,value])=>String(relationId(fieldValue(record,field)))!==String(value))){
     throw Error('תוצאת החיפוש אינה תואמת את הסינון.');
    }
    matches.add(record._id);
    if(entity===config.issueEntity&&record._id===issueId&&total===1&&result.data.length===1)return {id:record._id,record};
   }
   offset+=result.data.length;
   if(offset>total||(!result.data.length&&offset<total))throw Error('תשובת החיפוש אינה מלאה.');
  }while(offset<total);
  return {id:[...matches].sort()[0]||'',duplicates:matches.size>1};
 }
 const issue=await find(config.issueEntity,[['_id','=',issueId]]);
 if(!issue.record)return {issues:[{kind:'not_found',role:'issue'}]};
 const source=role=>{
  const value=fieldValue(issue.record,config.source[role]);
  return role==='topic'||role==='base'?relationId(value):value?.text??value;
 };
 const resolved={},issues=[];
 const lookup=async(role,filters)=>{
  if(filters.some(([,value])=>value===undefined)){
   issues.push({kind:'technical_failure',role});
   return undefined;
  }
  if(filters.some(([,value])=>!hasValue(value))){
   issues.push({kind:'not_found',role});
   return '';
  }
  try{
   const result=await find(config[role].entity,filters.map(([field,value])=>[field,'=',value]));
   if(!result.id||result.duplicates)issues.push({kind:result.duplicates?'duplicates':'not_found',role});
   return result.id;
  }catch{
   issues.push({kind:'technical_failure',role});
   return undefined;
  }
 };
 resolved.base=await lookup('base',[[config.base.name,source('base')]]);
 for(const [role,parent] of [['building','base'],['floor','building'],['room','floor']]){
  const lookupConfig=config[role];
  const parents={base:resolved.base,building:resolved.building,floor:resolved.floor};
  const additional=Object.keys(parents).filter(key=>key!==parent&&lookupConfig[key]&&parents[key]);
  resolved[role]=resolved[parent]?await lookup(role,[
   [lookupConfig[parent],resolved[parent]],[lookupConfig.name,source(role)],
   ...additional.map(key=>[lookupConfig[key],parents[key]])
  ]):resolved[parent];
 }
 const catalog=await lookup('catalog',[[config.catalog.name,source('item')],[config.catalog.topic,source('topic')]]);
 const location=['floor','building','base'].find(role=>resolved[role]!=='');
 resolved.inventory=catalog===undefined||(location&&resolved[location]===undefined)?undefined:
  catalog&&location?await lookup('inventory',[
   [config.inventory[location],resolved[location]],[config.inventory.topic,source('topic')],[config.inventory.catalog,catalog]
  ]):'';
 const fields=Object.entries(resolved).filter(([,value])=>value!==undefined)
  .map(([role,value])=>({fieldId:config.destination[role],index:0,value,multi:false}));
 await write({connection,entity:config.issueEntity,id:issueId,fields,recover});
 return {issues};
}
