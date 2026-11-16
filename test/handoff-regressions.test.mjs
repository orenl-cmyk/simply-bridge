import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceLayout,applyImportMapping} from '../public/import-mapping.js';
import {createImportBatches} from '../public/import-batches.js';
import {buildErrorReport,humanError} from '../public/import-errors.js';
import {exportFileName,finalizeExportEntities} from '../public/export-package.js';

const schema={groups:[{id:'target',fields:[{id:'common',type:'input-text'},{id:'rare',type:'input-text'}]}]};
const mapping=[{sourceGroup:'source',targetGroup:'target',fields:[{sourceField:'common',targetField:'common'},{sourceField:'rare',targetField:'rare'}]}];
const records=Array.from({length:501},(_,index)=>({id:String(index),matchKey:String(index),data:{source:[index===500?{common:'value',rare:'late'}:{common:'value'}]}}));
const entity={meta:{dataName:'issues',fields:[{groupId:'source',fieldId:'common'},{groupId:'source',fieldId:'rare'}]},records};

test('canonical source layout comes from metadata and survives a 500 record boundary',()=>{
 assert.deepEqual(sourceLayout(entity),[{id:'source',fields:['common','rare']}]);
 const {batches}=createImportBatches([{entity,targetId:'issues',targetKey:{kind:'recordId'},mapping}],500);
 assert.equal(batches.length,2);assert.deepEqual(batches[0].entity.meta.fields,entity.meta.fields);
 assert.doesNotThrow(()=>applyImportMapping(batches[0].entity,schema,mapping));
 assert.equal(applyImportMapping(batches[1].entity,schema,mapping).records[0].data.target[0].rare,'late');
});

test('metadata-only field is valid, while an unknown preset field fails before Dry Run',()=>{
 const metadataOnly={meta:entity.meta,records:[{id:'one',matchKey:'one',data:{source:[{common:'x'}]}}]};
 const mapped=applyImportMapping(metadataOnly,schema,mapping);assert.deepEqual(mapped.records[0].data.target,[{common:'x'}]);assert.equal(Object.hasOwn(mapped.records[0].data.target[0],'rare'),false);
 const forged=structuredClone(mapping);forged[0].fields.push({sourceField:'missing',targetField:'rare'});assert.throws(()=>applyImportMapping(metadataOnly,schema,forged),/שדה מקור אינו קיים/);
});

test('empty legacy entities are not batched',()=>{const empty={entity:{meta:{dataName:'empty',fields:[]},records:[]},targetId:'empty',targetKey:{kind:'recordId'},mapping:[]};assert.deepEqual(createImportBatches([empty]),{batches:[],totalRecords:0});});

test('final export omits empty entities and rejects unresolved duplicate match keys',()=>{
 const full={meta:{name:'מלא'},records:[{id:'1',matchKey:'a'}]},empty={meta:{name:'ריק'},records:[]},result=finalizeExportEntities({full,empty});
 assert.deepEqual(Object.keys(result.entities),['full']);assert.deepEqual(result.checkedEmpty,[{dataName:'empty',name:'ריק'}]);
 assert.throws(()=>finalizeExportEntities({bad:{meta:{},records:[{id:'1',matchKey:'x'},{id:'2',matchKey:'x'}]}}),/כפול/);
});

test('export filename includes connection, preset, readable local time and Windows-safe parts',()=>{const name=exportFileName('שחורי:בדיקה','בינוי/שחור full','json',new Date(2026,10,16,9,7));assert.equal(name,'simply-bridge_שחורי-בדיקה_בינוי-שחור-full_2026-11-16_09-07.json');assert.ok(name.length<=180);});

test('SIMPLY validation details keep every Hebrew field message in UI and download report',()=>{
 const row={status:'failed',sourceId:'6af57e190c33965490017259',entityName:'תקלות',error:{kind:'validation',message:'הרשומה נדחתה בוולידציה של SIMPLY',details:{column:[{field_data_name:'fld_1773',field_name:"מס' פנייה",message:"מס' פנייה לא בפורמט המתאים."},{field_data_name:'fld_2',message:'ערך חסר'}]}}};
 assert.equal(humanError(row),"מס' פנייה: מס' פנייה לא בפורמט המתאים. · fld_2: ערך חסר");const issue=buildErrorReport([row]).issues[0];assert.equal(issue.validation.length,2);assert.equal(issue.validation[0].fieldId,'fld_1773');assert.match(issue.humanMessage,/פורמט המתאים/);
});
