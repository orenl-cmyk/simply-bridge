const normalizedMessage=value=>String(value||'').trim().toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'{id}').replace(/\b\d+\b/g,'{n}').replace(/\s+/g,' ');

export function repairRootCause(row={}){
 const error=row.error||{},details=Array.isArray(error.details?.column)?error.details.column:[],field=details[0]?.field_data_name||details[0]?.fieldId;
 if(error.kind==='validation'||details.length)return {key:'validation:'+(field||'record'),title:'ולידציה ביעד'+(field?' · '+field:''),detail:details[0]?.message||error.message||'היעד דחה את הרשומה'};
 if(error.kind==='authorization'||/הרשא|authori[sz]|forbidden|\b403\b/i.test(error.message||''))return {key:'authorization',title:'הרשאה ליעד',detail:error.message||'אין הרשאה לפעולת הכתיבה'};
 if(error.kind==='rate_limit'||/rate.?limit|\b429\b/i.test(error.message||''))return {key:'rate-limit',title:'מגבלת קצב',detail:error.message||'היעד הגביל את קצב הבקשות'};
 if(['unknown','pending'].includes(row.status))return {key:'unknown-result',title:'תוצאה לא ידועה',detail:error.message||'נדרש אימות ידני ביעד לפני Retry'};
 const reasons=Array.isArray(row.reasons)?row.reasons.join(' | '):'';
 if(/מיפוי|mapping|שדה יעד|target field|_id|מפתח הצלבה/i.test(reasons+' '+(error.message||'')))return {key:'mapping-target',title:'מיפוי או יעד',detail:reasons||error.message||'נדרש תיקון מיפוי או יעד'};
 const message=error.message||reasons||row.status||'תקלה לא מסווגת';
 return {key:'other:'+row.status+':'+normalizedMessage(message),title:'תקלה אחרת · '+(row.status||'לא ידוע'),detail:message};
}

export function summarizeRepairGroups(issues=[]){
 const groups=new Map();
 for(const issue of issues){
  const cause=repairRootCause(issue),groupId=JSON.stringify([issue.jobId,cause.key]);
  let group=groups.get(groupId);
  if(!group){group={groupId,jobId:issue.jobId,rootCauseKey:cause.key,title:cause.title,detail:cause.detail,
   connectionName:issue.connectionName||'',jobLabel:issue.jobLabel||'',affectedRecords:0,retryableRecords:0,closeableRecords:0};groups.set(groupId,group);}
  group.affectedRecords++;
  if(['failed','not_sent'].includes(issue.status)&&issue.repairStatus!=='closed'&&!issue.semanticPreview)group.retryableRecords++;
  if(issue.repairStatus!=='closed')group.closeableRecords++;
 }
 return [...groups.values()].sort((a,b)=>b.affectedRecords-a.affectedRecords||a.title.localeCompare(b.title,'he'));
}
