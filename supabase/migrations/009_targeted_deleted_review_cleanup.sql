-- ID-scoped cleanup claims for explicitly approved deleted reviews.
-- No table or column changes. Apply only after review and explicit approval.
begin;

create function public.review_cleanup_claim_target(p_id uuid,p_expected_reserved bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; clock double precision=extract(epoch from now());
begin
 if p_id is null or p_expected_reserved is null or p_expected_reserved<=0 then
  raise exception using errcode='40001',message='Target review cleanup identity is invalid';
 end if;
 select * into item from public.excel_reviews where id=p_id for update skip locked;
 if not found then
  if exists(select 1 from public.excel_reviews where id=p_id) then
   raise exception using errcode='40001',message='Target review row is currently locked';
  end if;
  raise exception using errcode='P0002',message='Target review not found';
 end if;
 if item.state<>'deleted' then
  raise exception using errcode='40001',message='Target review is not deleted';
 end if;
 if item.artifact_reserved<>p_expected_reserved then
  raise exception using errcode='40001',message='Target review reservation changed';
 end if;
 if coalesce(item.lease_until,0)>=clock then
  raise exception using errcode='40001',message='Target review has an active generation lease';
 end if;
 if coalesce(item.cleanup_until,0)>=clock then
  raise exception using errcode='40001',message='Target review has an active cleanup lease';
 end if;
 update public.excel_reviews set cleanup_token=gen_random_uuid(),cleanup_until=clock+600
 where id=p_id returning * into item;
 return to_jsonb(item);
end; $$;

-- Keep the existing deletion semantics, while returning a fenced confirmation
-- so the caller can distinguish successful finalization from a stale token.
create function public.review_cleanup_finish_target(p_id uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.excel_reviews; clock double precision=extract(epoch from now());
begin
 if p_id is null or p_token is null then
  raise exception using errcode='40001',message='Target review cleanup lease is invalid';
 end if;
 select * into item from public.excel_reviews where id=p_id and state='deleted'
 and cleanup_token=p_token and cleanup_until>clock for update;
 if not found then return false; end if;
 perform public.review_cleanup_finish(p_id,p_token);
 return not exists(select 1 from public.excel_reviews where id=p_id);
end; $$;

revoke all on function public.review_cleanup_claim_target(uuid,bigint),
 public.review_cleanup_finish_target(uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_cleanup_claim_target(uuid,bigint),
 public.review_cleanup_finish_target(uuid,uuid) to service_role;
commit;
