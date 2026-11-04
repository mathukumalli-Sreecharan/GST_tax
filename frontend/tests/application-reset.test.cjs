const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

test('application reset inventory is read-only and guarded reset preserves accounts and approvals',async()=>{
 const db=new PGlite();
 const q=async(sql,params=[]) => (await db.query(sql,params)).rows;
 const inventory=fs.readFileSync('../supabase/maintenance/reset_application_data_inventory.sql','utf8');
 const reset=fs.readFileSync('../supabase/maintenance/reset_application_data.sql','utf8');
 try {
  await db.exec(`create schema auth; create schema storage;
   create table auth.users(id uuid primary key,email text);
   create table public.profiles(id uuid primary key,full_name text);
   create table public.approval_owner(singleton boolean primary key,user_id uuid);
   create table public.user_approvals(user_id uuid primary key,status text);
   create table public.approval_audit(id uuid primary key,user_id uuid);
   create table public.approval_notifications(id uuid primary key,event_key text);
   create table public.excel_reviews(id uuid primary key,state text,source_size bigint,artifact_reserved bigint,decisions jsonb);
   create table public.generated_files(id uuid primary key,state text,file_size bigint);
   create table storage.objects(bucket_id text,name text,metadata jsonb);
   create table storage.buckets(id text primary key,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(`insert into auth.users values('11111111-1111-4111-8111-111111111111','keep@example.test');
   insert into public.profiles values('11111111-1111-4111-8111-111111111111','Keep');
   insert into public.approval_owner values(true,'11111111-1111-4111-8111-111111111111');
   insert into public.user_approvals values('11111111-1111-4111-8111-111111111111','approved');
   insert into public.approval_audit values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111');
   insert into public.approval_notifications values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','approval-event');
   insert into public.excel_reviews values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','generated',1024,0,'{"7":{"choice":"WRONG"}}');
   insert into public.generated_files values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ready',2048);
   insert into storage.buckets values('gst-review-workbooks',false,52428800,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ('generated-excel-files',false,52428800,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),('unrelated',false,1000,array['text/plain']);
   insert into storage.objects values
    ('gst-review-workbooks','11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/source.xlsx','{"size":1024}'),
    ('gst-review-workbooks','11111111-1111-4111-8111-111111111111/cccccccc-cccc-4ccc-8ccc-cccccccccccc/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/report.csv','{"size":32}'),
    ('generated-excel-files','11111111-1111-4111-8111-111111111111/dddddddd-dddd-4ddd-8ddd-dddddddddddd.xlsx','{"size":2048}'),
    ('gst-review-workbooks','unexpected.bin','{"size":9}'),
    ('unrelated','keep.txt','{"size":8}');`);

  const before={};
  for(const table of ['auth.users','public.profiles','public.approval_owner','public.user_approvals','public.approval_audit','public.approval_notifications'])
   before[table]=await q(`select * from ${table} order by 1`);
  const tableNames=(await q("select table_name from information_schema.tables where table_schema='public' order by table_name")).map(row=>row.table_name);
  const buckets=await q('select * from storage.buckets order by id');

  // Each query in the inventory file is read-only and reports the exact paths.
  await db.exec(inventory);
  const storageSql=inventory.split('-- Storage metadata inventory. Names are returned verbatim for manifest review.')[1]
    .split('-- Approval/account preservation baseline.')[0].trim();
  const storageInventory=await q(storageSql);
  assert.deepEqual(new Set(storageInventory.map(row=>row.category)),new Set([
   'review_source_workbook','review_generated_report','history_workbook','UNCLASSIFIED'
  ]));
  assert.equal((await q('select count(*)::int n from public.excel_reviews'))[0].n,1);
  assert.equal((await q('select count(*)::int n from public.generated_files'))[0].n,1);

  // The database phase refuses to erase metadata until Storage is verified empty.
  await assert.rejects(db.exec(reset),/managed Storage buckets are not empty/);
  await db.exec('rollback');
  assert.equal((await q('select count(*)::int n from public.excel_reviews'))[0].n,1);
  assert.equal((await q('select count(*)::int n from public.generated_files'))[0].n,1);

  // Simulate deleting the reviewed, exact Storage manifest through the API.
  await q("delete from storage.objects where bucket_id in ('gst-review-workbooks','generated-excel-files')");
  await db.exec(reset);
  await db.exec(reset); // Idempotent retry.
  assert.equal((await q('select count(*)::int n from public.excel_reviews'))[0].n,0);
  assert.equal((await q('select count(*)::int n from public.generated_files'))[0].n,0);
  for(const table of Object.keys(before))assert.deepEqual(await q(`select * from ${table} order by 1`),before[table]);
  assert.deepEqual((await q("select table_name from information_schema.tables where table_schema='public' order by table_name")).map(row=>row.table_name),tableNames);
  assert.deepEqual(await q('select * from storage.buckets order by id'),buckets);
  assert.deepEqual(await q("select bucket_id,name from storage.objects order by bucket_id,name"),[{bucket_id:'unrelated',name:'keep.txt'}]);
 } finally {await db.close();}
});
