import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRelationFinalizer} from '../relation-finalizer.mjs';
import {resolveBlackIssue,validateBlackConfig} from '../black-issue-resolver.mjs';
import {batchLookup} from '../relations.mjs';
import {writeRelations} from '../relation-write.mjs';

const instance=(_id,values)=>({_id,field_groups:[{fields_data:[Object.entries(values).map(([field_data_name,value])=>({field_data_name,value}))]}]});
const records=(...rows)=>({data:rows.map(instance_data=>({instance_data})),info:{total_count:rows.length}});

test('Finalizer overwrites a partial multi-relation, caches lookups, and preserves a field on lookup failure',async()=>{
 const writes=[],calls=[];
 const finalize=createRelationFinalizer({
  connection:{},rules:[{sourceEntity:'source',groupId:'g',fieldId:'links',sourceRelatedEntity:'linked',targetEntity:'linked-target',targetKey:{kind:'field',groupId:'g',fieldId:'external'},valueMode:'sourceText'}],
  identities:new Map([[JSON.stringify(['linked','linked-target','known']),{id:'dest'}]]),
  schemas:new Map([['linked-target',{groups:[{id:'g',fields:[{id:'external',type:'input-text'}]}]}]]),
  lookup:async({values:[value]})=>{
   calls.push(value);
   if(value==='failure')throw Error('API failure');
   return new Map([[value,[]]]);
  },
  write:async({fields})=>writes.push(fields)
 });
 const request=values=>({entity:'target',id:'record',schema:{groups:[{id:'g',fields:[{id:'links',type:'multi-select-from-entity'}]}]},envelope:{relations:[{
  source:{entity:'source',value:values},target:{groupId:'g',fieldId:'links'}
 }]}});
 const values=[{instance_id:'known',text:'known'},{instance_id:'x',text:'missing'}];
 assert.equal((await finalize(request(values)))[0].kind,'not_found');
 await finalize(request(values));
 assert.deepEqual(calls,['missing']);
 assert.deepEqual(writes[0][0].value,['dest']);
 await finalize(request([...values,{text:'failure'}]));
 assert.deepEqual(writes[2],[]);
 await finalize(request([]));
 assert.deepEqual(writes[3][0].value,[]);
});

test('relation target searches include archived records',async()=>{
 let request;
 await batchLookup({connection:{},targetId:'linked',key:{kind:'field',groupId:'g',fieldId:'external'},values:['key'],read:async(_connection,_operation,params)=>{
  request=params;
  return {data:[],info:{total_count:0}};
 }});
 assert.equal(request.with_archive,1);
});

