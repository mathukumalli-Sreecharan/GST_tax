const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

test('admin-only upgrade preserves failures; verification, retry, leases and duplicate protection',async()=>{
 const db=new PGlite();
 const id='11111111-1111-4111-8111-111111111111';
 const q=async(sql,p=[])=>(await db.query(sql,p)).rows;
 const claim=async()=>(await q("select public.claim_approval_notification('owner@gmail.com','GST Ledger Studio <onboarding@resend.dev>','https://gst.example.com/admin/approvals') item"))[0].item;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());
   create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  for(const name of ['001_profiles.sql','002_user_approvals.sql','004_notification_registration_time.sql'])
   await db.exec(fs.readFileSync('../supabase/migrations/'+name,'utf8'));
  await db.exec(`insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name,state,attempts,last_error,payload)
   values('old-decision','approved','applicant@example.com','Applicant','failed',3,'Email provider HTTP 403','{"to":["applicant@example.com"]}');`);
  const before=await q('select * from public.approval_notifications');
  await db.exec(fs.readFileSync('../supabase/migrations/005_admin_request_notifications.sql','utf8'));
  assert.deepEqual(await q('select * from public.approval_notifications'),before);
  assert.equal(await claim(),null); // Applicant decision does not consume a lease or attempt.
  await q("insert into auth.users(id,email,raw_user_meta_data,created_at) values($1,'applicant@example.com','{\"full_name\":\"Applicant Name\"}','2026-10-24 10:00:00Z')",[id]);
  assert.equal(await claim(),null);
  await q('update auth.users set email_confirmed_at=now() where id=$1',[id]);
  await q('update auth.users set email_confirmed_at=now() where id=$1',[id]);
  assert.equal((await q("select count(*)::int n from public.approval_notifications where kind='request'"))[0].n,1);
  await db.exec('set role service_role');
  const first=await claim();
  assert.deepEqual(first.payload.to,['owner@gmail.com']);
  assert.equal(first.payload.from,'GST Ledger Studio <onboarding@resend.dev>');
  for(const text of ['Applicant Name','applicant@example.com','2026-10-24 10:00:00 UTC','https://gst.example.com/admin/approvals'])assert.ok(first.payload.text.includes(text));
  assert.equal(await claim(),null);
  await q("select public.finish_approval_notification($1,$2,null,'Email provider HTTP 403')",[first.id,first.lease_token]);
  assert.equal(await claim(),null); // Backoff is enforced.
  await db.exec('reset role');
  await q("update public.approval_notifications set next_attempt_at=now()-interval '1 minute' where id=$1",[first.id]);
  await db.exec('set role service_role');
  const retry=await claim();
  assert.equal(retry.id,first.id);assert.deepEqual(retry.payload,first.payload);
  assert.notEqual(retry.lease_token,first.lease_token);
  await q("select public.finish_approval_notification($1,$2,'stale',null)",[first.id,first.lease_token]);
  await q("select public.finish_approval_notification($1,$2,'accepted',null)",[retry.id,retry.lease_token]);
  assert.equal(await claim(),null);
  await db.exec('reset role');
  assert.equal((await q('select state from public.approval_notifications where id=$1',[first.id]))[0].state,'sent');
  assert.deepEqual(await q("select * from public.approval_notifications where event_key='old-decision'"),before);
  await q("update public.approval_notifications set state='failed',first_attempt_at=now()-interval '25 hours',next_attempt_at=now()-interval '1 minute' where id=$1",[first.id]);
  assert.equal(await claim(),null);
  assert.equal((await q('select state from public.approval_notifications where id=$1',[first.id]))[0].state,'needs_review');
 }finally{await db.close();}
});
