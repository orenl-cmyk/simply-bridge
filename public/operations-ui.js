import {repairRootCause} from './repair-grouping.js';

export const OPERATION_STAGES=[
 {id:'input',label:'קליטת קובץ'},
 {id:'checking',label:'בדיקה ותכנון'},
 {id:'relations',label:'השלמת קשרים'},
 {id:'writing',label:'כתיבה'}
];

const phaseIndex=phase=>{
 const value=String(phase||'starting').toLowerCase();
 if(['complete','completed','done'].includes(value))return OPERATION_STAGES.length;
 if(['writing','write','running'].includes(value))return 3;
 if(['relations','relation_finalizer','finalizing_relations','finalizing-relations'].includes(value))return 2;
 if(['checking','planning','validating','preparing'].includes(value))return 1;
 return 0;
};

export function operationStages(job={}){
 const state=String(job.state||'running'),progress=job.progress||{},phase=String(progress.phase||'starting').toLowerCase();
 const relationTotal=Number(progress.relationsTotal),relationCompleted=Number(job.relationCompleted??progress.relationCompleted??0);
 const writeTotal=Number(progress.total),writesCompleted=Number(progress.completed||0);
 const terminal=['done','completed_with_gaps','needs_attention','stopped','error'].includes(state);
 const fallback=phaseIndex(phase),relationDone=Number.isFinite(relationTotal)&&relationTotal>0?
  relationCompleted>=relationTotal:['writing','complete','completed','done'].includes(phase)||state==='done';
 const checkingDone=Number(progress.checkTotal)>0?
  Number(progress.checked||0)>=Number(progress.checkTotal):fallback>=2||phase==='complete'||state==='done';
 const writesDone=Number.isFinite(writeTotal)&&writeTotal>0?
  writesCompleted>=writeTotal:['complete','completed','done'].includes(phase)||state==='done';
 const statuses=[
  phase==='starting'?'active':'done',
  checkingDone?'done':phase==='checking'?'active':'pending',
  relationDone?(state==='completed_with_gaps'?'attention':'done'):phase==='relations'?'active':terminal?'attention':'pending',
  writesDone?'done':phase==='writing'||writesCompleted>0?'active':terminal?'attention':'pending'
 ];
 if(state==='paused'||state==='stopped'){
  const current=statuses.findIndex(value=>value==='active');
  if(current>=0)statuses[current]='paused';
 }
 if(state==='error'){
  const current=statuses.findIndex(value=>value==='active');
  if(current>=0)statuses[current]='error';
 }
 return OPERATION_STAGES.map((stage,index)=>({...stage,status:statuses[index]}));
}

export function operationStatus(job={}){
 const states={running:'פעילה',paused:'מושהית',stopped:'נעצרה',done:'הושלמה',completed_with_gaps:'הושלמה עם חריגים',needs_attention:'נדרשת תשומת לב',error:'נכשלה'};
 const stage=operationStages(job).find(item=>['active','paused','error','attention'].includes(item.status)),generic=job.type==='export'?'ייצוא נתונים':job.type==='import_prepare'?'בדיקה ותכנון':null;
 const progress=job.progress||{},eta=Number.isFinite(progress.overallEtaSeconds)?progress.overallEtaSeconds:progress.etaSeconds;
 return {label:states[job.state]||job.state||'ממתינה',stage:generic||(stage?.label||'הושלמה'),eta:formatEta(eta)};
}

export function formatEta(seconds){
 if(!Number.isFinite(Number(seconds))||Number(seconds)<0)return '';
 const value=Math.ceil(Number(seconds));
 if(value<60)return 'פחות מדקה';
 const minutes=Math.ceil(value/60);
 if(minutes<60)return 'כ־'+minutes+' דקות';
 const hours=Math.floor(minutes/60),rest=minutes%60;
 return 'כ־'+hours+' שעות'+(rest?' ו־'+rest+' דקות':'');
}

export function activeOperation(jobs=[],rememberedId=''){
 const active=jobs.filter(job=>['running','paused'].includes(job.state));
 return active.find(job=>job.id===rememberedId)||active.find(job=>job.state==='running')||active[0]||null;
}

export {repairRootCause};

export function groupRepairIssues(rows=[]){
 const groups=new Map();
 for(const row of rows){
  const cause=repairRootCause(row),group=groups.get(cause.key)||{...cause,rows:[],issueIds:[],affectedRecords:0,retryableRecords:0,closedRecords:0};
  group.rows.push(row);if(row.issueId&&!group.issueIds.includes(row.issueId))group.issueIds.push(row.issueId);
  group.affectedRecords=group.issueIds.length||group.rows.length;
  if(['failed','not_sent'].includes(row.status)&&row.repairStatus!=='closed')group.retryableRecords++;
  if(row.repairStatus==='closed')group.closedRecords++;
  groups.set(cause.key,group);
 }
 return [...groups.values()].sort((a,b)=>b.affectedRecords-a.affectedRecords||a.title.localeCompare(b.title,'he'));
}

export function parseCorrectedPayloads(value){
 let parsed;try{parsed=JSON.parse(value);}catch{throw Error('תיקון היעד חייב להיות JSON תקין.');}
 if(!Array.isArray(parsed)||!parsed.length||parsed.length>50)throw Error('יש לספק מערך של 1–50 בקשות יעד.');
 if(parsed.some(item=>!item||typeof item.operation!=='string'||!item.body||typeof item.body!=='object'||Array.isArray(item.body)))throw Error('כל בקשה חייבת לכלול operation ו־body.');
 return parsed;
}
