-- Run after 001_profiles.sql. Application access stays closed until owner setup.
begin;
create table public.approval_owner (
 singleton boolean primary key default true check(singleton),
 user_id uuid not null unique references auth.users(id),
 configured_at timestamptz not null default now()
);
create table public.user_approvals (
 user_id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null default '', verified_email text,
 registered_at timestamptz not null,
 status text not null default 'pending' check(status in ('pending','approved','rejected','revoked')),
 updated_at timestamptz not null default now(),
 decided_by uuid references auth.users(id) on delete set null,
 decided_at timestamptz
);
create index approvals_status_date on public.user_approvals(status, registered_at desc);
create table public.approval_audit (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null, actor_id uuid not null,
 previous_status text not null, new_status text not null,
 action_at timestamptz not null default now()
);
create table public.approval_notifications (
 id uuid primary key default gen_random_uuid(),
 event_key text not null unique,
 kind text not null check(kind in ('request','approved','rejected','revoked')),
 applicant_email text not null, applicant_name text not null,
 state text not null default 'pending' check(state in ('pending','sending','sent','failed','needs_review')),
 payload jsonb, attempts integer not null default 0,
 created_at timestamptz not null default now(), first_attempt_at timestamptz,
 next_attempt_at timestamptz not null default now(), lease_until timestamptz,
 lease_token uuid, sent_at timestamptz, provider_id text, last_error text
);
create index notifications_due on public.approval_notifications(next_attempt_at) where state in ('pending','sending','failed');

alter table public.approval_owner enable row level security;
alter table public.user_approvals enable row level security;
alter table public.approval_audit enable row level security;
alter table public.approval_notifications enable row level security;
revoke all on public.approval_owner, public.user_approvals, public.approval_audit, public.approval_notifications from public, anon, authenticated;
grant select on public.user_approvals to authenticated;
create policy "Read own approval only" on public.user_approvals for select to authenticated
 using ((select auth.uid()) = user_id);
-- Backend uses narrowly scoped service-only RPCs; clients cannot call these.

create function public.sync_approval_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.user_approvals(user_id,full_name,verified_email,registered_at)
 values(new.id,left(coalesce(new.raw_user_meta_data->>'full_name',''),120),
 case when new.email_confirmed_at is not null then new.email end,new.created_at)
 on conflict(user_id) do update set
 full_name=excluded.full_name, verified_email=excluded.verified_email;
 if new.email_confirmed_at is not null and new.email is not null then
   insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name)
   values('request:'||new.id::text,'request',new.email,left(coalesce(new.raw_user_meta_data->>'full_name',''),120))
   on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;
create trigger approval_user_insert after insert on auth.users for each row execute function public.sync_approval_user();
create trigger approval_user_update after update of email_confirmed_at,email,raw_user_meta_data on auth.users for each row execute function public.sync_approval_user();

insert into public.user_approvals(user_id,full_name,verified_email,registered_at)
select id,left(coalesce(raw_user_meta_data->>'full_name',''),120),case when email_confirmed_at is not null then email end,created_at from auth.users;
insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name)
select 'request:'||user_id::text,'request',verified_email,full_name from public.user_approvals where verified_email is not null;

create function public.initialize_approval_owner(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare prior text;
begin
 -- Explicit setup operation only. Never automatically choose the first signup.
 perform pg_advisory_xact_lock(52417830);
 if not exists(select 1 from auth.users where id=p_owner and email_confirmed_at is not null and email is not null) then
  raise exception 'Owner must be an existing email-verified Auth user';
 end if;
 if exists(select 1 from public.approval_owner where user_id<>p_owner) then
  raise exception 'Owner already configured; explicit database migration required to change owner';
 end if;
 insert into public.approval_owner(user_id) values(p_owner) on conflict do nothing;
 select status into prior from public.user_approvals where user_id=p_owner for update;
 if prior <> 'approved' then
  update public.user_approvals set status='approved',decided_by=p_owner,decided_at=now(),updated_at=now() where user_id=p_owner;
  insert into public.approval_audit(user_id,actor_id,previous_status,new_status) values(p_owner,p_owner,prior,'approved');
 end if;
end; $$;

create function public.approval_context(p_user uuid,p_owner uuid) returns jsonb
language sql security definer set search_path = '' as $$
 select jsonb_build_object(
 'ready',exists(select 1 from public.approval_owner o join public.user_approvals a on a.user_id=o.user_id where o.user_id=p_owner and a.status='approved' and a.verified_email is not null),
 'status',coalesce((select status from public.user_approvals where user_id=p_user),'pending'),
 'email_verified',exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null and email is not null),
 'is_admin',p_user=p_owner and exists(select 1 from public.approval_owner where user_id=p_owner))
$$;

