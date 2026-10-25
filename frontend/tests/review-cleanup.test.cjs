const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const esbuild=require('esbuild');

function runtime(fetch,configured=true,clock){
 let handler;
 const env=configured?{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test_only',REVIEW_CLEANUP_SECRET:'local-test-only-secret-0000000000000000'}:{};
 const code=esbuild.transformSync(fs.readFileSync('../supabase/functions/review-cleanup/index.ts','utf8'),{loader:'ts',format:'cjs'}).code;
 vm.runInNewContext(code,{Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},Request,Response,TextEncoder,AbortSignal,crypto:webcrypto,fetch,Date:clock?{now:clock}:Date});
 return {handler,env};
}

test('private review cleanup rejects missing configuration and unauthorized invocations',async()=>{
 const missing=runtime(()=>{throw Error('must not fetch');},false);
 assert.equal((await missing.handler(new Request('https://local',{method:'POST'}))).status,503);
 const ready=runtime(()=>{throw Error('must not fetch');});
 assert.equal((await ready.handler(new Request('https://local',{method:'POST'}))).status,401);
 assert.equal((await ready.handler(new Request('https://local'))).status,405);
});

test('private cleanup yields before the hosted deadline and rejects malformed paths',async()=>{
 let now=0,claims=0,finished=0;
 const id='11111111-1111-4111-8111-111111111111';
 const job=runtime(async(url)=>{
  now+=8000;
  if(url.endsWith('/review_cleanup_claim')){claims++;return Response.json({owner:id,id,cleanup_token:id,artifact_tokens:[]});}
  if(url.endsWith('/review_cleanup_finish'))finished++;
  if(url.endsWith('/review_orphan_paths'))return Response.json([`${id}/${id}/source.xlsx`]);
  return Response.json([]);
 },true,()=>now);
 const result=await job.handler(new Request('https://local',{method:'POST',headers:{'x-review-cleanup-secret':job.env.REVIEW_CLEANUP_SECRET}}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{removed:3,deferred:1});
 assert.equal(claims,finished);assert.ok(now<=90000);
 let deleted=false;
 const bad=runtime(async(url)=>{
  if(url.endsWith('/review_cleanup_claim'))return Response.json(null);
  if(url.endsWith('/review_orphan_paths'))return Response.json(['../../other-bucket/source.xlsx']);
  deleted=true;return Response.json([]);
 });
 const invalid=await bad.handler(new Request('https://local',{method:'POST',headers:{'x-review-cleanup-secret':bad.env.REVIEW_CLEANUP_SECRET}}));
 assert.equal(invalid.status,503);assert.equal(deleted,false);
});

test('private review cleanup removes only validated reserved/orphan paths and fences completion',async()=>{
 const owner='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',token='33333333-3333-4333-8333-333333333333';
 let claims=0;const deleted=[],completed=[];
 const job=runtime(async(url,init)=>{
  assert.ok(url.startsWith('https://example.supabase.co/'));
  assert.equal(init.headers.apikey,'sb_secret_test_only');assert.equal(init.headers.Authorization,undefined);
  if(url.endsWith('/review_cleanup_claim'))return Response.json(claims++===0?{owner,id,cleanup_token:token,artifact_tokens:[token]}:null);
  if(url.endsWith('/review_orphan_paths'))return Response.json([`${owner}/${token}/source.xlsx`]);
  if(url.endsWith('/review_cleanup_finish')){completed.push(JSON.parse(init.body));return Response.json(null);}
  assert.ok(url.endsWith('/storage/v1/object/gst-review-workbooks'));assert.equal(init.method,'DELETE');deleted.push(JSON.parse(init.body).prefixes);return Response.json([]);
 });
 const result=await job.handler(new Request('https://local',{method:'POST',headers:{'x-review-cleanup-secret':job.env.REVIEW_CLEANUP_SECRET}}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{removed:1,deferred:0});
 assert.deepEqual(deleted,[[`${owner}/${id}/source.xlsx`,`${owner}/${id}/${token}/output.xlsx`,`${owner}/${id}/${token}/report.csv`],[`${owner}/${token}/source.xlsx`]]);
 assert.deepEqual(completed,[{p_id:id,p_token:token}]);
});

test('private review cleanup retains its durable reservation when object deletion fails',async()=>{
 let finished=false;
 const uuid='11111111-1111-4111-8111-111111111111';
 const job=runtime(async(url)=>{
  if(url.endsWith('/review_cleanup_claim'))return Response.json({owner:uuid,id:uuid,cleanup_token:uuid,artifact_tokens:[]});
  if(url.endsWith('/review_cleanup_finish'))finished=true;
  return Response.json({error:'provider unavailable'}, {status:503});
 });
 const result=await job.handler(new Request('https://local',{method:'POST',headers:{'x-review-cleanup-secret':job.env.REVIEW_CLEANUP_SECRET}}));
 assert.equal(result.status,503);assert.equal(finished,false);assert.deepEqual(await result.json(),{removed:0,deferred:1});
});
