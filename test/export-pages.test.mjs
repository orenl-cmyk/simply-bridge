import {test} from 'node:test';import assert from 'node:assert/strict';import {exportAll} from '../export-pages.mjs';import {validateEntity} from '../sync.mjs';
const config={entityId:'demo',key:{kind:'recordId'},fields:[{groupId:'g',fieldId:'title'}]},schema={groups:[{id:'g',fields:[{id:'title',type:'input-text'}]}]};
const record=i=>({instance_data:{_id:'id'+i,field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'title',value:'value'+i}]]}]}});
test('exports every page, including server page-size caps, and permits import of more than ten',async()=>{
 const offsets=[],limits=[],progress=[];const entity=await exportAll({config,schema,range:null,onProgress:p=>progress.push(p),read:async(c,o,p)=>{offsets.push(p.limit[0]);limits.push(p.limit[1]);return {info:{total_count:23},data:Array.from({length:Math.min(7,23-p.limit[0])},(_,i)=>record(i+p.limit[0]))};}});
 assert.deepEqual(offsets,[0,7,14,21]);assert.deepEqual(limits,[500,500,500,500]);assert.deepEqual(progress.map(p=>p.records),[7,14,21,23]);assert.equal(progress.at(-1).percent,100);assert.equal(entity.records.length,23);assert.equal(entity.meta.sample,false);assert.equal(entity.meta.recordCount,23);validateEntity(entity);
});
test('rejects repeated pages, empty early pages and changing totals after bounded retries; supports empty exports',async()=>{
 for(const kind of ['duplicate','empty','changed']){let page=0;await assert.rejects(exportAll({config,schema,range:null,retries:1,retryDelayMs:0,read:async()=>{page++;const second=page%2===0;return {info:{total_count:kind==='changed'&&second?3:2},data:kind==='empty'&&second?[]:[record(kind==='duplicate'?0:page)]};}}));}
 assert.equal((await exportAll({config,schema,read:async()=>({info:{total_count:0},data:[]})})).records.length,0);
});
test('restarts a live entity and returns only a complete stable snapshot',async()=>{
 let call=0;const progress=[];const entity=await exportAll({config,schema,range:null,retries:2,retryDelayMs:0,onProgress:p=>progress.push(p),read:async()=>{call++;if(call===1)return {info:{total_count:2},data:[record(0)]};if(call===2)return {info:{total_count:3},data:[record(1)]};return {info:{total_count:2},data:[record(call===3?0:1)]};}});
 assert.equal(call,4);assert.equal(progress.find(p=>p.phase==='retrying').attempt,2);assert.deepEqual(entity.records.map(r=>r.id),['id0','id1']);
});
