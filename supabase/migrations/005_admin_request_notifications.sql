-- Administrator request delivery only. Preserve every existing row and frozen payload.
begin;
create or replace function public.claim_approval_notification(p_admin_email text,p_sender text,p_admin_url text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.approval_notifications; token uuid;
begin
 update public.approval_notifications set state='needs_review',lease_token=null,lease_until=null
 where state in ('failed','sending') and (first_attempt_at<now()-interval '23 hours' or attempts>=8)
 and (lease_until is null or lease_until<now());
 select * into item from public.approval_notifications
 where ((state in ('pending','failed') and next_attempt_at<=now()) or (state='sending' and lease_until<now()))
 and kind='request'
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
-- Decision events remain retained but are never claimed for email delivery.
commit;
