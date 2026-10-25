// Deploy/schedule manually. This function never returns paths or invoice data.
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=(value:unknown):string=>{
 if(typeof value!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Error('Invalid cleanup identity');
 return value;
};
Deno.serve(async request=>{
 const secret=Deno.env.get('REVIEW_CLEANUP_SECRET')??'';
 const base=(Deno.env.get('SUPABASE_URL')??'').replace(/\/$/,'');
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 if(secret.length<32||secret.length>512||!base||!key)return json({error:'Cleanup configuration incomplete'},503);
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 const supplied=request.headers.get('x-review-cleanup-secret')??'';
 if(supplied.length>512)return json({error:'Unauthorized'},401);
 const hash=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const a=await hash(secret),b=await hash(supplied);let difference=0;
 for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
 if(difference)return json({error:'Unauthorized'},401);
 const headers:Record<string,string>={apikey:key,'Content-Type':'application/json'};
 if(!key.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
 async function call(path:string,body:unknown,method='POST'){
  const result=await fetch(base+path,{method,headers,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!result.ok)throw Error('Cleanup deferred');
  const text=await result.text();return text?JSON.parse(text):null;
 }
 // Leave time for each claimed job's delete + completion before hosted limits.
 // Unfinished/backlogged work stays durable for the next scheduled invocation.
 const deadline=Date.now()+90000;
 let removed=0,deferred=0;
 try{
  for(let i=0;i<20;i++){
   if(Date.now()>=deadline-30000){deferred=1;break;}
   const item=await call('/rest/v1/rpc/review_cleanup_claim',{});
   if(!item)break;
   const basePath=uuid(item.owner)+'/'+uuid(item.id);
   const prefixes=[basePath+'/source.xlsx'];
   for(const value of item.artifact_tokens){const token=uuid(value);prefixes.push(basePath+'/'+token+'/output.xlsx',basePath+'/'+token+'/report.csv');}
   await call('/storage/v1/object/gst-review-workbooks',{prefixes},'DELETE');
   await call('/rest/v1/rpc/review_cleanup_finish',{p_id:item.id,p_token:uuid(item.cleanup_token)});
   removed++;
  }
  if(Date.now()>=deadline-10000)return json({removed,deferred:1});
  const orphanPaths=await call('/rest/v1/rpc/review_orphan_paths',{});
  for(const path of orphanPaths){
   if(Date.now()>=deadline-10000){deferred=1;break;}
   if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/(?:source\.xlsx|[0-9a-f-]{36}\/(?:output\.xlsx|report\.csv))$/.test(path))throw Error('Invalid orphan path');
   await call('/storage/v1/object/gst-review-workbooks',{prefixes:[path]},'DELETE');
  }
  return json({removed,deferred});
 }catch{return json({removed,deferred:1},503);}
});
