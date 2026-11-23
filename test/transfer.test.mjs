import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportEntity,createPackage} from '../transfer.mjs';
const schema={groups:[{id:'g',repeatable:false,fields:[{id:'key',type:'input-text'},{id:'zero',type:'number'},{id:'file',type:'upload-files'},{id:'missing',type:'text'}]},{id:'rows',repeatable:true,fields:[{id:'value',type:'text'}]}]};
const config={entityId:'demo',key:{kind:'field',groupId:'g',fieldId:'key'},fields:schema.groups.flatMap(g=>g.fields.map(f=>({groupId:g.id,fieldId:f.id})))};
const record=(id,key)=>({instance_data:{_id:id,field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'key',value:key},{field_data_name:'zero',value:0},{field_data_name:'file',value:'file-secret'},{field_data_name:'unselected',value:'excluded'}]]},{field_group_data:{group_data_name:'rows'},fields_data:[[{field_data_name:'value',value:false,group_index:'2'}],[{field_data_name:'value',value:{instance_id:'source-id',text:'label'},group_index:'5'}]]}]}});
test('export preserves typed values, repeated rows, source IDs and selected keys; removes files and unselected fields; preserves all records',()=>{
 const raw={data:Array.from({length:12},(_,i)=>record('id'+i,i)),info:{total_count:12}};
 const e=exportEntity(raw,config,schema);assert.equal(e.records.length,12);assert.equal(e.records[0].matchKey,0);assert.equal(e.records[0].data.g[0].zero,0);assert.equal(e.records[0].data.rows[0].value,false);assert.deepEqual(e.records[0].data.rows[1].value,{instance_id:'source-id',text:'label'});assert.deepEqual(e.records[0].groupIndexes.rows,[2,5]);assert.equal(JSON.stringify(e).includes('file-secret'),false);assert.equal(Object.hasOwn(e.records[0].data.g[0],'missing'),false);assert.equal(Object.hasOwn(e.records[0].data.g[0],'unselected'),false);
 const p=JSON.parse(JSON.stringify(createPackage({demo:e},'test')));assert.deepEqual(p.entities.demo,JSON.parse(JSON.stringify(e)));
});
test('export keeps duplicate match keys for explicit conflict resolution, while rejecting unusable keys and invalid payloads',()=>{
 assert.throws(()=>exportEntity({data:[record('a',''),record('b','')]},config,schema));const duplicate=exportEntity({data:[record('a','x'),record('b','x')]},config,schema);assert.equal(duplicate.records.length,2);assert.deepEqual(duplicate.records.map(r=>r.matchKey),['x','x']);assert.throws(()=>exportEntity({data:[],entity_data:{entity_data_name:'wrong'}},config,schema));assert.throws(()=>exportEntity({},config,schema));assert.equal(exportEntity({data:[]},config,schema).records.length,0);
 const r=record('a','key');r.instance_data.field_groups[1]={field_group_data:{group_data_name:'rows',empty:'1'}};assert.deepEqual(exportEntity({data:[r]},config,schema).records[0].data.rows,[]);
});

