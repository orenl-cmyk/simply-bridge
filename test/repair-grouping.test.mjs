import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRepairGroups} from '../public/repair-grouping.js';

test('server repair summary keeps complete root-cause counts beyond the former 500-row page',()=>{
 const issues=Array.from({length:2500},(_,index)=>({
  jobId:'job-a',connectionName:'BLACK',status:index<2300?'failed':'unknown',
  error:{kind:'validation',details:{column:[{field_data_name:'title',message:'invalid value'}]}}
 }));
 issues.push({jobId:'job-b',connectionName:'RED',status:'failed',error:{kind:'validation',details:{column:[{field_data_name:'title',message:'invalid value'}]}}});
 const groups=summarizeRepairGroups(issues);
 assert.equal(groups.length,2);
 assert.equal(groups.find(group=>group.jobId==='job-a').affectedRecords,2500);
 assert.equal(groups.find(group=>group.jobId==='job-a').retryableRecords,2300);
 assert.equal(groups.find(group=>group.jobId==='job-a').closeableRecords,2500);
});
