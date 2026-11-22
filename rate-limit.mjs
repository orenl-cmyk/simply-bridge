export function createLimiter({spacingMs=100,maxConcurrent=3,windowMs=60*60*1000}={}){
 let active=0,nextStart=0,pausedUntil=0,timer=null;const queue=[],starts=[];
 const prune=now=>{while(starts.length&&starts[0]<=now-windowMs)starts.shift();};
 function pump(){
  if(timer||!queue.length)return;
  const pending=queue[0],cap=Math.max(1,Number(pending.maxConcurrent)||maxConcurrent);if(active>=cap)return;
  const hourly=Math.max(0,Math.floor(Number(pending.maxRequestsPerHour)||0)),now=Date.now();prune(now);
  const quotaDelay=hourly&&starts.length>=hourly?Math.max(0,starts[starts.length-hourly]+windowMs-now):0;
  const delay=Math.max(Math.max(nextStart,pausedUntil)-performance.now(),quotaDelay);
  if(delay>0){timer=setTimeout(()=>{timer=null;pump();},Math.ceil(delay));return;}
  const job=queue.shift();active++;starts.push(Date.now());nextStart=performance.now()+(Number.isFinite(job.spacingMs)?job.spacingMs:spacingMs);
  Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{active--;pump();});pump();
 }
 return {
  run:(work,options={})=>new Promise((resolve,reject)=>{queue.push({work,resolve,reject,spacingMs:options.spacingMs,maxConcurrent:options.maxConcurrent,maxRequestsPerHour:options.maxRequestsPerHour});pump();}),
  pause(ms){pausedUntil=Math.max(pausedUntil,performance.now()+Math.max(0,ms));if(timer){clearTimeout(timer);timer=null;}pump();},
  snapshot(maxRequestsPerHour=0){const now=Date.now(),hourly=Math.max(0,Math.floor(Number(maxRequestsPerHour)||0));prune(now);const used=starts.length,remaining=hourly?Math.max(0,hourly-used):null,resetMs=hourly&&used?Math.max(0,starts[0]+windowMs-now):0;return {active,queued:queue.length,pausedMs:Math.max(0,Math.ceil(pausedUntil-performance.now())),hourlyUsed:used,hourlyRemaining:remaining,hourlyResetMs:resetMs};}
 };
}

const states=new Map(),connectionCaps=new Map();
export function setConnectionRateCap(id,requestsPerSecond){
 connectionCaps.set(id,requestsPerSecond);
}
const connectionKey=connection=>String(connection?.id||connection?.baseUrl||'default');
function configured(connection){
 const configuredRps=Number.isFinite(Number(connection?.maxRequestsPerSecond))?Math.max(0,Number(connection.maxRequestsPerSecond)):10;
 const hourly=Number.isFinite(Number(connection?.maxRequestsPerHour))?Math.max(0,Math.floor(Number(connection.maxRequestsPerHour))):5000;
 const maxConcurrent=Number.isFinite(Number(connection?.maxConcurrentRequests))?Math.min(100,Math.max(1,Math.floor(Number(connection.maxConcurrentRequests)))):3;
 const cap=connectionCaps.get(connection?.id);
 const rps=cap?Math.min(configuredRps||cap,cap):configuredRps;
 return {rps,hourly,maxConcurrent};
}
export function rateState(connection){
 const key=connectionKey(connection),settings=configured(connection);let state=states.get(key);
 if(!state){state={limiter:createLimiter(),configuredRps:settings.rps,effectiveRps:settings.rps,configuredHourly:settings.hourly,maxConcurrent:settings.maxConcurrent,rateLimitHits:0,lastRateLimitAt:null};states.set(key,state);}
 if(state.configuredRps!==settings.rps){state.configuredRps=settings.rps;state.effectiveRps=settings.rps;}
 state.configuredHourly=settings.hourly;state.maxConcurrent=settings.maxConcurrent;return state;
}
export function rateOptions(connection){const state=rateState(connection),spacingMs=state.effectiveRps>0?Math.ceil(1000/state.effectiveRps):0;return {state,spacingMs,maxConcurrent:state.maxConcurrent,maxRequestsPerHour:state.configuredHourly};}
export function noteRateLimit(connection,pauseMs){const state=rateState(connection),base=state.effectiveRps>0?state.effectiveRps:(state.configuredRps>0?state.configuredRps:100);state.effectiveRps=Math.max(1,Math.floor(base/2));state.rateLimitHits++;state.lastRateLimitAt=new Date().toISOString();state.limiter.pause(pauseMs);return rateSnapshot(connection);}
export function rateSnapshot(connection){const state=rateState(connection);return {configuredRps:state.configuredRps,effectiveRps:state.effectiveRps,configuredHourly:state.configuredHourly,maxConcurrent:state.maxConcurrent,rateLimitHits:state.rateLimitHits,lastRateLimitAt:state.lastRateLimitAt,...state.limiter.snapshot(state.configuredHourly)};}
export function rateEtaSeconds(snapshot,remainingRequests){const remaining=Math.max(0,Math.ceil(Number(remainingRequests)||0)),hourly=Math.max(0,Math.floor(Number(snapshot?.configuredHourly)||0)),available=Number.isFinite(snapshot?.hourlyRemaining)?Math.max(0,snapshot.hourlyRemaining):remaining;let quota=0;if(hourly&&remaining>available)quota=Math.ceil((Number(snapshot.hourlyResetMs)||0)/1000)+Math.floor((remaining-available-1)/hourly)*3600;const perSecond=Number(snapshot?.effectiveRps)>0?Math.ceil(remaining/Number(snapshot.effectiveRps)):0;return Math.max(quota,perSecond);}

// Kept for callers that do not have a connection identity.
export const origamiLimiter=createLimiter();
