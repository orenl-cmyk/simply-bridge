export function createLimiter({spacingMs=100,maxConcurrent=3}={}){
 let active=0,nextStart=0,pausedUntil=0,timer=null;const queue=[];
 function pump(){
  if(timer||!queue.length)return;
  const cap=Math.max(1,Number(queue[0].maxConcurrent)||maxConcurrent);if(active>=cap)return;
  const delay=Math.max(nextStart,pausedUntil)-performance.now();
  if(delay>0){timer=setTimeout(()=>{timer=null;pump();},Math.ceil(delay));return;}
  const job=queue.shift();active++;nextStart=performance.now()+(Number.isFinite(job.spacingMs)?job.spacingMs:spacingMs);
  Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{active--;pump();});pump();
 }
 return {
  run:(work,options={})=>new Promise((resolve,reject)=>{queue.push({work,resolve,reject,spacingMs:options.spacingMs,maxConcurrent:options.maxConcurrent});pump();}),
  pause(ms){pausedUntil=Math.max(pausedUntil,performance.now()+Math.max(0,ms));if(timer){clearTimeout(timer);timer=null;}pump();},
  snapshot:()=>({active,queued:queue.length,pausedMs:Math.max(0,Math.ceil(pausedUntil-performance.now()))})
 };
}

const states=new Map();
const connectionKey=connection=>String(connection?.id||connection?.baseUrl||'default');
function configured(connection){
 const rps=Number.isFinite(Number(connection?.maxRequestsPerSecond))?Math.max(0,Number(connection.maxRequestsPerSecond)):10;
 const maxConcurrent=Number.isFinite(Number(connection?.maxConcurrentRequests))?Math.min(100,Math.max(1,Math.floor(Number(connection.maxConcurrentRequests)))):3;
 return {rps,maxConcurrent};
}
export function rateState(connection){
 const key=connectionKey(connection),settings=configured(connection);let state=states.get(key);
 if(!state){state={limiter:createLimiter(),configuredRps:settings.rps,effectiveRps:settings.rps,maxConcurrent:settings.maxConcurrent,rateLimitHits:0,lastRateLimitAt:null};states.set(key,state);}
 if(state.configuredRps!==settings.rps){state.configuredRps=settings.rps;state.effectiveRps=settings.rps;}
 state.maxConcurrent=settings.maxConcurrent;return state;
}
export function rateOptions(connection){const state=rateState(connection),spacingMs=state.effectiveRps>0?Math.ceil(1000/state.effectiveRps):0;return {state,spacingMs,maxConcurrent:state.maxConcurrent};}
export function noteRateLimit(connection,pauseMs){const state=rateState(connection),base=state.effectiveRps>0?state.effectiveRps:(state.configuredRps>0?state.configuredRps:100);state.effectiveRps=Math.max(1,Math.floor(base/2));state.rateLimitHits++;state.lastRateLimitAt=new Date().toISOString();state.limiter.pause(pauseMs);return rateSnapshot(connection);}
export function rateSnapshot(connection){const state=rateState(connection);return {configuredRps:state.configuredRps,effectiveRps:state.effectiveRps,maxConcurrent:state.maxConcurrent,rateLimitHits:state.rateLimitHits,lastRateLimitAt:state.lastRateLimitAt,...state.limiter.snapshot()};}

// Kept for callers that do not have a connection identity.
export const origamiLimiter=createLimiter();