test('HTTP 200 Origami API errors preserve the existing relation field',async t=>{
 const server=http.createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({error:{type:'query',message:'Filter rejected'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 let writes=0;
 const finalize=createRelationFinalizer({
  connection:{baseUrl:`http://127.0.0.1:${server.address().port}`,username:'test',secret:'test'},
  rules:[{sourceEntity:'source',groupId:'g',fieldId:'link',sourceRelatedEntity:'linked',targetEntity:'linked-target',targetKey:{kind:'field',groupId:'g',fieldId:'external'},valueMode:'sourceText'}],
  identities:new Map(),
  schemas:new Map([['linked-target',{groups:[{id:'g',fields:[{id:'external',type:'input-text'}]}]}]]),
  write:async({fields})=>{writes++;assert.deepEqual(fields,[]);}
 });
 const issues=await finalize({entity:'target',id:'record',schema:{groups:[{id:'g',fields:[{id:'link',type:'select-from-entity'}]}]},envelope:{relations:[{
  source:{entity:'source',value:{instance_id:'missing',text:'lookup'}},target:{groupId:'g',fieldId:'link'}
 }]}});
 assert.ok(issues.some(issue=>issue.kind==='needs_attention'));
 assert.equal(writes,1);
});

test('BLACK resolver scopes hierarchy and inventory, excludes archive and selects duplicates deterministically',async()=>{
 const config=validateBlackConfig({connectionId:'black',issueEntity:'issue',
  source:{base:'base',building:'building',floor:'floor',room:'room',topic:'topic',item:'item'},
  destination:{base:'baseId',building:'buildingId',floor:'floorId',room:'roomId',inventory:'inventoryId'},
  base:{entity:'base',name:'name'},building:{entity:'building',name:'name',base:'base'},
  floor:{entity:'floor',name:'name',building:'building'},room:{entity:'room',name:'name',floor:'floor'},
  catalog:{entity:'catalog',name:'name',topic:'topic'},
  inventory:{entity:'inventory',base:'base',building:'building',floor:'floor',topic:'topic',catalog:'catalog'}
 });
 const data={
  issue:[instance('i',{base:'Base',building:'B',floor:'F',room:'R',item:'Item',topic:'T'})],
  base:[instance('base1',{name:'Base'})],
  building:[instance('z',{name:'B',base:'base1'}),instance('a',{name:'B',base:'base1'})],
  floor:[],catalog:[instance('cat',{name:'Item',topic:'T'})],
  inventory:[instance('item',{building:'a',topic:'T',catalog:'cat'})]
 };
 const queries=[];
 let updated;
 const result=await resolveBlackIssue({config,connection:{},issueId:'i',
  read:async(_connection,_operation,params)=>{queries.push(params);return records(...data[params.entity_data_name]);},
  write:async({fields})=>{updated=Object.fromEntries(fields.map(field=>[field.fieldId,field.value]));}
 });
 assert.ok(queries.every(query=>query.with_archive===0));
 assert.ok(!queries.some(query=>query.entity_data_name==='room'));
 assert.deepEqual(queries.find(query=>query.entity_data_name==='inventory').filter,[['building','=','a'],['topic','=','T'],['catalog','=','cat']]);
 assert.deepEqual(updated,{baseId:'base1',buildingId:'a',floorId:'',roomId:'',inventoryId:'item'});
 assert.ok(result.issues.some(issue=>issue.kind==='duplicates'&&issue.role==='building'));
});

test('BLACK resolver omits unresolved fields after an Origami API failure instead of clearing them',async()=>{
 const config=validateBlackConfig({connectionId:'black',issueEntity:'issue',
  source:{base:'base',building:'building',floor:'floor',room:'room',topic:'topic',item:'item'},
  destination:{base:'baseId',building:'buildingId',floor:'floorId',room:'roomId',inventory:'inventoryId'},
  base:{entity:'base',name:'name'},building:{entity:'building',name:'name',base:'base'},
  floor:{entity:'floor',name:'name',building:'building'},room:{entity:'room',name:'name',floor:'floor'},
  catalog:{entity:'catalog',name:'name',topic:'topic'},
  inventory:{entity:'inventory',base:'base',building:'building',floor:'floor',topic:'topic',catalog:'catalog'}
 });
 let written;
 const result=await resolveBlackIssue({config,connection:{},issueId:'i',
  read:async(_connection,_operation,params)=>{
   if(params.entity_data_name==='issue')return records(instance('i',{base:'Base',building:'B',floor:'F',room:'R',item:'Item',topic:'T'}));
   throw Error('Origami returned HTTP 200 with an error object');
  },
  write:async({fields})=>{written=fields;return {status:'verified'};}
 });
 assert.ok(result.issues.some(issue=>issue.kind==='technical_failure'));
 assert.deepEqual(written,[], 'an API error must not authorize clearing existing destination relations');
});

test('relation write verifies set equality from the update result',async()=>{
 let reads=0,writes=0;
 const result=await writeRelations({connection:{},entity:'e',id:'r',fields:[{fieldId:'links',index:0,multi:true,value:['a','b']}],
  read:async()=>{reads++;return records(instance('r',{links:[]}));},
  write:async()=>{writes++;return {response:{results:{instance_data:instance('r',{links:[{instance_id:'b'},{instance_id:'a'}]})}}};}
 });
 assert.equal(result,'confirmed_by_result');
 assert.equal(reads,0);
 assert.equal(writes,1);
});

test('40,000 records sharing an external relation key use one destination lookup',async()=>{
 let lookups=0,writes=0;
 const finalize=createRelationFinalizer({
  connection:{},
  rules:[{sourceEntity:'issue',sourceRelatedEntity:'link',groupId:'g',fieldId:'link',
   targetEntity:'destination',valueMode:'sourceText',targetKey:{kind:'field',groupId:'g',fieldId:'external'}}],
  identities:new Map(),
  schemas:new Map([['destination',{groups:[{id:'g',fields:[{id:'external',type:'input-text'}]}]}]]),
  lookup:async()=>{lookups++;return new Map([['shared',['destination-id']]]);},
  write:async()=>{writes++;}
 });
 const envelope={relations:[{source:{entity:'issue',value:{instance_id:'local-id',text:'shared'}},target:{groupId:'g',fieldId:'link'}}]};
 const schema={groups:[{id:'g',fields:[{id:'link',type:'select-from-entity'}]}]};
 for(let i=0;i<40_000;i++){
  const issues=await finalize({envelope,entity:'issues',id:'issue-'+i,schema});
  assert.equal(issues.length,0);
 }
 assert.equal(lookups,1);
 assert.equal(writes,40_000);
});