create function public.admin_approval_list(p_actor uuid,p_owner uuid,p_status text default null,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if p_actor<>p_owner or not exists(select 1 from public.approval_owner o join public.user_approvals a on a.user_id=o.user_id where o.user_id=p_actor and a.status='approved' and a.verified_email is not null) then
  raise exception using errcode='42501',message='Owner access required';
 end if;
 return jsonb_build_object(
 'counts',(select jsonb_build_object('total',count(*),'pending',count(*) filter(where status='pending'),'approved',count(*) filter(where status='approved'),'rejected',count(*) filter(where status='rejected'),'revoked',count(*) filter(where status='revoked')) from public.user_approvals),
 'filtered_total',(select count(*) from public.user_approvals where p_status is null or status=p_status),
 'users',coalesce((select jsonb_agg(to_jsonb(a)) from (select *,user_id=p_owner as is_owner from public.user_approvals where p_status is null or status=p_status order by registered_at desc,user_id limit 50 offset greatest(p_offset,0)) a),'[]'::jsonb),
 'notifications',(select jsonb_build_object('pending',count(*) filter(where state in ('pending','sending','failed')),'needs_review',count(*) filter(where state='needs_review')) from public.approval_notifications));
end; $$;

create function public.change_approval(p_actor uuid,p_owner uuid,p_user uuid,p_status text,p_expected text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare prior text; applicant public.user_approvals; event_id uuid;
begin
 if p_actor<>p_owner or not exists(select 1 from public.approval_owner o join public.user_approvals a on a.user_id=o.user_id where o.user_id=p_actor and a.status='approved' and a.verified_email is not null) then
  raise exception using errcode='42501',message='Owner access required';
 end if;
 if p_user=p_owner then raise exception 'Owner approval cannot be changed here'; end if;
 select * into applicant from public.user_approvals where user_id=p_user for update;
 if not found then raise exception using errcode='P0002',message='Applicant not found'; end if;
 prior=applicant.status;
 if prior<>p_expected then raise exception using errcode='40001',message='Approval changed; refresh and try again'; end if;
 if not ((p_status='approved' and prior in ('pending','rejected','revoked')) or (p_status='rejected' and prior='pending') or (p_status='revoked' and prior='approved')) then
  raise exception 'Invalid approval transition';
 end if;
 if p_status='approved' and applicant.verified_email is null then raise exception 'Email verification required before approval'; end if;
 update public.user_approvals set status=p_status,decided_by=p_actor,decided_at=now(),updated_at=now() where user_id=p_user;
 insert into public.approval_audit(user_id,actor_id,previous_status,new_status) values(p_user,p_actor,prior,p_status) returning id into event_id;
 if applicant.verified_email is not null then
  insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name)
  values('decision:'||event_id::text,p_status,applicant.verified_email,applicant.full_name);
 end if;
 return jsonb_build_object('user_id',p_user,'status',p_status);
end; $$;

create function public.claim_approval_notification(p_admin_email text,p_sender text,p_admin_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare item public.approval_notifications; token uuid;
begin
 -- Provider deduplication expires after 24 hours. Do not resend ambiguous old sends.
 update public.approval_notifications set state='needs_review',lease_token=null,lease_until=null
 where state in ('failed','sending') and (first_attempt_at < now()-interval '23 hours' or attempts>=8)
 and (lease_until is null or lease_until < now());
 select * into item from public.approval_notifications
 where ((state in ('pending','failed') and next_attempt_at<=now()) or (state='sending' and lease_until<now()))
 and attempts<8 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 token=gen_random_uuid();
 update public.approval_notifications set state='sending',lease_token=token,lease_until=now()+interval '2 minutes',
 attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),
 payload=coalesce(payload,jsonb_build_object(
 'from',p_sender,'to',jsonb_build_array(case when kind='request' then p_admin_email else applicant_email end),
 'subject',case when kind='request' then 'GST Ledger Studio: approval requested' else 'GST Ledger Studio: account '||kind end,
 'text',case when kind='request' then 'A verified account requests access.'||chr(10)||'Name: '||applicant_name||chr(10)||'Verified email: '||applicant_email||chr(10)||'Review: '||p_admin_url
 else 'Hello '||applicant_name||','||chr(10)||'Your GST Ledger Studio account access is '||kind||'.' end))
 where id=item.id returning * into item;
 return to_jsonb(item);
end; $$;

create function public.finish_approval_notification(p_id uuid,p_lease uuid,p_provider_id text,p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 update public.approval_notifications set
 state=case when p_error is null then 'sent' when attempts>=8 then 'needs_review' else 'failed' end,
 sent_at=case when p_error is null then now() else null end,provider_id=p_provider_id,
 last_error=left(p_error,200),lease_token=null,lease_until=null,
 next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer))
 where id=p_id and lease_token=p_lease and state='sending';
end; $$;

-- Revoke default EXECUTE privileges, including implicit PUBLIC grants.
revoke all on function public.sync_approval_user() from public,anon,authenticated;
revoke all on function public.initialize_approval_owner(uuid),public.approval_context(uuid,uuid),
 public.admin_approval_list(uuid,uuid,text,integer),public.change_approval(uuid,uuid,uuid,text,text),
 public.claim_approval_notification(text,text,text),public.finish_approval_notification(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.initialize_approval_owner(uuid),public.approval_context(uuid,uuid),
 public.admin_approval_list(uuid,uuid,text,integer),public.change_approval(uuid,uuid,uuid,text,text),
 public.claim_approval_notification(text,text,text),public.finish_approval_notification(uuid,uuid,text,text) to service_role;
commit;
