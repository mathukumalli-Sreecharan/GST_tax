const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

// Actual PostgreSQL engine; only Supabase's auth schema/roles are emulated.
test('approval migration, RLS, owner authorization, audit and durable outbox',async t=>{
 const db=new PGlite();
 const owner='11111111-1111-4111-8111-111111111111';
 const existing='22222222-2222-4222-8222-222222222222';
 const applicant='33333333-3333-4333-8333-333333333333';
 const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
 const asRole=async role=>{await db.exec(`reset role; set role ${role}`);};
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
   create schema auth; grant usage on schema auth to authenticated;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  await query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.com',now()),($2,'existing@example.com',now())",[owner,existing]);
  for(const file of ['001_profiles.sql','002_user_approvals.sql'])await db.exec(fs.readFileSync(`../supabase/migrations/${file}`,'utf8'));

  await t.test('existing users default pending; explicit verified owner bootstrap is required',async()=>{
   assert.equal((await query("select count(*)::int n from public.user_approvals where status='pending'"))[0].n,2);
   let [context]=await query('select public.approval_context($1,$1) state',[owner]);
   assert.equal(context.state.ready,false);
   await asRole('service_role');
   await query('select public.initialize_approval_owner($1)',[owner]);
   await query('select public.initialize_approval_owner($1)',[owner]);
   [context]=await query('select public.approval_context($1,$1) state',[owner]);
   assert.equal(context.state.ready,true);
   assert.equal(context.state.status,'approved');
   assert.equal(context.state.is_admin,true);
   await assert.rejects(query('select public.initialize_approval_owner($1)',[existing]),/already configured/);
   await asRole('postgres');
   assert.equal((await query('select count(*)::int n from public.approval_audit'))[0].n,1);
  });
  await t.test('registration persists pending before verification; verified email queues exactly once',async()=>{
   await query("insert into auth.users(id,email,raw_user_meta_data) values($1,'applicant@example.com','{\"full_name\":\"Applicant\",\"role\":\"admin\",\"approval_status\":\"approved\"}')",[applicant]);
   let [row]=await query('select * from public.user_approvals where user_id=$1',[applicant]);
   assert.equal(row.status,'pending');assert.equal(row.verified_email,null);
   assert.equal((await query("select count(*)::int n from public.approval_notifications where event_key=$1",['request:'+applicant]))[0].n,0);
   await query('update auth.users set email_confirmed_at=now() where id=$1',[applicant]);
   await query("update auth.users set raw_user_meta_data='{\"full_name\":\"Updated name\",\"role\":\"admin\"}' where id=$1",[applicant]);
   [row]=await query('select * from public.user_approvals where user_id=$1',[applicant]);
   assert.equal(row.status,'pending');assert.equal(row.verified_email,'applicant@example.com');
   assert.equal((await query("select count(*)::int n from public.approval_notifications where event_key=$1",['request:'+applicant]))[0].n,1);
  });
  await t.test('ordinary users can read only their own status and cannot mutate approvals or call privileged RPCs',async()=>{
   await asRole('authenticated');
   await query("select set_config('request.jwt.claim.sub',$1,false)",[applicant]);
   const rows=await query('select * from public.user_approvals');
   assert.equal(rows.length,1);assert.equal(rows[0].user_id,applicant);
   await assert.rejects(query("update public.user_approvals set status='approved' where user_id=$1",[applicant]),/permission denied/);
   await assert.rejects(query('select * from public.approval_audit'),/permission denied/);
   await assert.rejects(query('select * from public.approval_notifications'),/permission denied/);
   await assert.rejects(query('select public.initialize_approval_owner($1)',[applicant]),/permission denied/);
   await assert.rejects(query("select public.change_approval($1,$1,$2,'approved','pending')",[owner,applicant]),/permission denied/);
   await asRole('anon');
   await assert.rejects(query('select * from public.user_approvals'),/permission denied/);
   await asRole('service_role');
   await assert.rejects(query('select public.admin_approval_list($1,$2,null,0)',[applicant,owner]),/Owner access required/);
  });
  await t.test('unverified accounts cannot be approved; decision/outbox/audit writes roll back together',async()=>{
   const unverified='44444444-4444-4444-8444-444444444444';
   await asRole('postgres');
   await query("insert into auth.users(id,email) values($1,'unverified@example.com')",[unverified]);
   await asRole('service_role');
   await assert.rejects(query("select public.change_approval($1,$1,$2,'approved','pending')",[owner,unverified]),/Email verification required/);
   await asRole('postgres');
   await query('delete from auth.users where id=$1',[unverified]);
   await db.exec(`create function public.simulate_outbox_failure() returns trigger language plpgsql as $$begin raise exception 'simulated storage failure'; end;$$;
    create trigger fail_outbox before insert on public.approval_notifications for each row execute function public.simulate_outbox_failure();`);
   await asRole('service_role');
   await assert.rejects(query("select public.change_approval($1,$1,$2,'approved','pending')",[owner,applicant]),/simulated storage failure/);
   await asRole('postgres');
   await db.exec('drop trigger fail_outbox on public.approval_notifications; drop function public.simulate_outbox_failure()');
   assert.equal((await query('select status from public.user_approvals where user_id=$1',[applicant]))[0].status,'pending');
   assert.equal((await query('select count(*)::int n from public.approval_audit'))[0].n,1);
   await asRole('service_role');
  });
  await t.test('owner decisions are transactional, audited, concurrency checked and cannot revoke owner',async()=>{
   await query("select public.change_approval($1,$1,$2,'approved','pending')",[owner,applicant]);
   await assert.rejects(query("select public.change_approval($1,$1,$2,'approved','pending')",[owner,applicant]),/refresh and try again/);
   await query("select public.change_approval($1,$1,$2,'revoked','approved')",[owner,applicant]);
   await query("select public.change_approval($1,$1,$2,'rejected','pending')",[owner,existing]);
   await assert.rejects(query("select public.change_approval($1,$1,$1,'revoked','approved')",[owner]),/Owner approval cannot/);
   const [dashboard]=await query('select public.admin_approval_list($1,$1,null,0) data',[owner]);
   assert.deepEqual(dashboard.data.counts,{total:3,pending:0,approved:1,rejected:1,revoked:1});
   await asRole('postgres');
   const audit=await query('select * from public.approval_audit order by action_at');
   assert.equal(audit.length,4);assert.ok(audit.every(row=>row.actor_id===owner && row.action_at));
   const notifications=await query("select * from public.approval_notifications where kind <> 'request'");
   assert.equal(notifications.length,3);
  });
  await t.test('lease fencing, immutable payload, retries and deduplication retention limit',async()=>{
   await db.exec('delete from public.approval_notifications');
   await db.exec("insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name) values('test','request','applicant@example.com','Applicant')");
   await asRole('service_role');
   const claim=async()=>{const [r]=await query("select public.claim_approval_notification('owner@example.com','sender@example.com','https://gst.example.com/admin/approvals') item");return r.item;};
   const first=await claim();assert.equal(first.attempts,1);
   assert.ok(first.payload.text.includes('applicant@example.com'));assert.ok(first.payload.text.includes('/admin/approvals'));
   assert.equal(await claim(),null);
   await query('select public.finish_approval_notification($1,$2,null,$3)',[first.id,first.lease_token,'Timeout']);
   await asRole('postgres');
   await db.exec("update public.approval_notifications set next_attempt_at=now()-interval '1 minute'");
   await asRole('service_role');
   const [r]=await query("select public.claim_approval_notification('changed@example.com','changed-sender@example.com','https://changed.example.com/admin/approvals') item");
   const second=r.item;assert.deepEqual(second.payload,first.payload);assert.notEqual(second.lease_token,first.lease_token);
   await query("select public.finish_approval_notification($1,$2,'stale-provider',null)",[first.id,first.lease_token]);
   await asRole('postgres');
   assert.equal((await query('select state from public.approval_notifications'))[0].state,'sending');
   await asRole('service_role');
   await query("select public.finish_approval_notification($1,$2,'provider-1',null)",[second.id,second.lease_token]);
   assert.equal(await claim(),null);
   await asRole('postgres');
   await db.exec("update public.approval_notifications set state='failed',first_attempt_at=now()-interval '25 hours',next_attempt_at=now()-interval '1 hour'");
   await asRole('service_role');
   assert.equal(await claim(),null);
   await asRole('postgres');
   assert.equal((await query('select state from public.approval_notifications'))[0].state,'needs_review');
  });
 } finally {await db.close();}
});
