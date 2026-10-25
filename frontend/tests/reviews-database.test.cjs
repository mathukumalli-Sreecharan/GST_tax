const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

test('durable reviews: additive migration, private objects, versions, leases, expiry and cleanup',async t=>{
 const db=new PGlite();
 const owner='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',token='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token2='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const q=async(sql,p=[])=>(await db.query(sql,p)).rows;
 const role=async r=>db.exec(`reset role;set role ${r}`);
 const get=async(who=user)=>(await q('select public.review_get($1,$2) item',[id,who]))[0].item;
 const change=async(item,patch,who=user)=>(await q('select public.review_change($1,$2,$3,$4,$5,$6) item',[item.id,who,item.version,item.state,item.lease_token,JSON.stringify({state:item.state,lease_token:item.lease_token,decisions:item.decisions,result:item.result,...patch})]))[0].item;
 let item;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create schema storage;grant usage on schema storage to anon,authenticated;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,created_at timestamptz default now());
   alter table storage.objects enable row level security;
   grant select,insert,update,delete on storage.objects to anon,authenticated;
   create policy "existing broad policy" on storage.objects for all to authenticated using(true) with check(true);`);
  for(const name of ['001_profiles.sql','002_user_approvals.sql','003_generated_files.sql','004_notification_registration_time.sql','005_admin_request_notifications.sql','006_email_approval_actions.sql'])await db.exec(fs.readFileSync('../supabase/migrations/'+name,'utf8'));
  await q("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'user@example.com',now()),($3,'other@example.com',now())",[owner,user,other]);
  await q('select public.initialize_approval_owner($1)',[owner]);
  for(const who of [user,other])await q("select public.change_approval($1,$1,$2,'approved','pending')",[owner,who]);
  const approvals=await q('select * from public.user_approvals order by user_id');
  const notifications=await q('select * from public.approval_notifications order by id');
  await db.exec(fs.readFileSync('../supabase/migrations/007_durable_excel_reviews.sql','utf8'));
  await t.test('upgrade preserves approvals, owner and frozen notification records',async()=>{
   assert.deepEqual(await q('select * from public.user_approvals order by user_id'),approvals);
   assert.deepEqual(await q('select * from public.approval_notifications order by id'),notifications);
   assert.equal((await q("select public from storage.buckets where id='gst-review-workbooks'"))[0].public,false);
  });
  await t.test('every review definer has an empty search path and service-only execute grants',async()=>{
   const functions=await q("select p.oid::regprocedure::text signature,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'review_%'");
   assert.equal(functions.length,8);
   for(const fn of functions){
    assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.includes('search_path=""'));
    for(const browser of ['anon','authenticated'])assert.equal((await q('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[browser,fn.signature]))[0].allowed,false);
    assert.equal((await q("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[fn.signature]))[0].allowed,true);
   }
  });
  await role('service_role');
  item=(await q('select public.review_reserve($1,$2,$3,1000,$4,$5,$6) item',[id,user,'synthetic.xlsx','a'.repeat(64),'{}','{"rows":[]}']))[0].item;
  await t.test('reserved uploads are invisible and browser access is denied despite broad policies',async()=>{
   await assert.rejects(get(),/Review not found/);
   await role('postgres');await db.exec("insert into storage.objects(bucket_id,name) values('gst-review-workbooks','original.xlsx'),('other-bucket','other.txt')");
   for(const browser of ['anon','authenticated']){
    await role(browser);
    assert.deepEqual((await q('select bucket_id from storage.objects')).map(v=>v.bucket_id),browser==='authenticated'?['other-bucket']:[]);
    await assert.rejects(q('select * from public.excel_reviews'),/permission denied/);
    await assert.rejects(q("update public.excel_reviews set state='generated'"),/permission denied/);
    await assert.rejects(q('delete from public.excel_reviews'),/permission denied/);
    await assert.rejects(q('select public.review_get($1,$2)',[id,user]),/permission denied/);
    await assert.rejects(q("insert into storage.objects(bucket_id,name) values('gst-review-workbooks','bypass.xlsx')"),/row-level security/);
    assert.deepEqual(await q("update storage.objects set name='tampered' where bucket_id='gst-review-workbooks' returning name"),[]);
    assert.deepEqual(await q("delete from storage.objects where bucket_id='gst-review-workbooks' returning name"),[]);
   }
   await role('service_role');
   item=(await q('select public.review_activate($1,$2) item',[id,user]))[0].item;
  });
  await t.test('ownership, immutable source and optimistic versions',async()=>{
   await assert.rejects(get(other),/Review not found/);
   const stale=item;
   item=await change(item,{decisions:{7:{choice:'WRONG',rates:['18','12']}},source_hash:'b'.repeat(64),owner:other,options:{tampered:true}});
   assert.equal(item.source_hash,'a'.repeat(64));assert.equal(item.owner,user);assert.deepEqual(item.options,{});
   await assert.rejects(change(stale,{decisions:{}}),/Review changed/);
  });
  await t.test('null comparison fields cannot bypass version/state fencing and options are bounded',async()=>{
   for(const [version,state,patch] of [[null,'open',{state:'open',decisions:{}}],[item.version,null,{state:'generated',decisions:{}}],[item.version,'open',{state:'open'}]]){
    await assert.rejects(q('select public.review_change($1,$2,$3,$4,$5,$6)',[id,user,version,state,null,JSON.stringify(patch)]),/Invalid review mutation/);
   }
   await assert.rejects(q("select public.review_reserve('eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'test.xlsx',1,$2,$3,'{}')",[user,'a'.repeat(64),JSON.stringify({oversized:'x'.repeat(65536)})]),/check constraint/);
   assert.equal((await get()).version,item.version);
  });
  await t.test('generation freezes decisions and rejects deletion or a second claim',async()=>{
   const stale=item;item=await change(item,{state:'generating',lease_token:token});
   assert.ok(item.lease_until>item.created);assert.deepEqual(item.artifact_tokens,[token]);
   await assert.rejects(change(stale,{state:'deleted'}),/Review changed/);
   await assert.rejects(change(item,{state:'deleted'}),/Unsafe review transition/);
   await assert.rejects(change(item,{state:'open',decisions:{}}),/snapshot is immutable/);
   await assert.rejects(change(item,{state:'generating',lease_token:token2}),/Unsafe review transition/);
   await assert.rejects(change(item,{state:'generated',result:{durable_artifact:{token:token2}}}),/artifact is not fenced/);
  });
  await t.test('explicit recovery fences a stale worker and reserves new immutable paths',async()=>{
   const stale=item;
   await role('postgres');await q('update public.excel_reviews set lease_until=0 where id=$1',[id]);await role('service_role');
   item=await get();item=await change(item,{state:'open',lease_token:null});
   await assert.rejects(change(stale,{state:'generated',result:{durable_artifact:{token}}}),/Review changed/);
   await assert.rejects(change(item,{state:'generating',lease_token:token}),/token reused/);
   item=await change(item,{state:'generating',lease_token:token2});
   assert.deepEqual(item.artifact_tokens,[token,token2]);
   item=await change(item,{state:'generated',result:{file_id:id,durable_artifact:{token:token2,output_bytes:1000,report_bytes:200}}});
   assert.equal((await get()).result.file_id,id);
  });
  await t.test('revocation and expiration deny existing reviews before physical cleanup',async()=>{
   await q("select public.change_approval($1,$1,$2,'revoked','approved')",[owner,user]);
   await assert.rejects(get(),/Approved verified account required/);
   await q("select public.change_approval($1,$1,$2,'approved','revoked')",[owner,user]);
   await role('postgres');await q('update public.excel_reviews set expires=0,lease_until=0 where id=$1',[id]);await role('service_role');
   await assert.rejects(get(),/Review not found/);
   assert.deepEqual((await q('select public.review_list($1) items',[user]))[0].items,[]);
  });
  await t.test('cleanup tombstones survive lost leases and stale completion cannot delete a new claim',async()=>{
   const first=(await q('select public.review_cleanup_claim() item'))[0].item;
   assert.deepEqual(first.artifact_tokens,[token,token2]);
   assert.equal((await q('select public.review_cleanup_claim() item'))[0].item,null);
   await role('postgres');await q('update public.excel_reviews set cleanup_until=0 where id=$1',[id]);await role('service_role');
   const second=(await q('select public.review_cleanup_claim() item'))[0].item;
   await q('select public.review_cleanup_finish($1,$2)',[id,first.cleanup_token]);
   await role('postgres');assert.equal((await q('select count(*)::int n from public.excel_reviews'))[0].n,1);await role('service_role');
   await q('select public.review_cleanup_finish($1,$2)',[id,second.cleanup_token]);
   await role('postgres');assert.equal((await q('select count(*)::int n from public.excel_reviews'))[0].n,0);
  });
  await t.test('orphan reconciliation finds only old unreserved review paths',async()=>{
   const oldPath=`${user}/${id}/source.xlsx`;
   await q("insert into storage.objects(bucket_id,name,created_at) values('gst-review-workbooks',$1,now()-interval '2 hours'),('other-bucket',$1,now()-interval '2 hours'),('gst-review-workbooks','unrelated.txt',now()-interval '2 hours')",[oldPath]);
   await role('service_role');
   assert.deepEqual((await q('select public.review_orphan_paths() paths'))[0].paths,[oldPath]);
  });
  await t.test('cleanup refuses active open reviews and unexpired generation leases',async()=>{
   const active='dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   await q("select public.review_reserve($1,$2,'test.xlsx',1000,$3,'{}','{}')",[active,other,'a'.repeat(64)]);
   const open=(await q('select public.review_activate($1,$2) item',[active,other]))[0].item;
   assert.equal((await q('select public.review_cleanup_claim() item'))[0].item,null);
   await change(open,{state:'generating',lease_token:token},other);
   await role('postgres');await q('update public.excel_reviews set expires=0 where id=$1',[active]);await role('service_role');
   assert.equal((await q('select public.review_cleanup_claim() item'))[0].item,null);
   await role('postgres');await q('update public.excel_reviews set lease_until=0 where id=$1',[active]);await role('service_role');
   const expired=(await q('select public.review_cleanup_claim() item'))[0].item;
   assert.equal(expired.id,active);await q('select public.review_cleanup_finish($1,$2)',[active,expired.cleanup_token]);
  });
  await t.test('tenant session and global artifact reservations are bounded',async()=>{
   const reserved=[];
   for(let i=0;i<5;i++){
    const rid=`0000000${i}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    await q("select public.review_reserve($1,$2,'test.xlsx',1000,$3,'{}','{}')",[rid,user,'a'.repeat(64)]);
    const record=(await q('select public.review_activate($1,$2) item',[rid,user]))[0].item;
    const patch={state:'generating',lease_token:token,decisions:{},result:null};
    const generated=(await q('select public.review_change($1,$2,$3,$4,$5,$6) item',[rid,user,record.version,'open',null,JSON.stringify(patch)]))[0].item;
    reserved.push(generated);
   }
   await assert.rejects(q("select public.review_reserve('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'test.xlsx',1000,$2,'{}','{}')",[user,'a'.repeat(64)]),/quota reached/);
   const record=reserved[0];
   const opened=(await q('select public.review_change($1,$2,$3,$4,$5,$6) item',[record.id,user,record.version,'generating',token,JSON.stringify({state:'open',lease_token:null,decisions:{},result:null})]))[0].item;
   await assert.rejects(q('select public.review_change($1,$2,$3,$4,$5,$6)',[record.id,user,opened.version,'open',null,JSON.stringify({state:'generating',lease_token:token2,decisions:{},result:null})]),/artifact quota reached/);
  });
 }finally{await db.close();}
});
