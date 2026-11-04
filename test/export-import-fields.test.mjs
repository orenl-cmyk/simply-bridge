import {test} from 'node:test';import assert from 'node:assert/strict';
import {exportEntity} from '../transfer.mjs';import {sourceLayout,applyImportMapping} from '../public/import-mapping.js';import {dryRunEntity} from '../sync.mjs';
const schema={groups:[{id:'g',fields:[{id:'name',type:'input-text'},{id:'otp',type:'input-text'},{id:'unused',type:'input-text'},{id:'external',type:'input-text'}]}]};
test('export excludes unselected OTP and extra fields from both data and selected-field metadata',()=>{
 const raw={data:[{instance_data:{_id:'source-id',field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'name',value:'Alice'},{field_data_name:'otp',value:'123456'},{field_data_name:'unused',value:'extra'}]]}]}}]};
 const out=exportEntity(raw,{entityId:'appUsers',key:{kind:'recordId'},fields:[{groupId:'g',fieldId:'name'}]},schema);
 assert.deepEqual(Object.keys(out.records[0].data.g[0]),['name']);assert.equal(JSON.stringify(out).includes('otp'),false);assert.equal(JSON.stringify(out).includes('123456'),false);assert.equal(JSON.stringify(out).includes('unused'),false);
});
test('import ignores stale metadata fields and maps only data values across all records, preserving null false zero and empty strings',async()=>{
 const e={meta:{dataName:'appUsers',fields:[{groupId:'old',fieldId:'otp'},{groupId:'phantom',fieldId:'unused'}]},records:[{id:'a',matchKey:'a',data:{old:[{sourceName:''}]}},{id:'b',matchKey:'b',data:{old:[{sourceName:null}]}},{id:'c',matchKey:'c',data:{old:[{sourceName:false}]}},{id:'d',matchKey:'d',data:{old:[{sourceName:0}]}}]};
 assert.deepEqual(sourceLayout(e),[{id:'old',fields:['sourceName']}]);const mapping=[{sourceGroup:'old',targetGroup:'g',fields:[{sourceField:'sourceName',targetField:'name'}]}];
 const mapped=applyImportMapping(e,schema,mapping);assert.deepEqual(mapped.records.map(r=>r.data.g[0].name),['',null,false,0]);
 const r=await dryRunEntity({connection:{baseUrl:'https://example.invalid'},entity:e,targetId:'appUsers',targetKey:{kind:'field',groupId:'g',fieldId:'external'},schema,mapping,read:async()=>({data:[],info:{total_count:0}})});
 assert.equal(r.counts.create,4);assert.equal(r.counts.blocked,0);assert.ok(r.rows.every(row=>row.status==='planned'));assert.ok(r.rows.every(row=>!JSON.stringify(row.request.body).includes('otp')));
});

test('mapped telephone strings allow four creates and updates; ambiguous phone values remain blocked',async()=>{
 const phoneSchema={groups:[{id:'target',fields:[{id:'fld_3487',name:'טלפון',type:'input-telephone'},{id:'external',type:'input-text'}]}]};
 const values=['0501234567','+972501234567','050-1234567',''];
 const entity={meta:{dataName:'appUsers'},records:values.map((phone,i)=>({id:'id'+i,matchKey:'key'+i,data:{source:[{phone}]}}))};
 const mapping=[{sourceGroup:'source',targetGroup:'target',fields:[{sourceField:'phone',targetField:'fld_3487'}]}];
 const args={connection:{baseUrl:'https://example.invalid'},entity,targetId:'appUsers',targetKey:{kind:'field',groupId:'target',fieldId:'external'},schema:phoneSchema,mapping};
 const created=await dryRunEntity({...args,read:async()=>({data:[],info:{total_count:0}})});
 assert.equal(created.counts.create,4);assert.equal(created.counts.blocked,0);assert.deepEqual(created.rows.map(r=>r.request.body.form_data[0].data[0].fld_3487),values);
 const updated=await dryRunEntity({...args,read:async(c,op,b)=>({data:[{instance_data:{_id:'target-id',field_groups:[{field_group_data:{group_data_name:'target'},fields_data:[[{field_data_name:'external',value:b.filter[0][2]}]]}]}}],info:{total_count:1}})});
 assert.equal(updated.counts.update,4);assert.equal(updated.counts.blocked,0);assert.deepEqual(updated.rows.map(r=>r.request.body.field.find(f=>f[0]==='fld_3487')[1]),values);
 for(const value of [501234567,null,{value:'0501234567'}]){const invalid=structuredClone(entity);invalid.records=[invalid.records[0]];invalid.records[0].data.source[0].phone=value;const result=await dryRunEntity({...args,entity:invalid,read:async()=>({data:[],info:{total_count:0}})});assert.equal(result.counts.blocked,1);assert.match(result.rows[0].reasons[0],/טלפון/);}
});
