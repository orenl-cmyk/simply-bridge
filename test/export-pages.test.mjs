import {test} from 'node:test';import assert from 'node:assert/strict';import {exportAll} from '../export-pages.mjs';import {validateEntity} from '../sync.mjs';
const config={entityId:'demo',key:{kind:'recordId'},fields:[{groupId:'g',fieldId:'title'}]},schema={groups:[{id:'g',fields:[{id:'title',type:'input-text'}]}]};
const record=i=>({instance_data:{_id:'id'+i,field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'title',value:'value'+i}]]}]}});
test('exports every page, including server page-size caps, and permits import of more than ten',async()=>{
 const offsets=[];const entity=await exportAll({config,schema,range:null,read:async(c,o,p)=>{offsets.push(p.limit[0]);return {info:{total_count:23},data:Array.from({length:Math.min(7,23-p.limit[0])},(_,i)=>record(i+p.limit[0]))};}});
 assert.deepEqual(offsets,[0,7,14,21]);assert.equal(entity.records.length,23);assert.equal(entity.meta.sample,false);assert.equal(entity.meta.recordCount,23);validateEntity(entity);
});
test('rejects repeated pages, empty early pages and changing totals; supports empty exports',async()=>{
 for(const kind of ['duplicate','empty','changed']){let page=0;await assert.rejects(exportAll({config,schema,range:null,read:async()=>{page++;return {info:{total_count:kind==='changed'&&page>1?3:2},data:kind==='empty'&&page>1?[]:[record(kind==='duplicate'?0:page)]};}}));}
 assert.equal((await exportAll({config,schema,read:async()=>({info:{total_count:0},data:[]})})).records.length,0);
});
