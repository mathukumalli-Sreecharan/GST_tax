-- Additive migration: preserves the existing configured owner and approvals.
begin;
create table public.generated_files (
 id uuid primary key,
 -- Keep UUID tombstones after account deletion until Storage cleanup succeeds.
 user_id uuid not null,
 original_filename text not null check(length(original_filename) between 1 and 250),
 output_filename text not null check(length(output_filename) between 1 and 250),
 storage_path text not null unique,
 file_size bigint not null check(file_size between 1 and 52428800),
 created_at timestamptz not null default now(),
 processing_summary jsonb not null,
 verification_count integer not null check(verification_count>=0),
 expires_at timestamptz not null default now()+interval '30 days',
 state text not null default 'uploading' check(state in ('uploading','ready','deleting')),
 cleanup_token uuid, cleanup_until timestamptz,
 check(storage_path=user_id::text||'/'||id::text||'.xlsx')
);
create index generated_files_owner_date on public.generated_files(user_id,created_at desc);
create index generated_files_expiration on public.generated_files(expires_at);
alter table public.generated_files enable row level security;
revoke all on public.generated_files from public,anon,authenticated;
grant select on public.generated_files to authenticated;
create policy "Approved users read own unexpired generated files" on public.generated_files
 for select to authenticated using (
 user_id=(select auth.uid()) and state='ready' and expires_at>now()
 and exists(select 1 from public.user_approvals a where a.user_id=(select auth.uid()) and a.status='approved' and a.verified_email is not null)
 );

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('generated-excel-files','generated-excel-files',false,52428800,
 array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- All access goes through FastAPI, so revocation is checked on every download.
-- Restrictive policy also blocks this bucket if another broad storage policy exists.
create policy "Generated Excel is backend only" on storage.objects as restrictive
 for all to anon,authenticated using(bucket_id<>'generated-excel-files')
 with check(bucket_id<>'generated-excel-files');

create function public.assert_generated_file_access(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.user_approvals a join auth.users u on u.id=a.user_id
 where a.user_id=p_user and a.status='approved' and u.email_confirmed_at is not null and u.email is not null) then
  raise exception using errcode='42501',message='Approved verified account required';
 end if;
end; $$;

create function public.reserve_generated_file(p_id uuid,p_user uuid,p_original text,p_output text,p_size bigint,p_summary jsonb,p_warnings integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.generated_files;
begin
 perform public.assert_generated_file_access(p_user);
 insert into public.generated_files(id,user_id,original_filename,output_filename,storage_path,file_size,processing_summary,verification_count)
 values(p_id,p_user,p_original,p_output,p_user::text||'/'||p_id::text||'.xlsx',p_size,p_summary,p_warnings)
 returning * into item;
 return to_jsonb(item);
end; $$;

create function public.complete_generated_file(p_id uuid,p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.generated_files;
begin
 perform public.assert_generated_file_access(p_user);
 update public.generated_files set state='ready' where id=p_id and user_id=p_user and state='uploading'
 returning * into item;
 if not found then raise exception using errcode='P0002',message='File reservation not found'; end if;
 return to_jsonb(item);
end; $$;

create function public.list_generated_files(p_user uuid,p_search text default '',p_sort text default 'newest',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.assert_generated_file_access(p_user);
 with matching as (select id,original_filename,output_filename,file_size,created_at,processing_summary,verification_count,expires_at
 from public.generated_files where user_id=p_user and state='ready' and expires_at>now()
 and (strpos(lower(output_filename),lower(p_search))>0 or strpos(lower(original_filename),lower(p_search))>0)),
 page as (select * from matching order by
 case when p_sort='name' then lower(output_filename) end asc,
 case when p_sort='oldest' then created_at end asc,
 case when p_sort='size' then file_size end desc,
 created_at desc,id limit 20 offset greatest(p_offset,0))
 select jsonb_build_object('files',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'::jsonb),
 'total',(select count(*) from matching),'retention_days',30) into result;
 return result;
end; $$;

create function public.get_generated_file(p_id uuid,p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.generated_files;
begin
 perform public.assert_generated_file_access(p_user);
 select * into item from public.generated_files where id=p_id and user_id=p_user and state='ready' and expires_at>now();
 if not found then raise exception using errcode='P0002',message='File not found'; end if;
 return to_jsonb(item);
end; $$;

create function public.mark_generated_file_deleted(p_id uuid,p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item public.generated_files;
begin
 perform public.assert_generated_file_access(p_user);
 update public.generated_files set state='deleting',expires_at=least(expires_at,now()),
 cleanup_token=gen_random_uuid(),cleanup_until=now()+interval '5 minutes'
 where id=p_id and user_id=p_user returning * into item;
 if not found then raise exception using errcode='P0002',message='File not found'; end if;
 return to_jsonb(item);
end; $$;

create function public.claim_expired_generated_files() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 with expired as (
 select id from public.generated_files where
 (expires_at<=now() or state='deleting' or (state='uploading' and created_at<now()-interval '1 hour')
 or not exists(select 1 from auth.users u where u.id=generated_files.user_id))
 and (cleanup_until is null or cleanup_until<now()) order by created_at for update skip locked limit 100),
 claimed as (update public.generated_files f set state='deleting',cleanup_token=gen_random_uuid(),cleanup_until=now()+interval '5 minutes'
 from expired e where f.id=e.id returning f.*)
 select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into result from claimed c;
 return result;
end; $$;

create function public.abandon_generated_file(p_id uuid,p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_generated_file_access(p_user);
 -- Leave a durable tombstone through an ambiguous in-flight Storage upload.
 update public.generated_files set state='deleting',expires_at=now(),cleanup_token=null,
 cleanup_until=now()+interval '1 hour' where id=p_id and user_id=p_user;
end; $$;

create function public.finish_generated_file_delete(p_id uuid,p_token uuid) returns void
language sql security definer set search_path='' as $$
 delete from public.generated_files where id=p_id and state='deleting' and cleanup_token=p_token
$$;

revoke all on function public.assert_generated_file_access(uuid),
 public.reserve_generated_file(uuid,uuid,text,text,bigint,jsonb,integer),public.complete_generated_file(uuid,uuid),
 public.list_generated_files(uuid,text,text,integer),public.get_generated_file(uuid,uuid),public.mark_generated_file_deleted(uuid,uuid),
 public.claim_expired_generated_files(),public.finish_generated_file_delete(uuid,uuid),public.abandon_generated_file(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.reserve_generated_file(uuid,uuid,text,text,bigint,jsonb,integer),public.complete_generated_file(uuid,uuid),
 public.list_generated_files(uuid,text,text,integer),public.get_generated_file(uuid,uuid),public.mark_generated_file_deleted(uuid,uuid),
 public.claim_expired_generated_files(),public.finish_generated_file_delete(uuid,uuid),public.abandon_generated_file(uuid,uuid) to service_role;
commit;
