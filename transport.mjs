import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

export const ipv4Lookup=(hostname,options,callback)=>dns.lookup(hostname,{...options,family:4,all:false},callback);

export function postJson(url,body,{timeoutMs=30000,lookup=ipv4Lookup}={}){
 return new Promise((resolve,reject)=>{
  const target=new URL(url),client=target.protocol==='https:'?https:target.protocol==='http:'?http:null;
  if(!client)return reject(Object.assign(new Error('Unsupported protocol: '+target.protocol),{code:'EPROTO'}));
  const payload=JSON.stringify(body);
  const request=client.request({
   protocol:target.protocol,hostname:target.hostname,port:target.port||undefined,
   path:target.pathname+target.search,method:'POST',family:4,lookup,
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}
  },response=>{
   const chunks=[];
   response.on('data',chunk=>chunks.push(chunk));
   response.on('end',()=>{
    const rawHeaders=response.headers;
    resolve({
     status:response.statusCode||0,statusText:response.statusMessage||'',
     ok:(response.statusCode||0)>=200&&(response.statusCode||0)<300,
     headers:{get:name=>{const value=rawHeaders[String(name).toLowerCase()];return Array.isArray(value)?value.join(', '):value??null;}},
     text:async()=>Buffer.concat(chunks).toString('utf8')
    });
   });
  });
  request.setTimeout(timeoutMs,()=>request.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs} ms`),{code:'ETIMEDOUT'})));
  request.on('error',reject);
  request.end(payload);
 });
}
