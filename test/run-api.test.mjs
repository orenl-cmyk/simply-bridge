import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';import {mkdtemp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const loadRows=Number(process.env.BRIDGE_TEST_IMPORT_ROWS)||0;
const root=fileURLToPath(new URL('../',import.meta.url));
test('RUN creates, skips validation failure and continues; replay is idempotent; unknown writes survive restart and block repeats',async()=>{
 const rows=new Map(),writes=[];let serial=0,storedBeforeReply,dryProbe,dryReleased;const mock=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const b=JSON.parse(text);res.setHeader('content-type','application/json');if(req.url.includes('entity_structure'))return res.end(JSON.stringify({field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'title',field_type_name:'input-text'},{field_data_name:'external',field_type_name:'input-text'},{field_data_name:'link',field_type_name:'select-from-entity'},{field_data_name:'relation_json',field_type_name:'textarea'}]]}]}));if(req.url.includes('instance_data')){const value=b.filter[0][2];if(['dry-restart0','compact-second0'].includes(value)&&dryProbe){const started=dryProbe;dryProbe=null;started();await dryReleased;}if(b.filter[0][1]==='in'){const matches=[...new Set(value)].flatMap(k=>rows.has(k)?[rows.get(k)]:[]);return res.end(JSON.stringify({info:{total_count:matches.length},data:matches.map(instance_data=>({instance_data}))}));}const r=b.filter[0][0]==='_id'?[...rows.values()].find(row=>row._id===value):rows.get(value);return res.end(JSON.stringify({info:{total_count:r?1:0},data:r?[{instance_data:r}]:[]}));}
 writes.push({url:req.url,body:b});const form=b.form_data?.[0]?.data[0];if(form?.title==='slow')await new Promise(r=>setTimeout(r,50));if(form?.title==='bad')return res.end(JSON.stringify({error:{type:'validation',column:[{field_data_name:'title',message:'invalid value'}]}}));if(form?.title==='timeout'){req.socket.destroy();return;}
 if(req.url.includes('create_instance')){const id='created-'+(++serial);rows.set(form.external,{_id:id,field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'external',value:form.external}]]}]});if(form.title==='restart after write'){rows.get(form.external).field_groups[0].fields_data[0].push({field_data_name:'title',value:form.title});storedBeforeReply();await new Promise(r=>setTimeout(r,500));}return res.end(JSON.stringify({success:'ok',results:{_id:id}}));}const updated=[...rows.values()].find(row=>row._id===b.filter?.[0]?.[2]);if(updated&&b.field){for(const [field_data_name,value] of b.field){const fields=updated.field_groups[0].fields_data[0];const cell=fields.find(field=>field.field_data_name===field_data_name);if(cell)cell.value=value;else fields.push({field_data_name,value});}}res.end(JSON.stringify({success:'ok',results:{instances_updated:1}}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const work=path.resolve(root,'../../work');await mkdir(work,{recursive:true});const data=await mkdtemp(path.join(work,'run-test-')),port=4342,origin=`http://127.0.0.1:${port}`;let child,cookie='',extraEnv={};
 const keyFile=path.join(data,'service-key');await writeFile(keyFile,Buffer.alloc(32,42),{mode:0o600});
 const launch=async()=>{child=spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main',path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),DATA_DIR:data,BRIDGE_RECOVERY_KEY_FILE:keyFile,...extraEnv},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((r,j)=>{child.stdout.once('data',r);child.once('error',j);child.once('exit',()=>j(Error('server stopped')));});};
 const stop=async()=>{if(child&&!child.killed){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}};
 const call=async(route,body)=>{const r=await fetch(origin+'/api/'+route,{method:'POST',headers:{origin,'content-type':body instanceof Blob?body.type:'application/json',cookie},body:body instanceof Blob?body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,...await r.json()};};
 const entity=(values,prefix='key')=>({meta:{dataName:'users',name:'משתמשי אפליקציה'},records:values.map((title,i)=>({id:'source'+i,matchKey:prefix+i,data:{g:[{title}]}}))});let c;
 const plan=async(e,mapping)=>{const r=await call('import/dry-run',{connectionId:c,schemaVersion:'1.0',entity:e,mapping,targetId:'appUsers',targetKey:{kind:'field',groupId:'g',fieldId:'external'}});assert.equal(r.status,200);return r;};
 try{await launch();const page=await (await fetch(origin+'/')).text(),manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));assert.match(page,new RegExp('SIMPLY BRIDGE · v'+manifest.version.replaceAll('.','\\.')));assert.equal(page.includes('__APP_VERSION__'),false);assert.equal((await call('import/run',{planId:'fake',index:0})).status,401);await call('setup',{username:'admin',password:'test-password-123'});c=(await call('connections',{name:'test',maxConcurrentRequests:1,...(loadRows?{maxRequestsPerSecond:0,maxRequestsPerHour:0}:{}),username:'demo',secret:'demo-secret',baseUrl:`http://127.0.0.1:${mock.address().port}`})).connections[0].id;await call('select',{id:c});await call('schema/structure',{connectionId:c,entityId:'appUsers'});
 const presetBody={connectionId:c,name:'test import',sourceScope:'black',rules:[{sourceId:'users',targetId:'appUsers',targetKey:{kind:'field',groupId:'g',fieldId:'external'},mapping:[{sourceGroup:'g',targetGroup:'g',fields:[{sourceField:'title',targetField:'title'}]}]}]};const savedPreset=await call('import-presets/save',presetBody);assert.equal(savedPreset.status,200);assert.equal(savedPreset.presets.length,1);assert.equal((await call('import-presets/list',{connectionId:c,sourceScope:'other'})).presets.length,0);
 const p=await plan(entity(['good','bad','good']));assert.equal(writes.length,0);let results=[];for(let index=0;index<3;index++){const r=await call('import/run',{planId:p.planId,index});assert.equal(r.status,200);results.push(r.row);}
 assert.deepEqual(results.map(r=>r.status),['succeeded','failed','succeeded']);assert.equal(results[1].stop,false);assert.equal(results[1].sourceRecord.data.g[0].title,'bad');assert.equal(results[1].sourceEntityMeta.name,'משתמשי אפליקציה');assert.equal(results[1].error.details.column[0].field_data_name,'title');assert.equal(writes.length,3);assert.equal(writes[0].body.form_data[0].data[0].external,'key0');
 assert.equal((await call('import/run',{planId:p.planId,index:0})).replayed,true);assert.equal(writes.length,3);assert.equal((await call('import/finish',{planIds:[p.planId]})).success,false);assert.equal((await call('sync/state',{connectionId:c})).state.lastImportedAt,null);
 const clean=await plan(entity(['clean'],'other'));await call('import/run',{planId:clean.planId,index:0});assert.equal((await call('import/finish',{planIds:[clean.planId]})).success,true);const state=(await call('sync/state',{connectionId:c})).state;assert.ok(state.lastImportedAt);assert.equal(state.sourceSyncedThrough,null);
 const backgroundPlan=await plan(entity(['slow','slow'],'background'));const started=await call('import/run/start',{planIds:[backgroundPlan.planId],order:[0,1].map(index=>({planId:backgroundPlan.planId,index}))});assert.equal(started.status,202);await call('lock',{});await call('unlock',{username:'admin',password:'test-password-123'});let backgroundStatus;for(let i=0;i<50;i++){backgroundStatus=await call('import/run/status',{jobId:started.jobId});if(backgroundStatus.state!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(backgroundStatus.state,'done');assert.equal(backgroundStatus.counts.succeeded,2);assert.equal(backgroundStatus.progress.completed,2);const runArtifact=await call('jobs/artifact',{jobId:started.jobId});assert.equal(runArtifact.status,200);assert.equal(runArtifact.value.mode,'RUN');assert.equal(runArtifact.value.job.counts.succeeded,2);const errorsArtifact=await call('jobs/artifact',{jobId:started.jobId,failedOnly:true});assert.equal(errorsArtifact.value.writeResults.length,0);
 await call('schema/structure',{connectionId:c,entityId:'appUsers'});
 const update=await plan(entity(['new title'],'other'));assert.equal(update.result.rows[0].action,'update');const u=await call('import/run',{planId:update.planId,index:0});assert.equal(u.row.status,'succeeded');assert.equal(writes.at(-1).body.filter[0][2],rows.get('other0')._id);
 const mapped=entity(['mapped value'],'mapped');mapped.meta.fields=[{groupId:'g_206',fieldId:'old_title'}];mapped.records[0].data={g_206:[{old_title:'mapped value'}]};const mappedPlan=await plan(mapped,[{sourceGroup:'g_206',targetGroup:'g',fields:[{sourceField:'old_title',targetField:'title'}]}]);assert.equal(mappedPlan.result.rows[0].status,'planned');const mappedRun=await call('import/run',{planId:mappedPlan.planId,index:0});assert.equal(mappedRun.row.status,'succeeded');assert.equal(writes.at(-1).body.form_data[0].group_data_name,'g');assert.equal(writes.at(-1).body.form_data[0].data[0].title,'mapped value');assert.equal(JSON.stringify(writes.at(-1)).includes('g_206'),false);
 const linked=entity(['with relation'],'linked');linked.records[0].data.g[0].link={instance_id:'key0',text:'source label'};const relationMapping={entity:linked,targetId:'appUsers',targetKey:{kind:'field',groupId:'g',fieldId:'external'},mapping:[],relationStaging:{groupId:'g',fieldId:'relation_json'}};const linkedPlan=await call('import/dry-run',{connectionId:c,schemaVersion:'1.0',...relationMapping});assert.equal(linkedPlan.status,200);assert.equal(linkedPlan.result.counts.blocked,0);const linkedRun=await call('import/run',{planId:linkedPlan.planId,index:0});assert.equal(linkedRun.row.status,'succeeded');const linkedBody=writes.at(-1).body.form_data[0].data[0],relationJson=JSON.parse(linkedBody.relation_json);assert.equal(linkedBody.link,undefined);assert.deepEqual(relationJson.relations[0].candidates.ID,['key0']);assert.deepEqual(relationJson.relations[0].candidates.TEXT,['source label']);
 const relationPreset=await call('import-presets/save',{...presetBody,id:savedPreset.presets[0].id,rules:[{...presetBody.rules[0],mapping:[{sourceGroup:'g',targetGroup:'g',fields:[{sourceField:'title',targetField:'title'},{sourceField:'link',targetField:'link'}]}],relationStaging:{groupId:'g',fieldId:'relation_json'}}]});assert.equal(relationPreset.status,200);assert.deepEqual(relationPreset.presets[0].rules[0].relationStaging,{groupId:'g',fieldId:'relation_json'});assert.deepEqual(relationPreset.presets[0].relations,[]);
 const ambiguous=await plan(entity(['timeout','good'],'unknown'));const r=await call('import/run',{planId:ambiguous.planId,index:0});assert.equal(r.row.status,'unknown');assert.equal(r.row.stop,false);const count=writes.length,continued=await call('import/run',{planId:ambiguous.planId,index:1});assert.equal(continued.status,200);assert.equal(continued.row.status,'succeeded');assert.equal(writes.length,count+1);const afterContinue=writes.length;
 await stop();await launch();await call('unlock',{username:'admin',password:'test-password-123'});await call('schema/structure',{connectionId:c,entityId:'appUsers'});assert.deepEqual((await call('import-presets/list',{connectionId:c,sourceScope:'black'})).presets[0].rules[0].relationStaging,{groupId:'g',fieldId:'relation_json'});const deletedPreset=await call('import-presets/delete',{connectionId:c,sourceScope:'black',id:savedPreset.presets[0].id});assert.equal(deletedPreset.presets.length,0);const retry=await plan(entity(['timeout'],'unknown'));const retryResult=await call('import/run',{planId:retry.planId,index:0});assert.equal(retryResult.status,200);assert.equal(retryResult.row.status,'not_sent');assert.equal(writes.length,afterContinue);const history=await call('import/history',{connectionId:c});assert.ok(history.rows.some(r=>r.status==='unknown'));assert.ok(history.rows.some(r=>r.status==='failed'));assert.equal(history.rows.find(r=>r.status==='failed').sourceRecord.data.g[0].title,'bad');assert.equal(JSON.stringify(history).includes('demo-secret'),false);
 const recoveryPlan=await plan(entity(['restart after write','good'],'recovery'));
 const didWrite=new Promise(resolve=>{storedBeforeReply=resolve;});
 const recovery=await call('import/run/start',{planIds:[recoveryPlan.planId],order:[0,1].map(index=>({planId:recoveryPlan.planId,index}))});
 assert.equal(recovery.status,202);
 await didWrite;
 await stop();
 cookie='';
 await launch();
 assert.equal((await call('import/run/status',{jobId:recovery.jobId})).status,401);
 for(let i=0;i<100&&!rows.has('recovery1');i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(rows.has('recovery1'),'worker resumed before login');
 await call('unlock',{username:'admin',password:'test-password-123'});
 let recovered;
 for(let i=0;i<100;i++){
  recovered=await call('import/run/status',{jobId:recovery.jobId});
  if(recovered.state!=='running')break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(recovered.state,'done');
 assert.equal(recovered.counts.succeeded,2);
 for(const key of ['recovery0','recovery1'])assert.equal(writes.filter(write=>write.body.form_data?.[0]?.data[0]?.external===key).length,1);
 const dryStarted=new Promise(resolve=>{dryProbe=resolve;});
 let releaseDry;
 dryReleased=new Promise(resolve=>{releaseDry=resolve;});
 await call('schema/structure',{connectionId:c,entityId:'appUsers'});
 const dry=await call('import/prepare/start',{connectionId:c,schemaVersion:'1.0',mappings:[{
  ...relationMapping,entity:entity(['dry restart'],'dry-restart')
 }]});
 assert.equal(dry.status,202);
 await dryStarted;
 await stop();
 releaseDry();
 await launch();
 await call('unlock',{username:'admin',password:'test-password-123'});
 let dryStatus;
 for(let i=0;i<100;i++){
  dryStatus=await call('import/prepare/status',{jobId:dry.jobId,connectionId:c});
  if(dryStatus.state!=='running')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(dryStatus.state,'done');
 assert.equal(dryStatus.plans[0].result.rows[0].matchKey,'dry-restart0');
 assert.ok(!rows.has('dry-restart0'));
 const secondBatchStarted=new Promise(resolve=>{dryProbe=resolve;});
 let releaseSecond;
 dryReleased=new Promise(resolve=>{releaseSecond=resolve;});
 await call('schema/structure',{connectionId:c,entityId:'appUsers'});
 const compactBody=new Blob([
  JSON.stringify({connectionId:c,schemaVersion:'1.0'})+'\n',
  JSON.stringify({...relationMapping,entity:entity(['first'],'compact-first')})+'\n',
  JSON.stringify({...relationMapping,entity:entity(['second'],'compact-second')})+'\n'
 ],{type:'application/x-ndjson'});
 const compactImport=await call('import/pipeline/start',compactBody);
 assert.equal(compactImport.status,202);
 await secondBatchStarted;
 try{
  const detail=(await call('jobs/detail',{jobId:compactImport.jobId})).job;
  assert.equal(detail.state,'running');
  assert.deepEqual(detail.planIds,[]);
  assert.deepEqual(detail.completedKeys,[]);
  assert.equal(detail.progress.completed,1);
 }finally{releaseSecond();}
 for(let i=0;i<100;i++){
  if((await call('import/run/status',{jobId:compactImport.jobId})).state!=='running')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal((await call('import/run/status',{jobId:compactImport.jobId})).counts.succeeded,2);
 if(loadRows){
  const parts=[JSON.stringify({connectionId:c,schemaVersion:'1.0'})+'\n'];
  for(let offset=0;offset<loadRows;offset+=500){
   const records=Array.from({length:Math.min(500,loadRows-offset)},(_,index)=>({
    id:'source'+(offset+index),matchKey:'load'+(offset+index),data:{g:[{title:'synthetic'}]}
   }));
   parts.push(JSON.stringify({...relationMapping,entity:{meta:{dataName:'users'},records}})+'\n');
  }
  const started=performance.now();
  const result=await call('import/pipeline/start',new Blob(parts,{type:'application/x-ndjson'}));
  assert.equal(result.status,202);
  let status,peakBytes=0;
  const database=path.join(data,'jobs-v2','work.sqlite');
  do{
   await new Promise(resolve=>setTimeout(resolve,200));
   status=await call('import/run/status',{jobId:result.jobId});
   const sizes=await Promise.all(['','-wal','-shm'].map(suffix=>stat(database+suffix).then(info=>info.size,()=>0)));
   peakBytes=Math.max(peakBytes,sizes.reduce((sum,size)=>sum+size,0));
  }while(status.state==='running'&&performance.now()-started<600_000);
  assert.equal(status.state,'done');
  assert.equal(status.counts.succeeded,loadRows);
  const seconds=(performance.now()-started)/1000;
  const memory=await readFile('/proc/'+child.pid+'/status','utf8').catch(()=>null);
  console.log('IMPORT LOAD',JSON.stringify({records:loadRows,seconds,rowsPerSecond:loadRows/seconds,
   sampledPeakDiskBytes:peakBytes,serverPeakRssKiB:Number(memory?.match(/^VmHWM:\s+(\d+)/m)?.[1])||null}));
 }
 const rulesFile=path.join(data,'relation-rules.json');
 await writeFile(rulesFile,JSON.stringify({[c]:[{sourceEntity:'users',sourceRelatedEntity:'users',groupId:'g',fieldId:'link',targetEntity:'appUsers',valueMode:'sourceText',targetKey:{kind:'field',groupId:'g',fieldId:'external'}}]}));
 extraEnv={BRIDGE_RELATION_RULES_FILE:rulesFile};
 await stop();
 await launch();
 await call('unlock',{username:'admin',password:'test-password-123'});
 await call('schema/structure',{connectionId:c,entityId:'appUsers'});
 const later=entity(['first','second'],'pipeline');
 later.records[0].data.g[0].link={instance_id:'source1',text:'unusable as a lookup'};
 const batches=later.records.map(record=>({...relationMapping,entity:{...later,records:[record]}}));
 const pipeline=await call('import/pipeline/start',{connectionId:c,schemaVersion:'1.0',batches});
 assert.equal(pipeline.status,202);
 let pipelineStatus;
 for(let i=0;i<100;i++){
  pipelineStatus=await call('import/run/status',{jobId:pipeline.jobId});
  if(pipelineStatus.state!=='running')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(pipelineStatus.state,'done');
 assert.equal(pipelineStatus.relationIssueCount,0);
 let cleanedJob;
 for(let i=0;i<100;i++){
  cleanedJob=(await call('jobs/detail',{jobId:pipeline.jobId})).job;
  if(cleanedJob.cleanedAt)break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.ok(cleanedJob.cleanedAt);
 assert.equal(cleanedJob.inputId,undefined);
 assert.deepEqual(cleanedJob.planIds,[]);
 assert.equal(cleanedJob.counts.succeeded,2);
 assert.equal(rows.get('pipeline0').field_groups[0].fields_data[0].find(field=>field.field_data_name==='link')?.value,rows.get('pipeline1')._id);
 const missing=entity(['missing relation'],'repair');
 missing.records[0].data.g[0].link={instance_id:'not-exported',text:'repair key'};
 const needsRepair=await call('import/pipeline/start',{connectionId:c,schemaVersion:'1.0',batches:[{...relationMapping,entity:missing}]});
 for(let i=0;i<100;i++){
  if((await call('import/run/status',{jobId:needsRepair.jobId})).state!=='running')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 const group=(await call('repairs/groups',{})).groups.find(group=>group.jobId===needsRepair.jobId);
 assert.equal(group.kind,'not_found');
 assert.equal(group.count,1);
 rows.set('repair key',{_id:'replacement',field_groups:[{field_group_data:{group_data_name:'g'},fields_data:[[{field_data_name:'external',value:'repair key'}]]}]});
 const repairRequest={jobId:needsRepair.jobId,groupId:group.groupId};
 assert.equal((await call('repairs/retry-relations',{...repairRequest,mapping:null})).status,422);
 const correctedMapping={sourceRelatedEntity:'users',targetEntity:'appUsers',targetGroup:'g',targetField:'external',valueMode:'sourceText'};
 assert.equal((await call('repairs/retry-relations',{...repairRequest,mapping:correctedMapping})).status,202);
 for(let i=0;i<100;i++){
  if((await call('import/run/status',{jobId:needsRepair.jobId})).state==='done')break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal((await call('import/run/status',{jobId:needsRepair.jobId})).relationIssueCount,0);
 assert.equal(rows.get('repair0').field_groups[0].fields_data[0].find(field=>field.field_data_name==='link')?.value,'replacement');
 assert.equal((await call('jobs/close-relations',{jobId:needsRepair.jobId})).status,200);
 const blackConfigFile=path.join(data,'black-config.json'),blackTokenFile=path.join(data,'black-token');
 const blackToken='test-webhook-token-test-webhook-token';
 await writeFile(blackTokenFile,blackToken);
 await writeFile(blackConfigFile,JSON.stringify({connectionId:c,issueEntity:'appUsers',
  source:{base:'base',building:'building',floor:'floor',room:'room',topic:'topic',item:'item'},
  destination:{base:'baseId',building:'buildingId',floor:'floorId',room:'roomId',inventory:'inventoryId'},
  base:{entity:'base',name:'name'},building:{entity:'building',name:'name',base:'base'},
  floor:{entity:'floor',name:'name',building:'building'},room:{entity:'room',name:'name',floor:'floor'},
  catalog:{entity:'catalog',name:'name',topic:'topic'},
  inventory:{entity:'inventory',base:'base',building:'building',floor:'floor',topic:'topic',catalog:'catalog'}
 }));
 extraEnv={...extraEnv,BRIDGE_BLACK_CONFIG_FILE:blackConfigFile,BRIDGE_BLACK_TOKEN_FILE:blackTokenFile};
 await stop();
 await launch();
 const webhook=(route,body,token)=>fetch(origin+'/api/issues/'+route,{method:'POST',
  headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
 assert.equal((await webhook('resolve',{issueId:'missing'},'wrong-token')).status,401);
 const triggered=await webhook('resolve',{issueId:'missing'},blackToken);
 assert.equal(triggered.status,202);
 const {jobId}=await triggered.json();
 let issueStatus;
 for(let i=0;i<100;i++){
  issueStatus=await (await webhook('status',{jobId},blackToken)).json();
  if(!['queued','running'].includes(issueStatus.state))break;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(issueStatus.state,'completed_with_gaps');
 assert.equal(issueStatus.issues[0].role,'issue');
 }finally{await stop();await new Promise(r=>mock.close(r));}
});


