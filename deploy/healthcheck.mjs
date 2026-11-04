import http from 'node:http';
const u=new URL(process.env.PUBLIC_URL||'http://127.0.0.1:4318/'),base=u.pathname.replace(/\/+$/,'')+'/';
const req=http.get({hostname:'127.0.0.1',port:process.env.PORT||4318,path:base+'api/status',headers:{Host:u.host},timeout:4000},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{process.exit(res.statusCode===200&&typeof JSON.parse(body).initialized==='boolean'?0:1);}catch{process.exit(1);}});});
req.on('timeout',()=>req.destroy());req.on('error',()=>process.exit(1));
