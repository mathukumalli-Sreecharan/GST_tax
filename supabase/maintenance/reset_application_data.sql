-- Database phase of the GST Ledger Studio reset.
-- Precondition: application writes and cleanup workers are paused, the exact
-- Storage manifest has been deleted through the Storage API, and both managed
-- buckets are verified empty. This file never deletes Storage metadata.
-- Repeatable: deleting zero rows on a retry is safe.
begin;
set local lock_timeout = '5s';
select pg_catalog.pg_advisory_xact_lock(75204136);

do $$
begin
  if (select count(*) from storage.buckets
      where id in ('gst-review-workbooks', 'generated-excel-files')) <> 2 then
    raise exception 'Reset stopped: one or both managed Storage buckets are missing';
  end if;
  if exists (
    select 1 from storage.buckets
    where id in ('gst-review-workbooks', 'generated-excel-files')
      and public is distinct from false
  ) then
    raise exception 'Reset stopped: a managed Storage bucket is not private';
  end if;
  if exists (
    select 1 from storage.objects
    where bucket_id in ('gst-review-workbooks', 'generated-excel-files')
  ) then
    raise exception 'Reset stopped: managed Storage buckets are not empty; delete and verify exact manifest objects first';
  end if;
end;
$$;

do $$
declare review_rows bigint; file_rows bigint;
begin
  delete from public.excel_reviews;
  get diagnostics review_rows = row_count;
  delete from public.generated_files;
  get diagnostics file_rows = row_count;
  raise notice 'Reset removed % excel_reviews rows and % generated_files rows', review_rows, file_rows;
end;
$$;

commit;
