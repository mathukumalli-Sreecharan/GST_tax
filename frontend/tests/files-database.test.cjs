const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

test('private beta files: migration compatibility, RLS, ownership, retention, restart-safe cleanup and notification timestamp',async t=>{
 const db=new PGlite();
 const owner='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
 const file='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',file2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const q=async(sql,params=[])=>(await db.query(sql,params)).rows;
 const role=async name=>db.exec(`reset role;set role ${name}`);
 const reserve=async(id,who,name='report.xlsx')=>q("select public.reserve_generated_file($1,$2,$3,$4,2000,'{\"total\":4}',1) item",[id,who,name,'updated_'+name]);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;grant usage on schema auth to authenticated;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create schema storage;grant usage on schema storage to anon,authenticated;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
   alter table storage.objects enable row level security;
   grant select,insert,update,delete on storage.objects to anon,authenticated;
   create policy "old broad storage policy" on storage.objects for all to authenticated using(true) with check(true);`);
  await q("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'user@example.com',now()),($3,'other@example.com',now())",[owner,user,other]);
  for(const migration of ['001_profiles.sql','002_user_approvals.sql'])await db.exec(fs.readFileSync('../supabase/migrations/'+migration,'utf8'));
  await q('select public.initialize_approval_owner($1)',[owner]);
  await q("select public.change_approval($1,$1,$2,'approved','pending')",[owner,user]);
  const priorAudit=(await q('select count(*)::int n from public.approval_audit'))[0].n;
  for(const migration of ['003_generated_files.sql','004_notification_registration_time.sql'])await db.exec(fs.readFileSync('../supabase/migrations/'+migration,'utf8'));
  await t.test('additive upgrades retain approved owner and all audit records',async()=>{
   assert.equal((await q('select public.approval_context($1,$1) state',[owner]))[0].state.is_admin,true);
   assert.equal((await q('select count(*)::int n from public.approval_audit'))[0].n,priorAudit);
   assert.equal((await q('select public from storage.buckets where id=$1',['generated-excel-files']))[0].public,false);
  });
  await t.test('only approved accounts can reserve; uploads remain invisible until complete',async()=>{
   await role('service_role');
   await assert.rejects(reserve(file2,other),/Approved verified account required/);
   const [record]=await reserve(file,user);
   assert.equal(record.item.storage_path,`${user}/${file}.xlsx`);
   assert.equal((await q("select public.list_generated_files($1,'','newest',0) data",[user]))[0].data.total,0);
   await q('select public.complete_generated_file($1,$2)',[file,user]);
   const [listing]=await q("select public.list_generated_files($1,'REPORT','name',0) data",[user]);
   assert.equal(listing.data.total,1);assert.equal(listing.data.files[0].verification_count,1);
   assert.equal(listing.data.files[0].file_size,2000);
   const days=(Date.parse(listing.data.files[0].expires_at)-Date.parse(listing.data.files[0].created_at))/86400000;
   assert.equal(days,30);
  });
  await t.test('cross-user reads and deletes fail even when the other user becomes approved',async()=>{
   await q("select public.change_approval($1,$1,$2,'approved','pending')",[owner,other]);
   assert.equal((await q("select public.list_generated_files($1,'','newest',0) data",[other]))[0].data.total,0);
   await assert.rejects(q('select public.get_generated_file($1,$2)',[file,other]),/File not found/);
   await assert.rejects(q('select public.mark_generated_file_deleted($1,$2)',[file,other]),/File not found/);
   await role('authenticated');await q("select set_config('request.jwt.claim.sub',$1,false)",[user]);
   assert.equal((await q('select * from public.generated_files')).length,1);
   await assert.rejects(q('update public.generated_files set user_id=$1',[other]),/permission denied/);
   await assert.rejects(q('select public.get_generated_file($1,$2)',[file,other]),/permission denied/);
   await role('postgres');
   await db.exec("insert into storage.objects(bucket_id,name) values('generated-excel-files','private.xlsx'),('other-bucket','other.txt')");
   await role('authenticated');
   const objects=await q('select * from storage.objects');assert.equal(objects.length,1);assert.equal(objects[0].bucket_id,'other-bucket');
   await assert.rejects(q("insert into storage.objects(bucket_id,name) values('generated-excel-files','bypass.xlsx')"),/row-level security/);
   await role('service_role');
  });
  await t.test('revocation blocks existing downloads at database level and direct metadata reads',async()=>{
   await q("select public.change_approval($1,$1,$2,'revoked','approved')",[owner,user]);
   await assert.rejects(q('select public.get_generated_file($1,$2)',[file,user]),/Approved verified account required/);
   await role('authenticated');
   assert.equal((await q('select * from public.generated_files')).length,0);
   await role('service_role');
   await q("select public.change_approval($1,$1,$2,'approved','revoked')",[owner,user]);
  });
  await t.test('user deletion immediately blocks downloads and cleanup can resume after a lost lease',async()=>{
   const [deleted]=await q('select public.mark_generated_file_deleted($1,$2) item',[file,user]);
   await assert.rejects(q('select public.get_generated_file($1,$2)',[file,user]),/File not found/);
   assert.deepEqual((await q('select public.claim_expired_generated_files() items'))[0].items,[]);
   await role('postgres');await db.exec("update public.generated_files set cleanup_until=now()-interval '1 second'");await role('service_role');
   const [claimed]=await q('select public.claim_expired_generated_files() items');
   assert.equal(claimed.items.length,1);const lease=claimed.items[0];
   await q('select public.finish_generated_file_delete($1,$2)',[file,deleted.item.cleanup_token]);
   await role('postgres');assert.equal((await q('select count(*)::int n from public.generated_files'))[0].n,1);await role('service_role');
   await q('select public.finish_generated_file_delete($1,$2)',[file,lease.cleanup_token]);
   await role('postgres');assert.equal((await q('select count(*)::int n from public.generated_files'))[0].n,0);await role('service_role');
  });
  await t.test('30-day retention blocks expired ready files before physical cleanup',async()=>{
   await reserve(file,user);await q('select public.complete_generated_file($1,$2)',[file,user]);
   await role('postgres');await q("update public.generated_files set expires_at=now()-interval '1 second' where id=$1",[file]);await role('service_role');
   await assert.rejects(q('select public.get_generated_file($1,$2)',[file,user]),/File not found/);
   assert.equal((await q("select public.list_generated_files($1,'','newest',0) data",[user]))[0].data.total,0);
   const item=(await q('select public.claim_expired_generated_files() items'))[0].items[0];assert.equal(item.id,file);
   await q('select public.finish_generated_file_delete($1,$2)',[file,item.cleanup_token]);
  });
  await t.test('expired uploads, ambiguous saves and deleted accounts leave durable cleanup work',async()=>{
   await reserve(file,user);await q('select public.abandon_generated_file($1,$2)',[file,user]);
   assert.deepEqual((await q('select public.claim_expired_generated_files() items'))[0].items,[]);
   await role('postgres');await db.exec("update public.generated_files set cleanup_until=now()-interval '1 hour'");await role('service_role');
   const item=(await q('select public.claim_expired_generated_files() items'))[0].items[0];
   await q('select public.finish_generated_file_delete($1,$2)',[file,item.cleanup_token]);
   await reserve(file2,other);await q('select public.complete_generated_file($1,$2)',[file2,other]);
   await role('postgres');await q('delete from auth.users where id=$1',[other]);await role('service_role');
   assert.equal((await q('select public.claim_expired_generated_files() items'))[0].items[0].id,file2);
  });
  await t.test('verified signup email contains registration time and secure review URL',async()=>{
   await role('postgres');await db.exec('delete from public.approval_notifications');
   await q("insert into auth.users(id,email,raw_user_meta_data) values($1,'new@example.com','{\"full_name\":\"New Auditor\"}')",[other]);
   assert.equal((await q('select count(*)::int n from public.approval_notifications'))[0].n,0);
   await q('update auth.users set email_confirmed_at=now() where id=$1',[other]);await role('service_role');
   const item=(await q("select public.claim_approval_notification('owner@example.com','sender@example.com','https://gst.example.com/admin/approvals') item"))[0].item;
   assert.ok(item.payload.text.includes('Registered (UTC): '));assert.ok(!item.payload.text.includes('unavailable'));
   assert.ok(item.payload.text.includes('New Auditor'));assert.ok(item.payload.text.includes('new@example.com'));
   assert.ok(item.payload.text.includes('https://gst.example.com/admin/approvals'));
   await role('postgres');await q("update public.approval_notifications set lease_until=now()-interval '1 minute' where id=$1",[item.id]);await role('service_role');
   const replay=(await q("select public.claim_approval_notification('changed@example.com','different@example.com','https://changed.example.com/admin/approvals') item"))[0].item;
   assert.equal(replay.id,item.id);assert.notEqual(replay.lease_token,item.lease_token);assert.deepEqual(replay.payload,item.payload);
  });
 }finally{await db.close();}
});
