export function createImportBatches(mappings,batchSize=500){
 if(!Array.isArray(mappings)||!Number.isInteger(batchSize)||batchSize<1)throw Error('הגדרות אצוות הייבוא אינן תקינות.');
 const batches=[],seen=new Set();let totalRecords=0;
 for(const mapping of mappings){
  const records=mapping?.entity?.records;if(!Array.isArray(records))throw Error('רשומות הייבוא אינן תקינות.');
  totalRecords+=records.length;
  for(const record of records){const key=JSON.stringify([mapping.targetId,mapping.targetKey,String(record.matchKey)]);if(seen.has(key))throw Error('יותר מרשומת מקור אחת מופנית לאותו מפתח יעד: '+record.matchKey);seen.add(key);}
  if(!records.length)continue;
  for(let offset=0;offset<records.length;offset+=batchSize){const slice=records.slice(offset,offset+batchSize);batches.push({...mapping,entity:{...mapping.entity,meta:{...mapping.entity.meta,recordCount:slice.length},records:slice}});}
 }
 return {batches,totalRecords};
}
