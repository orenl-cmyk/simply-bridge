import {readOrigami} from './origami.mjs';
import {writeSimply} from './run.mjs';

export const relationId=value=>typeof value==='object'&&value!==null?value.instance_id:value;

function normalized(value,multi){
 if(!multi){
  const id=relationId(value);
  return id===null?'':id;
 }
 if(!Array.isArray(value))return value===''||value===null?[]:null;
 const ids=value.map(relationId);
 if(ids.some(id=>typeof id!=='string'||!id))return null;
 return [...new Set(ids)].sort();
}

export function matchingRelations(instance,fields){
 if(!Array.isArray(instance?.field_groups))return false;
 return fields.every(({fieldId,index,value,multi})=>{
  for(const group of instance.field_groups){
   const rows=group.fields_data||[];
   const row=rows.find(cells=>cells.some(cell=>cell.group_index!=null&&Number(cell.group_index)===index))||rows[index];
   const field=row?.find(cell=>cell.field_data_name===fieldId);
   if(field&&Object.hasOwn(field,'value')){
    return JSON.stringify(normalized(field.value,multi))===JSON.stringify(normalized(value,multi));
   }
  }
  return false;
 });
}

export async function writeRelations({connection,entity,id,fields,recover=false,read=readOrigami,write=writeSimply}){
 if(!fields.length)return 'verified';
 const filter=[['_id','=',id]];
 const params={entity_data_name:entity,filter};
 const verify=async()=>{
  const raw=await read(connection,'instance_data',{...params,limit:[0,2]});
  const instance=raw.data?.[0]?.instance_data;
  if(!Array.isArray(raw.data)||raw.data.length!==1||
     Number(raw.info?.total_count)!==1||instance?._id!==id){
   throw Error('לא התקבלה רשומת יעד יחידה לאימות הקישור.');
  }
  return matchingRelations(instance,fields);
 };
 if(recover&&await verify())return 'verified';
 let result;
 try{
  result=await write(connection,'update_instance_fields',{
   ...params,field:fields.map(({fieldId,value,index})=>[fieldId,value,index])
  });
 }catch(error){
  if(error.kind==='unknown'&&await verify())return 'verified';
  throw error;
 }
 if(result.response?.results?.instance_data?._id===id&&
    matchingRelations(result.response.results.instance_data,fields))return 'confirmed_by_result';
 if(await verify())return 'verified';
 throw Error('ערכי הקישור ביעד שונים מהערכים הצפויים.');
}
