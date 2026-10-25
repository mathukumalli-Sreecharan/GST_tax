-- Additive, backend-only review persistence. Apply manually after 001-006.
begin;
create table public.excel_reviews (
 id uuid primary key, owner uuid not null, filename text not null check(length(filename) between 1 and 250),
 source_size bigint not null check(source_size between 1 and 20971520),
 source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
 options jsonb not null, analysis jsonb not null, decisions jsonb not null default '{}',
 result jsonb, version bigint not null default 1,
 state text not null default 'uploading' check(state in ('uploading','open','generating','generated','deleted')),
 created double precision not null default extract(epoch from now()),
 expires double precision not null default extract(epoch from now()+interval '24 hours'),
 lease_token uuid, lease_until double precision,
 artifact_reserved bigint not null default 0,
 artifact_tokens jsonb not null default '[]', cleanup_token uuid, cleanup_until double precision,
 check(jsonb_typeof(options)='object' and jsonb_typeof(analysis)='object' and jsonb_typeof(decisions)='object'),
 check(octet_length(options::text)<=65536),
 check(octet_length(analysis::text)+octet_length(decisions::text)+coalesce(octet_length(result::text),0)<=52428800)
);
create index excel_reviews_owner on public.excel_reviews(owner,created desc);
create index excel_reviews_expiry on public.excel_reviews(expires);
alter table public.excel_reviews enable row level security;
revoke all on public.excel_reviews from public,anon,authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('gst-review-workbooks','gst-review-workbooks',false,52428800,
 array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "Review workbooks are backend only" on storage.objects as restrictive
 for all to anon,authenticated using(bucket_id<>'gst-review-workbooks') with check(bucket_id<>'gst-review-workbooks');

create function public.review_reserve(p_id uuid,p_user uuid,p_filename text,p_size bigint,p_hash text,p_options jsonb,p_analysis jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; used bigint; reserved bigint;
begin
 perform public.assert_generated_file_access(p_user);
 -- One short global reservation lock enforces both tenant and physical quota.
 perform pg_catalog.pg_advisory_xact_lock(71245618);
 if (select count(*) from public.excel_reviews where owner=p_user and state<>'deleted' and expires>extract(epoch from now()))>=5 then
  raise exception using errcode='P0001',message='Review quota reached';
 end if;
 select coalesce(sum(source_size+octet_length(filename)+octet_length(options::text)+octet_length(analysis::text)+octet_length(decisions::text)+coalesce(octet_length(result::text),0)),0) into used from public.excel_reviews;
 select coalesce(sum(artifact_reserved),0) into reserved from public.excel_reviews;
 if used+p_size+octet_length(p_filename)+octet_length(p_options::text)+octet_length(p_analysis::text)+2>209715200 or used+reserved+p_size+octet_length(p_filename)+octet_length(p_options::text)+octet_length(p_analysis::text)+2>536870912 then raise exception using errcode='P0001',message='Review storage quota reached'; end if;
 insert into public.excel_reviews(id,owner,filename,source_size,source_hash,options,analysis)
 values(p_id,p_user,p_filename,p_size,p_hash,p_options,p_analysis) returning * into item;
 return to_jsonb(item);
end; $$;

create function public.review_activate(p_id uuid,p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews;
begin
 perform public.assert_generated_file_access(p_user);
 update public.excel_reviews set state='open' where id=p_id and owner=p_user and state='uploading' and expires>extract(epoch from now()) returning * into item;
 if not found then raise exception using errcode='40001',message='Review upload state changed'; end if;
 return to_jsonb(item);
end; $$;

create function public.review_get(p_id uuid,p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews;
begin
 perform public.assert_generated_file_access(p_user);
 select * into item from public.excel_reviews where id=p_id and owner=p_user and state in ('open','generating','generated') and expires>extract(epoch from now());
 if not found then raise exception using errcode='P0002',message='Review not found'; end if;
 return to_jsonb(item);
end; $$;

create function public.review_list(p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_generated_file_access(p_user);
 return coalesce((select jsonb_agg(jsonb_build_object('review_id',id,'filename',filename,'state',state,'created_at',created) order by created desc)
 from public.excel_reviews where owner=p_user and state in ('open','generating','generated') and expires>extract(epoch from now())),'[]');
end; $$;

create function public.review_change(p_id uuid,p_user uuid,p_version bigint,p_state text,p_token uuid,p_change jsonb)
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
 token=(p_change->>'lease_token')::uuid;
 if next_state='generating' then
  if token is null or item.artifact_tokens ? token::text or jsonb_array_length(item.artifact_tokens)>=8 then raise exception using errcode='P0001',message='Generation token reused or attempt limit reached'; end if;
  perform pg_catalog.pg_advisory_xact_lock(71245618);
  if (select coalesce(sum(source_size+artifact_reserved+octet_length(filename)+octet_length(options::text)+octet_length(analysis::text)+octet_length(decisions::text)+coalesce(octet_length(result::text),0)),0) from public.excel_reviews)+104857600>536870912 then
   raise exception using errcode='P0001',message='Review artifact quota reached';
  end if;
  item.artifact_reserved=item.artifact_reserved+104857600;
  item.lease_token=token; item.lease_until=clock+600;
  item.artifact_tokens=item.artifact_tokens||to_jsonb(token::text);
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
 if next_state='open' then item.lease_token=null; item.lease_until=null; end if;
 update public.excel_reviews set state=next_state,version=version+1,decisions=p_change->'decisions',result=p_change->'result',
 lease_token=item.lease_token,lease_until=item.lease_until,artifact_tokens=item.artifact_tokens,artifact_reserved=item.artifact_reserved
 where id=p_id returning * into item;
 return to_jsonb(item);
end; $$;

create function public.review_cleanup_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; clock double precision=extract(epoch from now());
begin
 select * into item from public.excel_reviews where
 (state='deleted' or expires<=clock or (state='uploading' and created<clock-600) or not exists(select 1 from auth.users u where u.id=owner))
 and coalesce(lease_until,0)<clock and coalesce(cleanup_until,0)<clock order by created for update skip locked limit 1;
 if not found then return null; end if;
 update public.excel_reviews set state='deleted',version=version+1,cleanup_token=gen_random_uuid(),cleanup_until=clock+120 where id=item.id returning * into item;
 return to_jsonb(item);
end; $$;

create function public.review_cleanup_finish(p_id uuid,p_token uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 delete from public.excel_reviews where id=p_id and state='deleted' and cleanup_token=p_token;
end; $$;

-- Reconcile late uploads whose reserved review was already physically cleaned.
-- Never delete an object belonging to an existing (even expired) review here;
-- its leased tombstone cleanup handles all generations as a single operation.
create function public.review_orphan_paths() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 return coalesce((select jsonb_agg(name) from (
 select o.name from storage.objects o where o.bucket_id='gst-review-workbooks'
 and o.created_at<now()-interval '1 hour'
 and o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(source[.]xlsx|[0-9a-f-]{36}/(output[.]xlsx|report[.]csv))$'
 and not exists(select 1 from public.excel_reviews r where r.id::text=split_part(o.name,'/',2) and r.owner::text=split_part(o.name,'/',1))
 order by o.created_at limit 100) orphan),'[]');
end; $$;

-- Only the trusted API/maintenance role can call these functions or access objects.
revoke all on function public.review_reserve(uuid,uuid,text,bigint,text,jsonb,jsonb),public.review_activate(uuid,uuid),
 public.review_get(uuid,uuid),public.review_list(uuid),public.review_change(uuid,uuid,bigint,text,uuid,jsonb),
 public.review_cleanup_claim(),public.review_cleanup_finish(uuid,uuid),public.review_orphan_paths() from public,anon,authenticated;
grant execute on function public.review_reserve(uuid,uuid,text,bigint,text,jsonb,jsonb),public.review_activate(uuid,uuid),
 public.review_get(uuid,uuid),public.review_list(uuid),public.review_change(uuid,uuid,bigint,text,uuid,jsonb),
 public.review_cleanup_claim(),public.review_cleanup_finish(uuid,uuid),public.review_orphan_paths() to service_role;
commit;
