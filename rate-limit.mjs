// One limiter shared by all connections and browser tabs in this process.
export function createLimiter({spacingMs=150,maxConcurrent=3}={}){
 let active=0,nextStart=0,pausedUntil=0,timer=null;const queue=[];
 function pump(){
  if(timer||active>=maxConcurrent||!queue.length)return;
  const delay=Math.max(nextStart,pausedUntil)-performance.now();
  if(delay>0){timer=setTimeout(()=>{timer=null;pump();},Math.ceil(delay));return;}
  const job=queue.shift();active++;nextStart=performance.now()+spacingMs;
  Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{active--;pump();});pump();
 }
 return {run:work=>new Promise((resolve,reject)=>{queue.push({work,resolve,reject});pump();}),pause(ms){pausedUntil=Math.max(pausedUntil,performance.now()+ms);if(timer){clearTimeout(timer);timer=null;}pump();}};
}
export const origamiLimiter=createLimiter();
