import test from 'node:test';
import assert from 'node:assert/strict';
import {indexImportFile,readImportBatch} from '../public/import-file.js';

test('indexes UTF-8 record batches progressively without reading the whole file as text',async()=>{
 const record=(id,group)=>({id,matchKey:id,data:{[group]:[{field:'ערך "quoted"\\'+('א'.repeat(33_000))}]}});
 const records=[record('1','first'),record('2','later'),record('3','third')];
 const json=JSON.stringify({entities:{example:{records,meta:{dataName:'example'}}},meta:{schemaVersion:'1.0'}},null,2);
 const blob=new Blob(['\uFEFF',json]);
 blob.text=()=>{throw Error('full-file text was requested');};
 const indexed=await indexImportFile(blob,2);
 assert.equal(indexed.entities.example.records.length,1);
 assert.equal(indexed.entities.example.meta.recordCount,3);
 assert.deepEqual(indexed.entities.example.meta.fields.map(field=>field.groupId),['first','later','third']);
 for(const [index,range] of indexed.batches.example.entries()){
  assert.deepEqual(await readImportBatch(blob,range),records.slice(index*2,index*2+2));
 }
});

test('rejects a truncated import before returning an index',async()=>{
 await assert.rejects(indexImportFile(new Blob(['{']),2));
});
