const normalized=value=>String(value??'').trim().toLowerCase().replace(/[\s-]+/g,'_');
const rateTypes=new Set(['max_api_calls','rate_limit','rate_limited','too_many_requests','api_limit','quota_exceeded']);
const uniquenessCodes=new Set(['unique_constraint','unique_violation','duplicate_key','unique_constraint_violation']);
const validationTypes=new Set(['validation','validation_error','invalid_data','invalid_request','data']);
const authorizationTypes=new Set(['authorization','authentication','permission','permissions','access_denied','unauthorized','forbidden']);
const systemTypes=new Set(['system','internal','internal_error','server_error','service_unavailable','maintenance']);

export function classifyOrigamiResult({status=0,data,responseOk=false}={}){
 const error=data?.error??(Array.isArray(data?.errors)&&data.errors.length?data.errors:null),type=normalized(error?.type??error?.code),message=normalized(error?.message);
 if(status===429||rateTypes.has(type)||/rate.*limit|max.*api.*call|quota.*exceed|too.*many.*request/.test(type+' '+message))return {kind:'rate_limit',error:error??data,definiteRejection:true};
 if([401,403].includes(Number(status))||authorizationTypes.has(type)||/unauthor|forbidden|permission|access.*denied|authentication/.test(type+' '+message))return {kind:'authorization',error:error??data,definiteRejection:true};
 if([500,502,503,504].includes(Number(status)))return {kind:'system',error:error??data,definiteRejection:false};
 if(uniquenessCodes.has(type)||uniquenessCodes.has(normalized(error?.code)))return {kind:'uniqueness',error,definiteRejection:true};
 if(validationTypes.has(type)||/validation|invalid.*(?:field|value|data|required)/.test(type+' '+message))return {kind:'validation',error:error??data,definiteRejection:true};
 if(systemTypes.has(type))return {kind:'system',error:error??data,definiteRejection:Number(status)>0||!!error};
 if(error||data?.errors||data?.success===false)return {kind:'api_error',error:error??data,definiteRejection:true};
 if(!responseOk)return {kind:'http_error',error:data,definiteRejection:Number(status)>0};
 return {kind:'success',error:null,definiteRejection:false};
}

export function isRateLimitResult(input){return classifyOrigamiResult(input).kind==='rate_limit';}
