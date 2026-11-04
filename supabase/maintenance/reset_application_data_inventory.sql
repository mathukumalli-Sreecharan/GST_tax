-- Read-only dry-run inventory for a GST Ledger Studio application-data reset.
-- Run only after confirming the live schema matches migrations 001-008.
-- This reports counts and exact object names; it does not mutate data.

select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'auth', 'storage') and table_type = 'BASE TABLE'
order by table_schema, table_name;

select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('gst-review-workbooks', 'generated-excel-files')
order by id;

select 'excel_reviews' as table_name, state, count(*) as rows,
       coalesce(sum(source_size), 0) as source_bytes,
       coalesce(sum(artifact_reserved), 0) as reserved_artifact_bytes,
       coalesce(sum((select count(*) from jsonb_object_keys(decisions))), 0) as saved_decisions
from public.excel_reviews
group by state
union all
select 'excel_reviews', '(all)', count(*), coalesce(sum(source_size), 0),
       coalesce(sum(artifact_reserved), 0),
       coalesce(sum((select count(*) from jsonb_object_keys(decisions))), 0)
from public.excel_reviews
union all
select 'generated_files', state, count(*), coalesce(sum(file_size), 0), 0, 0
from public.generated_files
group by state
union all
select 'generated_files', '(all)', count(*), coalesce(sum(file_size), 0), 0, 0
from public.generated_files
order by table_name, state;

-- Exact database row identities in deletion scope (no filenames or payloads).
select 'excel_reviews' as table_name, id, state, source_size as source_bytes,
       artifact_reserved as reserved_artifact_bytes,
       (select count(*) from jsonb_object_keys(decisions)) as saved_decisions
from public.excel_reviews
union all
select 'generated_files', id, state, null, 0, 0
from public.generated_files
order by table_name, id;

-- Storage metadata inventory. Names are returned verbatim for manifest review.
-- Any UNCLASSIFIED object is a hard stop until its ownership is understood.
with classified as (
  select bucket_id, name,
    case
      when bucket_id = 'generated-excel-files'
       and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx$'
        then 'history_workbook'
      when bucket_id = 'gst-review-workbooks'
       and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/source\.xlsx$'
        then 'review_source_workbook'
      when bucket_id = 'gst-review-workbooks'
       and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/output\.xlsx$'
        then 'review_generated_workbook'
      when bucket_id = 'gst-review-workbooks'
       and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/report\.csv$'
        then 'review_generated_report'
      else 'UNCLASSIFIED'
    end as category,
    case when coalesce(metadata->>'size', '') ~ '^[0-9]+$'
         then (metadata->>'size')::bigint else null end as bytes
  from storage.objects
  where bucket_id in ('generated-excel-files', 'gst-review-workbooks')
)
select bucket_id, category, count(*) as objects,
       coalesce(sum(bytes), 0) as reported_bytes,
       array_agg(name order by name) as exact_object_names
from classified
group by bucket_id, category
order by bucket_id, category;

-- Approval/account preservation baseline. Capture these counts and compare
-- them after reset; no rows in these tables are part of the reset scope.
select 'auth.users' as preserved_table, count(*) as rows from auth.users
union all select 'public.profiles', count(*) from public.profiles
union all select 'public.approval_owner', count(*) from public.approval_owner
union all select 'public.user_approvals', count(*) from public.user_approvals
union all select 'public.approval_audit', count(*) from public.approval_audit
union all select 'public.approval_notifications', count(*) from public.approval_notifications
order by preserved_table;
