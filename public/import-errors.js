export function validationDetails(error){
 const columns=Array.isArray(error?.details?.column)?error.details.column:[];
 return columns.map(column=>({fieldId:column.field_data_name??column.fieldId??null,fieldName:column.field_name??column.field_data_name??null,message:column.message??error?.message??'הרשומה נדחתה בוולידציה של SIMPLY'})).filter(item=>item.fieldName||item.message);
}
export function humanError(row){
 const details=validationDetails(row?.error);
 if(details.length)return details.map(item=>(item.fieldName?item.fieldName+': ':'')+item.message).join(' · ');
 return row?.error?.message||(row?.reasons||[]).join(' | ')||'שגיאה לא ידועה';
}
export function buildErrorReport(rows,plans=[]){
 const issues=rows.filter(r=>r.status!=='succeeded').map(row=>{
  const plan=plans.find(p=>p.id===row.planId),record=row.sourceRecord??plan?.sourceEntity?.records?.find(r=>r.id===row.sourceId);
  const reasons=row.reasons??[],forcedId=reasons.some(reason=>/_id|מזהה.*יעד/.test(reason)),validation=validationDetails(row.error);return {status:row.status,category:forcedId?'target-id-not-found':row.status==='failed'?'target-validation':'mapping-or-write',action:row.action,entity:{source:row.sourceEntityMeta??plan?.sourceEntity?.meta??null,targetDataName:row.targetEntity,name:row.entityName},connection:{id:row.connectionId,name:row.connectionName},sourceId:row.sourceId,matchKey:row.matchKey,targetId:row.targetId??null,error:row.error??null,validation,humanMessage:humanError(row),reasons,warnings:row.warnings??[],sourceRecord:record??null,recordAvailable:!!record,targetRecord:row.targetRecord??null,writePayload:row.writePayload??null,relationResolution:row.relationResolution??{},targetKey:row.targetKey??plan?.targetKey??null,mapping:row.mapping??plan?.mapping??[],startedAt:row.startedAt,finishedAt:row.finishedAt,planId:row.planId,requiresTargetCheck:['unknown','pending','stopped'].includes(row.status),nextStep:forcedId?'מפתח ההצלבה לא נמצא ב־_id של היעד. בדקו שבייצוא נבחר שדה המזהה של רשת היעד; ליצירה חדשה בחרו שדה מזהה חיצוני ביעד.':row.status==='failed'?'תקנו את הערך במקור או בחבילת הייבוא לפי הודעת הוולידציה, ובצעו Dry Run חדש לפני ניסיון נוסף.':['unknown','pending','stopped'].includes(row.status)?'יש לבדוק את מצב הרשומה ביעד לפני ניסיון נוסף. אין לבצע שליחה חוזרת אוטומטית.':'בדקו את סיבת החסימה ובצעו Dry Run חדש לאחר התיקון.'};
 });
 return {reportType:'simply-import-skipped',reportVersion:'1.1',createdAt:new Date().toISOString(),summary:{totalNotSent:issues.length,targetIdNotFound:issues.filter(r=>r.category==='target-id-not-found').length,validationFailures:issues.filter(r=>r.status==='failed').length,otherIssues:issues.filter(r=>!['target-id-not-found','target-validation'].includes(r.category)).length,missingRecordContent:issues.filter(r=>!r.recordAvailable).length},note:'הדוח כולל רשומות חסומות, כשלי ולידציה ותוצאות לא ידועות. הוא אינו חבילת ייבוא ואינו מיועד להרצה מחדש.',issues};
}
