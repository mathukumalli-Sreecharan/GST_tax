-- Reconcile abandoned generation reservations without changing review schema.
-- Apply after 007_durable_excel_reviews.sql; never run against production without approval.
begin;

create or replace function public.review_change(p_id uuid,p_user uuid,p_version bigint,p_state text,p_token uuid,p_change jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; next_state text; clock double precision=extract(epoch from now()); token uuid; artifact_bytes bigint; metadata_delta bigint;
begin
 perform public.assert_generated_file_access(p_user);
 if p_version is null or p_state is null or p_change is null or jsonb_typeof(p_change)<>'object' or
    jsonb_typeof(p_change->'state') is distinct from 'string' or
    jsonb_typeof(p_change->'decisions') is distinct from 'object' then
  raise exception using errcode='40001',message='Invalid review mutation';
 end if;
 select * into item from public.excel_reviews where id=p_id and owner=p_user and state<>'deleted' and expires>clock for update;
 if not found then raise exception using errcode='P0002',message='Review not found'; end if;
 if item.version<>p_version or item.state<>p_state or item.lease_token is distinct from p_token then
  raise exception using errcode='40001',message='Review changed';
 end if;
 next_state=p_change->>'state';
 if not ((p_state='open' and next_state in ('open','generating','deleted')) or
         (p_state='generating' and next_state in ('open','generated')) or
         (p_state='generated' and next_state in ('generated','deleted'))) then
  raise exception using errcode='40001',message='Unsafe review transition';
 end if;
 if p_state<>'open' and p_change->'decisions' is distinct from item.decisions then
  raise exception using errcode='40001',message='Generation snapshot is immutable';
 end if;
 token=nullif(p_change->>'lease_token','')::uuid;
 if next_state='generating' then
  if item.lease_token is not null then
   raise exception using errcode='40001',message='Previous generation attempt is awaiting artifact reconciliation';
  end if;
  if item.state='open' and item.artifact_reserved>0 and jsonb_array_length(item.artifact_tokens)>0 and (item.result is null or item.result='null'::jsonb) and
     item.cleanup_token is distinct from (item.artifact_tokens->>(jsonb_array_length(item.artifact_tokens)-1))::uuid then
   raise exception using errcode='40001',message='Previous generation attempt is awaiting artifact reconciliation';
  end if;
  if token is null or item.artifact_tokens ? token::text or jsonb_array_length(item.artifact_tokens)>=8 then
   raise exception using errcode='P0001',message='Generation token reused or attempt limit reached';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(71245618);
  if (select coalesce(sum(source_size+artifact_reserved+octet_length(filename)+octet_length(options::text)+octet_length(analysis::text)+octet_length(decisions::text)+coalesce(octet_length(result::text),0)),0) from public.excel_reviews)+104857600>536870912 then
   raise exception using errcode='P0001',message='Review artifact quota reached';
  end if;
  item.artifact_reserved=item.artifact_reserved+104857600;
  item.lease_token=token; item.lease_until=clock+600;
  item.artifact_tokens=item.artifact_tokens||to_jsonb(token::text);
 elsif p_state='generating' and next_state='open' then
  if token is distinct from item.lease_token then
   raise exception using errcode='40001',message='Generation attempt token changed';
  end if;
  -- Fence stale workers, then leave a quarantine interval for any ambiguous
  -- Storage request. Reconciliation will account for every token path later.
  item.lease_until=greatest(coalesce(item.lease_until,clock),clock)+120;
 elsif p_state='open' and next_state='open' and token is distinct from item.lease_token then
  raise exception using errcode='40001',message='Pending generation token is immutable';
 end if;
 if next_state='generated' and p_state='generating' then
  if item.lease_until<=clock or p_change#>>'{result,durable_artifact,token}' is distinct from item.lease_token::text then
   raise exception using errcode='40001',message='Generation lease expired or artifact is not fenced';
  end if;
  if coalesce(jsonb_typeof(p_change#>'{result,durable_artifact,output_bytes}'),'null')<>'number' or coalesce(jsonb_typeof(p_change#>'{result,durable_artifact,report_bytes}'),'null')<>'number' then
   raise exception using errcode='40001',message='Artifact sizes are required';
  end if;
  artifact_bytes=(p_change#>>'{result,durable_artifact,output_bytes}')::bigint+(p_change#>>'{result,durable_artifact,report_bytes}')::bigint;
  if (p_change#>>'{result,durable_artifact,output_bytes}')::bigint not between 1 and 52428800 or (p_change#>>'{result,durable_artifact,report_bytes}')::bigint not between 1 and 52428800 then
   raise exception using errcode='40001',message='Artifact sizes exceed limits';
  end if;
  item.artifact_reserved=item.artifact_reserved-104857600+artifact_bytes;
  item.lease_until=null;
 end if;
 if p_state='generated' and next_state='generated' and (p_change#>'{result,durable_artifact}' is distinct from item.result->'durable_artifact' or p_change#>'{result,file_id}' is distinct from item.result->'file_id') then
  raise exception using errcode='40001',message='Committed artifacts are immutable';
 end if;
 metadata_delta=octet_length((p_change->'decisions')::text)+coalesce(octet_length((p_change->'result')::text),0)-octet_length(item.decisions::text)-coalesce(octet_length(item.result::text),0);
 if metadata_delta>0 then
  perform pg_catalog.pg_advisory_xact_lock(71245618);
  if (select coalesce(sum(source_size+artifact_reserved+octet_length(filename)+octet_length(options::text)+octet_length(analysis::text)+octet_length(decisions::text)+coalesce(octet_length(result::text),0)),0) from public.excel_reviews)+metadata_delta+item.artifact_reserved-(select artifact_reserved from public.excel_reviews where id=p_id)>536870912 then
   raise exception using errcode='P0001',message='Review metadata quota reached';
  end if;
 end if;
 update public.excel_reviews set state=next_state,version=version+1,decisions=p_change->'decisions',result=p_change->'result',
 lease_token=item.lease_token,lease_until=item.lease_until,artifact_tokens=item.artifact_tokens,artifact_reserved=item.artifact_reserved
 where id=p_id returning * into item;
 return to_jsonb(item);
end; $$;

create function public.review_reconcile_claim(p_id uuid default null,p_user uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; clock double precision=extract(epoch from now());
begin
 if (p_id is null) is distinct from (p_user is null) then
  raise exception using errcode='40001',message='Review reconciliation scope is invalid';
 end if;
 if p_user is not null then perform public.assert_generated_file_access(p_user); end if;

 select * into item from public.excel_reviews where state='open' and lease_token is not null and lease_until<=clock
 and expires>clock and coalesce(cleanup_until,0)<clock and (p_id is null or (id=p_id and owner=p_user))
 order by lease_until for update skip locked limit 1;
 if found then
  update public.excel_reviews set cleanup_token=gen_random_uuid(),cleanup_until=clock+600
  where id=item.id returning * into item;
  return to_jsonb(item);
 end if;

 -- Fence a crashed worker first. Wait through a bounded quarantine before the
 -- next claim lists Storage, so an in-flight upload cannot be mistaken for none.
 select * into item from public.excel_reviews where state='generating' and lease_token is not null
 and lease_until<=clock and expires>clock and (p_id is null or (id=p_id and owner=p_user))
 and coalesce(cleanup_until,0)<clock order by lease_until for update skip locked limit 1;
 if found then
  update public.excel_reviews set state='open',version=version+1,lease_until=clock+120,cleanup_token=null,cleanup_until=null
  where id=item.id;
  return null;
 end if;

 -- Legacy rows from before this migration may have an open state and a held
 -- reservation but no pending token marker. Quarantine their newest attempt
 -- once, then reconcile every recorded token path after the same grace period.
 select * into item from public.excel_reviews where state='open' and lease_token is null and artifact_reserved>0
 and jsonb_array_length(artifact_tokens)>0 and (result is null or result='null'::jsonb)
 and cleanup_token is distinct from (artifact_tokens->>(jsonb_array_length(artifact_tokens)-1))::uuid
 and expires>clock and coalesce(cleanup_until,0)<clock and (p_id is null or (id=p_id and owner=p_user))
 order by created for update skip locked limit 1;
 if found then
  update public.excel_reviews set lease_token=(item.artifact_tokens->>(jsonb_array_length(item.artifact_tokens)-1))::uuid,
   lease_until=clock+120,version=version+1 where id=item.id;
 end if;
 return null;
end; $$;

create function public.review_reconcile_finish(p_id uuid,p_user uuid,p_attempt uuid,p_cleanup uuid,p_artifact_bytes bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; clock double precision=extract(epoch from now());
begin
 perform public.assert_generated_file_access(p_user);
 if p_artifact_bytes is null or p_artifact_bytes<0 or p_artifact_bytes>536870912 then
  raise exception using errcode='40001',message='Reconciled artifact size is outside the supported limit';
 end if;
 select * into item from public.excel_reviews where id=p_id and owner=p_user and state='open'
 and expires>clock and lease_token=p_attempt and cleanup_token=p_cleanup and cleanup_until>clock for update;
 -- A replay or stale worker is harmless: it cannot release a different token.
 if not found then return false; end if;
 if not (item.artifact_tokens ? p_attempt::text) then
  raise exception using errcode='40001',message='Generation token is not recorded on this review';
 end if;
 if (item.artifact_tokens->>(jsonb_array_length(item.artifact_tokens)-1))::uuid is distinct from p_attempt then
  raise exception using errcode='40001',message='Generation token changed during reconciliation';
 end if;
 if p_artifact_bytes>item.artifact_reserved then
  raise exception using errcode='40001',message='Reconciled artifacts exceed the held reservation';
 end if;
 update public.excel_reviews set artifact_reserved=p_artifact_bytes,lease_token=null,lease_until=null,
 cleanup_token=p_attempt,cleanup_until=0 where id=p_id;
 return true;
end; $$;

revoke all on function public.review_reconcile_claim(uuid,uuid),public.review_reconcile_finish(uuid,uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.review_reconcile_claim(uuid,uuid),public.review_reconcile_finish(uuid,uuid,uuid,uuid,bigint) to service_role;
commit;
