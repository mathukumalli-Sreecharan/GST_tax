-- Upgrade queued notifications without resetting owner, approvals, or sent emails.
begin;
alter table public.approval_notifications add column applicant_registered_at timestamptz;
update public.approval_notifications n set applicant_registered_at=a.registered_at
from public.user_approvals a where n.applicant_email=a.verified_email;

create or replace function public.sync_approval_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.user_approvals(user_id,full_name,verified_email,registered_at)
 values(new.id,left(coalesce(new.raw_user_meta_data->>'full_name',''),120),
 case when new.email_confirmed_at is not null then new.email end,new.created_at)
 on conflict(user_id) do update set full_name=excluded.full_name,verified_email=excluded.verified_email;
 if new.email_confirmed_at is not null and new.email is not null then
  insert into public.approval_notifications(event_key,kind,applicant_email,applicant_name,applicant_registered_at)
  values('request:'||new.id::text,'request',new.email,left(coalesce(new.raw_user_meta_data->>'full_name',''),120),new.created_at)
  on conflict(event_key) do nothing;
 end if;
 return new;
end; $$;

create or replace function public.claim_approval_notification(p_admin_email text,p_sender text,p_admin_url text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.approval_notifications; token uuid;
begin
 update public.approval_notifications set state='needs_review',lease_token=null,lease_until=null
 where state in ('failed','sending') and (first_attempt_at<now()-interval '23 hours' or attempts>=8)
 and (lease_until is null or lease_until<now());
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
 'text',case when kind='request' then 'A verified account requests access.'||chr(10)||'Name: '||applicant_name||chr(10)||'Verified email: '||applicant_email||chr(10)||
 'Registered (UTC): '||coalesce(to_char(applicant_registered_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS')||' UTC','unavailable')||chr(10)||'Review: '||p_admin_url
 else 'Hello '||applicant_name||','||chr(10)||'Your GST Ledger Studio account access is '||kind||'.' end))
 where id=item.id returning * into item;
 return to_jsonb(item);
end; $$;
-- CREATE OR REPLACE retains the previous service-only execution grants.
commit;
