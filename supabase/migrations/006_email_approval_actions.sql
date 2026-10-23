-- Additive: new messages gain confirmation links. Frozen payloads and history stay untouched.
begin;
create function public.admin_approval_applicant(p_actor uuid,p_owner uuid,p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_actor is distinct from p_owner or not exists(select 1 from public.approval_owner o
 join public.user_approvals a on a.user_id=o.user_id where o.user_id=p_actor
 and a.status='approved' and a.verified_email is not null) then
  raise exception using errcode='42501',message='Owner access required';
 end if;
 select to_jsonb(a)||jsonb_build_object('is_owner',a.user_id=p_owner) into result
 from public.user_approvals a where a.user_id=p_user;
 if result is null then raise exception using errcode='P0002',message='Applicant not found'; end if;
 return result;
end; $$;
revoke all on function public.admin_approval_applicant(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_approval_applicant(uuid,uuid,uuid) to service_role;

create or replace function public.claim_approval_notification(p_admin_email text,p_sender text,p_admin_url text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.approval_notifications; token uuid;
 approve_url text; reject_url text; review_url text; html_body text; text_body text; registered text;
 safe_name text; safe_email text; safe_approve text; safe_reject text; safe_review text;
begin
 update public.approval_notifications set state='needs_review',lease_token=null,lease_until=null
 where state in ('failed','sending') and (first_attempt_at<now()-interval '23 hours' or attempts>=8)
 and (lease_until is null or lease_until<now());
 select * into item from public.approval_notifications
 where ((state in ('pending','failed') and next_attempt_at<=now()) or (state='sending' and lease_until<now()))
 and kind='request' and attempts<8 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 token=gen_random_uuid();
 if item.payload is null then
  review_url=p_admin_url;
  registered=coalesce(to_char(item.applicant_registered_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS')||' UTC','unavailable');
  text_body='A verified account requests access.'||chr(10)||'Name: '||item.applicant_name||chr(10)||
   'Verified email: '||item.applicant_email||chr(10)||'Registered (UTC): '||registered||chr(10)||'Review: '||review_url;
  -- Only trigger-generated request UUIDs are used in action URLs. No bearer secrets.
  if item.event_key ~ '^request:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   approve_url=regexp_replace(p_admin_url,'/admin/approvals$','')||'/approval-action?user='||substring(item.event_key from 9)||'&decision=approved';
   reject_url=regexp_replace(p_admin_url,'/admin/approvals$','')||'/approval-action?user='||substring(item.event_key from 9)||'&decision=rejected';
   text_body=text_body||chr(10)||'Approve (sign-in and confirmation required): '||approve_url||chr(10)||'Reject (sign-in and confirmation required): '||reject_url;
  end if;
  -- Escape untrusted display fields and HTML attribute values. Never render metadata as markup.
  safe_name=replace(replace(replace(replace(replace(item.applicant_name,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#39;');
  safe_email=replace(replace(replace(replace(replace(item.applicant_email,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#39;');
  safe_review=replace(replace(replace(replace(review_url,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;');
  safe_approve=replace(replace(replace(replace(approve_url,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;');
  safe_reject=replace(replace(replace(replace(reject_url,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;');
  html_body='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f3f5f4;font-family:Arial,sans-serif;color:#18332a"><main style="max-width:560px;margin:24px auto;padding:24px;background:white;border-radius:12px"><p>GST LEDGER STUDIO</p><h1 style="font-size:24px">Account approval requested</h1><p><strong>Name:</strong> '||safe_name||'</p><p style="overflow-wrap:anywhere"><strong>Verified email:</strong> '||safe_email||'</p><p><strong>Registered:</strong> '||registered||'</p>';
  if approve_url is not null then
   html_body=html_body||'<p style="line-height:3"><a style="display:inline-block;padding:0 20px;margin:4px;background:#216747;color:white;border-radius:6px;text-decoration:none" href="'||safe_approve||'">Approve</a> <a style="display:inline-block;padding:0 20px;margin:4px;background:#a23232;color:white;border-radius:6px;text-decoration:none" href="'||safe_reject||'">Reject</a></p>';
  end if;
  html_body=html_body||'<p>Sign in as the administrator and confirm your decision. Opening a link does not change account access.</p><p><a href="'||safe_review||'">Open Admin Approval Dashboard</a></p></main></body></html>';
  item.payload=jsonb_build_object('from',p_sender,'to',jsonb_build_array(p_admin_email),
   'subject','GST Ledger Studio: approval requested','text',text_body,'html',html_body);
 end if;
 update public.approval_notifications set state='sending',lease_token=token,lease_until=now()+interval '2 minutes',
 attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),payload=item.payload
 where id=item.id returning * into item;
 return to_jsonb(item);
end; $$;
-- CREATE OR REPLACE preserves the existing service-only claim grants.
commit;
