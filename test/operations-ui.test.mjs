import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {activeOperation,groupRepairIssues,operationStages,operationStatus,parseCorrectedPayloads} from '../public/operations-ui.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('operation progress exposes four stable stages and advances from checking to writing',()=>{
 const checking=operationStages({state:'running',progress:{phase:'checking'}}),writing=operationStages({state:'running',progress:{phase:'writing'}});
 assert.equal(checking.length,4);assert.deepEqual(checking.map(item=>item.status),['done','active','pending','pending']);
 assert.deepEqual(writing.map(item=>item.status),['done','done','done','active']);
 assert.ok(operationStages({state:'done',progress:{phase:'complete'}}).every(item=>item.status==='done'));
 const linksPending=operationStages({state:'running',relationCompleted:3,progress:{phase:'writing',relationsTotal:8,total:8,completed:5}});
 assert.equal(linksPending[2].status,'pending');assert.equal(linksPending[3].status,'active');
 const linksDone=operationStages({state:'done',relationCompleted:8,progress:{phase:'complete',relationsTotal:8,total:8,completed:8}});
 assert.equal(linksDone[2].status,'done');
 assert.equal(operationStatus({state:'running',progress:{phase:'writing',overallEtaSeconds:120,etaSeconds:30}}).eta,'כ־2 דקות');
});

test('active operation restores the remembered running job and falls back to another active job',()=>{
 const jobs=[{id:'one',state:'paused'},{id:'two',state:'running'},{id:'old',state:'done'}];
 assert.equal(activeOperation(jobs,'one').id,'one');assert.equal(activeOperation(jobs,'missing').id,'two');assert.equal(activeOperation([{id:'old',state:'done'}]),null);
});

test('repair issues are grouped by root cause with affected and retryable record counts',()=>{
 const rows=[
  {issueId:'a',status:'failed',error:{kind:'validation',details:{column:[{field_data_name:'email',message:'invalid'}]}}},
  {issueId:'b',status:'failed',error:{kind:'validation',details:{column:[{field_data_name:'email',message:'required'}]}}},
  {issueId:'c',status:'unknown',error:{message:'timeout'}}
 ];
 const groups=groupRepairIssues(rows),validation=groups.find(group=>group.key==='validation:email');
 assert.equal(validation.affectedRecords,2);assert.equal(validation.retryableRecords,2);assert.equal(groups.find(group=>group.key==='unknown-result').retryableRecords,0);
});

test('corrected retry payload accepts only operation/body request arrays',()=>{
 assert.deepEqual(parseCorrectedPayloads('[{"operation":"update_instance_fields","body":{"id":"1"}}]')[0].body,{id:'1'});
 assert.throws(()=>parseCorrectedPayloads('{"body":{}}'),/מערך/);assert.throws(()=>parseCorrectedPayloads('[{"operation":"x"}]'),/operation/);
});

test('import exposes one visible run action and active-job resume wiring',async()=>{
 const [dryRun,style,index,app]=await Promise.all(['public/dry-run.js','public/style.css','public/index.html','public/app.js'].map(file=>readFile(path.join(root,file),'utf8')));
 assert.match(dryRun,/>הפעל ייבוא</);assert.match(style,/#runWet\{display:none!important\}/);
 assert.match(dryRun,/runMode'\)\.value==='ask'&&dryComplete/);
 assert.match(index,/id="resumeActiveJob"/);assert.match(app,/activeOperation\(jobs,remembered\)/);assert.match(app,/operation-stages/);
});

test('admin repair UI groups causes and requires a documented exception close',async()=>{
 const app=await readFile(path.join(root,'public/app.js'),'utf8');
 assert.match(app,/groupRepairIssues\(rows\)/);assert.match(app,/רשומות מושפעות/);assert.match(app,/parseCorrectedPayloads/);
 assert.match(app,/data-close-note/);assert.match(app,/data-close-ack/);assert.match(app,/action='close'/);
 assert.match(app,/group\.retryableRecords&&!group\.incomplete/);assert.match(app,/open&&!group\.incomplete/);
});
