// Parse the package structure incrementally and retain document offsets for record batches.
async function* tokens(file){
 const reader=file.stream().getReader();
 const decoder=new TextDecoder('utf-8',{fatal:true});
 let offset=0,start=0,parts=[],string=false,escape=false,atom=false;
 const punctuation=new Set([123,125,91,93,44,58]);
 const space=byte=>byte===32||byte===10||byte===13||byte===9;
 // TextDecoder strips a BOM by default. Skip it explicitly only at the start.
 const header=new Uint8Array(await file.slice(0,3).arrayBuffer());
 const bom=header[0]===239&&header[1]===187&&header[2]===191?3:0;
 const decode=()=>{
  const text=parts.map((part,index)=>decoder.decode(part,{stream:index<parts.length-1})).join('');
  parts=[];
  return JSON.parse(text);
 };
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   let segment=0;
   for(let index=0;index<value.length;index++,offset++){
    const byte=value[index];
    if(offset<bom){segment=index+1;continue;}
    if(string){
     if(escape)escape=false;
     else if(byte===92)escape=true;
     else if(byte===34){
      parts.push(value.subarray(segment,index+1));
      yield {kind:'value',value:decode(),start,end:offset+1};
      string=false;
      segment=index+1;
     }
     continue;
    }
    if(atom&&(space(byte)||punctuation.has(byte))){
     parts.push(value.subarray(segment,index));
     yield {kind:'value',value:decode(),start,end:offset};
     atom=false;
    }
    if(atom)continue;
    segment=index;
    if(space(byte))continue;
    if(punctuation.has(byte)){yield {kind:String.fromCharCode(byte),start:offset,end:offset+1};continue;}
    start=offset;
    if(byte===34)string=true;
    else atom=true;
   }
   if(string||atom)parts.push(value.subarray(segment));
  }
  if(string)throw Error('מחרוזת JSON לא הסתיימה.');
  if(atom)yield {kind:'value',value:decode(),start,end:offset};
 }finally{await reader.cancel();reader.releaseLock();}
}

export async function indexImportFile(file,batchSize){
 const stream=tokens(file);
 let token;
 const advance=async()=>{token=(await stream.next()).value;};
 const requireKind=kind=>{if(token?.kind!==kind)throw Error('מבנה חבילת הייבוא אינו תקין.');};
 async function array(each){
  requireKind('[');await advance();
  if(token?.kind!==']'){
   for(;;){
    await each();
    if(token?.kind===']')break;
    requireKind(',');await advance();
   }
  }
  await advance();
 }
 async function object(each){
  requireKind('{');await advance();
  const keys=new Set();
  if(token?.kind!=='}'){
   for(;;){
    requireKind('value');
    const key=token.value;
    if(typeof key!=='string'||keys.has(key))throw Error('מפתח JSON לא תקין או כפול.');
    keys.add(key);
    await advance();requireKind(':');await advance();
    await each(key);
    if(token?.kind==='}')break;
    requireKind(',');await advance();
   }
  }
  await advance();
 }
 async function value(){
  if(token?.kind==='{'){
   const result=Object.create(null);
   await object(async key=>{result[key]=await value();});
   return result;
  }
  if(token?.kind==='['){
   const result=[];
   await array(async()=>{result.push(await value());});
   return result;
  }
  requireKind('value');
  const result=token.value;
  await advance();
  return result;
 }
 let meta;
 const entities=Object.create(null),batches=Object.create(null);
 try{
  await advance();
  await object(async key=>{
   if(key==='meta'){meta=await value();return;}
   if(key!=='entities'){await value();return;}
   await object(async id=>{
    const fields=new Map(),ranges=[];
    let entityMeta,count=0,first=null;
    await object(async property=>{
     if(property==='meta'){entityMeta=await value();return;}
     if(property!=='records'){await value();return;}
     await array(async()=>{
      requireKind('{');
      const start=token.start;
      const record=await value();
      for(const [group,rows] of Object.entries(record.data||{})){
       if(!fields.has(group))fields.set(group,new Set());
       if(!Array.isArray(rows))throw Error('קבוצת רשומה אינה תקינה.');
       for(const row of rows)for(const name of Object.keys(row))fields.get(group).add(name);
      }
      first??=record;
      if(count%batchSize===0)ranges.push({start,end:0,count:0});
      const range=ranges.at(-1);
      range.count++;range.end=token.start;count++;
     });
    });
    const declared=entityMeta?.fields||[];
    const known=new Set(declared.map(field=>JSON.stringify([field.groupId,field.fieldId])));
    const observed=[...fields].flatMap(([groupId,names])=>[...names].filter(fieldId=>!known.has(JSON.stringify([groupId,fieldId]))).map(fieldId=>({groupId,fieldId})));
    const layoutRecord=first||null;
    if(layoutRecord){
     for(const [group,names] of fields){
      if(!names.size&&!Object.hasOwn(layoutRecord.data,group))layoutRecord.data[group]=[];
     }
    }
    entities[id]={meta:{...entityMeta,fields:[...declared,...observed],recordCount:count},records:layoutRecord?[layoutRecord]:[]};
    batches[id]=ranges;
   });
  });
  if(token||meta?.schemaVersion!=='1.0')throw Error('חבילה לא מוכרת.');
  return {meta,entities,batches};
 }finally{await stream.return();}
}

export async function readImportBatch(file,range){
 const source=file.slice(range.start,range.end);
 return JSON.parse(await new Blob(['[',source,']']).text());
}

export function framedImportBody(header,batches){
 const parts=[JSON.stringify(header)+'\n'];
 for(const {mapping,range,file} of batches){
  const description={...mapping,entity:{meta:mapping.entity.meta}};
  const records=file.slice(range.start,range.end);
  parts.push(JSON.stringify({bytes:records.size,mapping:description})+'\n',records);
 }
 return new Blob(parts,{type:'application/x-bridge-batches'});
}
