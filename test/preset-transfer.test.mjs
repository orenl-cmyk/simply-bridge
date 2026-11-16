import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPortablePreset,parsePortablePreset} from '../public/preset-transfer.js';

test('export preset transfer keeps mapping, binds to environment and removes local IDs and secrets',()=>{
 const preset={id:'local-id',connectionId:'connection-id',name:'Black preset',secret:'do-not-copy',entities:[{entityId:'issues',fields:[{groupId:'main',fieldId:'title'}],key:{kind:'recordId'}}]};
 const portable=createPortablePreset('export','https://red.example/origami/',preset);
 assert.equal(portable.environment.baseUrl,'https://red.example/origami');
 assert.equal(portable.preset.id,undefined);assert.equal(portable.preset.connectionId,undefined);assert.equal(portable.preset.secret,undefined);
 assert.deepEqual(parsePortablePreset(JSON.stringify(portable),'export','https://red.example/origami'),portable.preset);
 assert.throws(()=>parsePortablePreset(JSON.stringify(portable),'export','https://other.example/origami'));
 assert.throws(()=>parsePortablePreset(JSON.stringify(portable),'import','https://red.example/origami'));
});

test('import preset transfer keeps mapping and relation staging but drops legacy lookup rules',()=>{
 const preset={id:'local',connectionId:'red',sourceScope:'source-connection-id',name:'Import mapping',records:[{secret:'omit'}],rules:[{sourceId:'users',targetId:'appUsers',targetKey:{kind:'field',groupId:'g',fieldId:'external'},mapping:[{sourceGroup:'g',targetGroup:'g',fields:[{sourceField:'name',targetField:'name'}]}],relationStaging:{groupId:'g',fieldId:'relation_json'}}],relations:[{legacy:true}]};
 const portable=createPortablePreset('import','http://red.internal:8080',preset);
 assert.equal(portable.preset.sourceScope,undefined);assert.equal(portable.preset.records,undefined);assert.equal(portable.preset.rules.length,1);assert.deepEqual(portable.preset.rules[0].relationStaging,{groupId:'g',fieldId:'relation_json'});assert.deepEqual(portable.preset.relations,[]);
 assert.deepEqual(parsePortablePreset(JSON.stringify(portable),'import','http://red.internal:8080/'),portable.preset);
});
