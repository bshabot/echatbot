-- Vendor portal part 2 (CAD files) database tests. Run after both migrations, as postgres.
create temp table t_results(name text, ok boolean);
grant all on t_results to public;
create or replace function pg_temp.expect_denied(label text, stmt text, as_role text) returns void
language plpgsql as $$ declare denied boolean := false; begin
  begin execute format('set local role %I', as_role); execute stmt; exception when others then denied := true; end;
  reset role; insert into t_results values (label, denied); end $$;
create or replace function pg_temp.expect_msg(label text, stmt text, want text) returns void
language plpgsql as $$ declare got text := ''; begin
  begin execute stmt; exception when others then got := sqlerrm; end;
  insert into t_results values (label, got like want); end $$;
create or replace function pg_temp.expect_true(label text, cond boolean) returns void
language plpgsql as $$ begin insert into t_results values (label, coalesce(cond, false)); end $$;
-- helper: a fully uploaded file for session s, returns its id
create or replace function pg_temp.mkfile(s text, nm text default 'cad.stl') returns uuid language plpgsql as $$
declare j jsonb; begin
  j := public.vendor_portal_file_begin(s, nm, 1000);
  perform public.vendor_portal_file_done(s, (j->>'id')::uuid, 1000);
  return (j->>'id')::uuid; end $$;

insert into public.vendors(name) values ('__vp2_A'), ('__vp2_B');
do $$
declare va int; vb int; aa uuid; ab uuid;
begin
  select id into va from public.vendors where name='__vp2_A'; select id into vb from public.vendors where name='__vp2_B';
  aa := public.vendor_admin_create_account(va,'a@vp2.test','H'); ab := public.vendor_admin_create_account(vb,'b@vp2.test','H');
  update public.vendor_accounts set must_change_password=false where id in (aa,ab);
  perform public.vendor_session_create(aa,'S_A',1800,43200); perform public.vendor_session_create(ab,'S_B',1800,43200);
  perform set_config('vp2.va',va::text,false); perform set_config('vp2.vb',vb::text,false);
end $$;

-- 1. access
select pg_temp.expect_denied('anon cannot read files', 'select * from public.vendor_files', 'anon');
select pg_temp.expect_denied('anon cannot insert files', $q$insert into public.vendor_files(vendor_id,path,original_name,ext,size_bytes) values (1,'x','x','jpg',1)$q$, 'anon');
select pg_temp.expect_denied('staff cannot read the storage path', 'select path from public.vendor_files', 'authenticated');
select pg_temp.expect_denied('staff cannot select * on files', 'select * from public.vendor_files', 'authenticated');
select pg_temp.expect_denied('staff cannot change file size', $q$update public.vendor_files set size_bytes=1$q$, 'authenticated');
select pg_temp.expect_denied('staff cannot insert files', $q$insert into public.vendor_files(vendor_id,path,original_name,ext,size_bytes) values (1,'x','x','jpg',1)$q$, 'authenticated');
select pg_temp.expect_denied('staff cannot delete files', 'delete from public.vendor_files', 'authenticated');
select pg_temp.expect_denied('anon cannot call file_begin', $q$select public.vendor_portal_file_begin('S_A','a.jpg',10)$q$, 'anon');
select pg_temp.expect_denied('staff cannot call file_begin', $q$select public.vendor_portal_file_begin('S_A','a.jpg',10)$q$, 'authenticated');
select pg_temp.expect_denied('anon cannot call file_done', $q$select public.vendor_portal_file_done('S_A',gen_random_uuid(),10)$q$, 'anon');
select pg_temp.expect_denied('anon cannot call file_remove', $q$select public.vendor_portal_file_remove('S_A',gen_random_uuid())$q$, 'anon');
select pg_temp.expect_denied('staff cannot call admin_file_path directly', $q$select public.vendor_admin_file_path(gen_random_uuid())$q$, 'authenticated');
select pg_temp.expect_denied('anon cannot call vp_attach_files', $q$select public.vp_attach_files(1,1,'[]')$q$, 'anon');
select pg_temp.expect_true('bucket is private', (select not public from storage.buckets where id='vendor-uploads'));
select pg_temp.expect_true('bucket has a size cap', (select file_size_limit = 104857600 from storage.buckets where id='vendor-uploads'));
select pg_temp.expect_true('staff can read non-path columns', (select has_column_privilege('authenticated','public.vendor_files','original_name','select') and not has_column_privilege('authenticated','public.vendor_files','path','select')));
select pg_temp.expect_true('every new function is server-key only', (select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') and has_function_privilege('service_role',p.oid,'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname like 'vendor\_%' or proname like 'vp\_%')));

-- 2. begin: file name / type / size rules
select pg_temp.expect_msg('exe refused', $q$select public.vendor_portal_file_begin('S_A','virus.exe',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('html refused', $q$select public.vendor_portal_file_begin('S_A','x.html',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('svg refused (script risk)', $q$select public.vendor_portal_file_begin('S_A','x.svg',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('php refused', $q$select public.vendor_portal_file_begin('S_A','x.php',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('zip refused', $q$select public.vendor_portal_file_begin('S_A','x.zip',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('no extension refused', $q$select public.vendor_portal_file_begin('S_A','noext',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('trailing dot refused', $q$select public.vendor_portal_file_begin('S_A','x.jpg.',10)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('zero bytes refused', $q$select public.vendor_portal_file_begin('S_A','a.jpg',0)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('over 100 MB refused', $q$select public.vendor_portal_file_begin('S_A','a.jpg',104857601)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('null size refused', $q$select public.vendor_portal_file_begin('S_A','a.jpg',null)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('negative size refused', $q$select public.vendor_portal_file_begin('S_A','a.jpg',-5)$q$, 'vp_invalid:%');
select pg_temp.expect_msg('control char in name refused', format($q$select public.vendor_portal_file_begin('S_A',%L,10)$q$, 'a'||chr(1)||'.jpg'), 'vp_invalid:%');
select pg_temp.expect_msg('bidi override in name refused', format($q$select public.vendor_portal_file_begin('S_A',%L,10)$q$, 'a'||chr(8238)||'gpj.exe.jpg'), 'vp_invalid:%');
select pg_temp.expect_msg('150+ char name refused', format($q$select public.vendor_portal_file_begin('S_A',%L,10)$q$, repeat('a',160)||'.jpg'), 'vp_invalid:%');
select pg_temp.expect_msg('bad session refused', $q$select public.vendor_portal_file_begin('nope','a.jpg',10)$q$, 'vp_denied');
select pg_temp.expect_msg('empty name refused', $q$select public.vendor_portal_file_begin('S_A','',10)$q$, 'vp_invalid:%');
do $$
declare j jsonb; k jsonb; l jsonb;
begin
  j := public.vendor_portal_file_begin('S_A','../../etc/passwd.JPG',10);
  insert into t_results values ('path traversal in name is neutralised', (j->>'path') ~ ('^vendor/'||current_setting('vp2.va')||'/[0-9a-f-]{36}/passwd\.jpg$') and (j->>'path') not like '%..%');
  k := public.vendor_portal_file_begin('S_A','a.php.jpg',10);
  insert into t_results values ('double extension keeps only the real one', (k->>'path') ~ '/a_php\.jpg$');
  l := public.vendor_portal_file_begin('S_A','My CAD file (v2) é.DWG',10);
  insert into t_results values ('spaces and odd characters are cleaned', (l->>'path') ~ '/My_CAD_file__v2___\.dwg$' or (l->>'path') ~ '/[A-Za-z0-9_.-]+$');
  insert into t_results values ('path never contains a slash from the name', (l->>'path') !~ 'vendor/[0-9]+/[0-9a-f-]{36}/.*/');
  insert into t_results values ('stored ext is lowercase', (select ext from public.vendor_files where id=(l->>'id')::uuid) = 'dwg');
end $$;
select pg_temp.expect_msg('windows path stripped', $q$select public.vendor_portal_file_begin('S_A','C:\Users\x\evil.exe',10)$q$, 'vp_invalid:%');

-- 3. done
select pg_temp.expect_denied('anon cannot call file_path', $q$select public.vendor_portal_file_path('S_A',gen_random_uuid())$q$, 'anon');
do $$
declare j jsonb; got text;
begin
  j := public.vendor_portal_file_begin('S_A','fp.stl',10);
  insert into t_results values ('owner gets the path of a pending file', public.vendor_portal_file_path('S_A',(j->>'id')::uuid) = (j->>'path'));
  begin perform public.vendor_portal_file_path('S_B',(j->>'id')::uuid); got:='ok'; exception when others then got:=sqlerrm; end;
  insert into t_results values ('other vendor cannot get my file path', got='vp_denied');
  begin perform public.vendor_portal_file_path('S_A',gen_random_uuid()); got:='ok'; exception when others then got:=sqlerrm; end;
  insert into t_results values ('unknown file path lookup is denied', got='vp_denied');
end $$;
do $$
declare j jsonb; fid uuid;
begin
  j := public.vendor_portal_file_begin('S_A','d.stl',500); fid := (j->>'id')::uuid;
  insert into t_results values ('new file starts as pending', (select status from public.vendor_files where id=fid)='pending');
  begin perform public.vendor_portal_file_done('S_B', fid, 500); insert into t_results values ('other vendor cannot mark done', false);
  exception when others then insert into t_results values ('other vendor cannot mark done', sqlerrm='vp_denied'); end;
  begin perform public.vendor_portal_file_done('S_A', fid, 104857601); insert into t_results values ('done refuses oversize', false);
  exception when others then insert into t_results values ('done refuses oversize', sqlerrm='vp_denied'); end;
  begin perform public.vendor_portal_file_done('S_A', fid, 0); insert into t_results values ('done refuses zero size', false);
  exception when others then insert into t_results values ('done refuses zero size', sqlerrm='vp_denied'); end;
  perform public.vendor_portal_file_done('S_A', fid, 777);
  insert into t_results values ('done records the verified size', (select status='uploaded' and size_bytes=777 from public.vendor_files where id=fid));
  begin perform public.vendor_portal_file_done('S_A', fid, 888); insert into t_results values ('cannot mark done twice', false);
  exception when others then insert into t_results values ('cannot mark done twice', sqlerrm='vp_denied'); end;
  insert into t_results values ('size cannot change after done', (select size_bytes=777 from public.vendor_files where id=fid));
  begin perform public.vendor_portal_file_done('S_A', gen_random_uuid(), 10); insert into t_results values ('unknown id denied', false);
  exception when others then insert into t_results values ('unknown id denied', sqlerrm='vp_denied'); end;
end $$;

-- 4. submit with files
do $$
declare fa uuid; fa2 uuid; fb uuid; pend jsonb; r jsonb; row1 jsonb; got text; n int;
begin
  fa := pg_temp.mkfile('S_A','one.stl'); fa2 := pg_temp.mkfile('S_A','two.jpg'); fb := pg_temp.mkfile('S_B','b.stl');
  row1 := '{"style_number":"F1","weight":1,"metal_type":"Silver","karat":"925"}'::jsonb;
  -- another vendor's file
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('files', jsonb_build_array(fb)))); got:='ok';
  exception when others then got := sqlerrm; end;
  insert into t_results values ('cannot attach another vendor''s file', got like 'vp_invalid:%');
  select count(*) into n from public.vendor_submissions where data->>'style_number'='F1';
  insert into t_results values ('a refused submit leaves no row behind', n=0);
  -- pending (not uploaded) file
  pend := public.vendor_portal_file_begin('S_A','p.stl',10);
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('files', jsonb_build_array((pend->>'id'))))); got:='ok';
  exception when others then got := sqlerrm; end;
  insert into t_results values ('cannot attach a file that was never uploaded', got like 'vp_invalid:%');
  -- 4 files
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('files', jsonb_build_array(fa,fa2,fa,fa)))); got:='ok';
  exception when others then got := sqlerrm; end;
  insert into t_results values ('more than 3 files refused', got like 'vp_invalid:%');
  -- bad refs
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || '{"files":["not-a-uuid"]}'::jsonb)); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('bad file reference refused', got like 'vp_invalid:%');
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || '{"files":"x"}'::jsonb)); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('files not a list: no files attached, row accepted or refused cleanly', got in ('ok') or got like 'vp_invalid:%');
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || '{"files":[1,2]}'::jsonb)); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('numeric file refs refused', got like 'vp_invalid:%');
  -- same file in two rows
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('files', jsonb_build_array(fa)), row1 || jsonb_build_object('style_number','F2','files', jsonb_build_array(fa)))); got:='ok';
  exception when others then got := sqlerrm; end;
  insert into t_results values ('one file cannot be used by two rows', got like 'vp_invalid:%');
  -- good
  r := public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('files', jsonb_build_array(fa, fa2))));
  insert into t_results values ('good submit attaches both files', (select count(*) from public.vendor_files where submission_id=((r->'ids'->>0)::bigint))=2);
  insert into t_results values ('file ids are not stored inside submission data', not exists (select 1 from public.vendor_submissions where id=((r->'ids'->>0)::bigint) and data ? 'files'));
  -- reuse after attach
  begin perform public.vendor_portal_submit('S_A', jsonb_build_array(row1 || jsonb_build_object('style_number','F3','files', jsonb_build_array(fa)))); got:='ok';
  exception when others then got := sqlerrm; end;
  insert into t_results values ('attached file cannot be reused', got like 'vp_invalid:%');
  perform set_config('vp2.sub', (r->'ids'->>0), false); perform set_config('vp2.fa', fa::text, false); perform set_config('vp2.fa2', fa2::text, false);
  perform set_config('vp2.fb', fb::text, false);
end $$;

-- 5. listing
select pg_temp.expect_true('owner sees the files on their submission', (select jsonb_array_length(x->'files')=2 from jsonb_array_elements(public.vendor_portal_my_submissions('S_A')) x where (x->>'id')::bigint=current_setting('vp2.sub')::bigint));
select pg_temp.expect_true('file listing never includes the storage path', public.vendor_portal_my_submissions('S_A')::text !~ 'vendor/[0-9]+/');
select pg_temp.expect_true('other vendor sees none of it', public.vendor_portal_my_submissions('S_B')::text !~ 'one\.stl');

-- 6. update with files / remove
do $$
declare sub bigint := current_setting('vp2.sub')::bigint; fa uuid := current_setting('vp2.fa')::uuid; fa2 uuid := current_setting('vp2.fa2')::uuid; fb uuid := current_setting('vp2.fb')::uuid;
        fnew uuid; r jsonb; got text; data0 jsonb := '{"style_number":"F1","weight":1,"metal_type":"Silver","karat":"925"}'::jsonb; pth text;
begin
  fnew := pg_temp.mkfile('S_A','new.png');
  begin perform public.vendor_portal_update('S_B', sub, data0, '[]'); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('other vendor cannot update my submission or its files', got='vp_denied');
  begin perform public.vendor_portal_update('S_A', sub, data0, jsonb_build_array(fb)); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('update cannot pull in another vendor''s file', got like 'vp_invalid:%');
  insert into t_results values ('a refused update leaves the files as they were', (select count(*) from public.vendor_files where submission_id=sub and status='uploaded')=2);
  r := public.vendor_portal_update('S_A', sub, data0, jsonb_build_array(fa, fnew));
  insert into t_results values ('update swaps files', (select count(*) from public.vendor_files where submission_id=sub and status='uploaded')=2 and (select status from public.vendor_files where id=fa2)='removed');
  insert into t_results values ('update reports which objects to delete', jsonb_array_length(r->'removed_paths')=1);
  r := public.vendor_portal_update('S_A', sub, data0, null);
  insert into t_results values ('update without a file list leaves files alone', (select count(*) from public.vendor_files where submission_id=sub and status='uploaded')=2);
  begin perform public.vendor_portal_file_remove('S_B', fa); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('other vendor cannot remove my file', got='vp_denied');
  begin perform public.vendor_portal_file_remove('S_B', gen_random_uuid()); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('removing a missing file looks the same as removing someone else''s', got='vp_denied');
  pth := public.vendor_portal_file_remove('S_A', fa);
  insert into t_results values ('owner can remove an editable file and gets the path back', pth ~ '^vendor/' and (select status from public.vendor_files where id=fa)='removed');
  begin perform public.vendor_portal_file_remove('S_A', fa); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('cannot remove twice', got='vp_denied');
  -- approved item: files locked
  update public.vendor_submissions set status='approved' where id=sub;
  begin perform public.vendor_portal_file_remove('S_A', fnew); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('files on an approved item cannot be removed', got='vp_denied');
  begin perform public.vendor_portal_update('S_A', sub, data0, '[]'); got:='ok'; exception when others then got := sqlerrm; end;
  insert into t_results values ('approved item cannot be edited, files included', got='vp_denied');
end $$;

-- 6b. abandoned uploads expire
do $$
declare j jsonb; old_id uuid; j2 jsonb;
begin
  j := public.vendor_portal_file_begin('S_A','abandoned.jpg',10); old_id := (j->>'id')::uuid;
  update public.vendor_files set created_at = now() - interval '25 hours' where id = old_id;
  j2 := public.vendor_portal_file_begin('S_A','fresh.jpg',10);
  insert into t_results values ('a 25-hour-old unattached file is expired', (select status from public.vendor_files where id=old_id)='removed');
  insert into t_results values ('the expired object is reported for deletion', (j2->'stale_paths') @> to_jsonb(j->>'path'));
  insert into t_results values ('a fresh unattached file is kept', (select status from public.vendor_files where id=(j2->>'id')::uuid)='pending');
  declare fx uuid; sx jsonb; begin
    fx := pg_temp.mkfile('S_A','keep.stl');
    sx := public.vendor_portal_submit('S_A', jsonb_build_array('{"style_number":"EXP1","weight":1,"metal_type":"Silver","karat":"925"}'::jsonb || jsonb_build_object('files', jsonb_build_array(fx))));
    update public.vendor_files set created_at = now() - interval '30 hours' where id = fx;
    perform public.vendor_portal_file_begin('S_A','another.jpg',10);
    insert into t_results values ('attached files never expire', (select status from public.vendor_files where id=fx)='uploaded');
  end;
end $$;

-- 7. staff download lookup and per-vendor caps
select pg_temp.expect_true('admin lookup returns the path of an uploaded file', public.vendor_admin_file_path(current_setting('vp2.fb')::uuid) ~ '^vendor/');
select pg_temp.expect_true('admin lookup returns nothing for a removed file', public.vendor_admin_file_path(current_setting('vp2.fa')::uuid) is null);
select pg_temp.expect_true('admin lookup returns nothing for an unknown id', public.vendor_admin_file_path(gen_random_uuid()) is null);
do $$
declare i int; got text := 'ok';
begin
  begin for i in 1..40 loop perform public.vendor_portal_file_begin('S_B', 'c'||i||'.jpg', 10); end loop; exception when others then got := sqlerrm; end;
  insert into t_results values ('too many unattached files are refused', got like 'vp_invalid:%');
  insert into t_results values ('the unattached cap counts only this vendor', (select count(*) from public.vendor_files where vendor_id=current_setting('vp2.va')::int and status='pending') < 30);
end $$;

select case when ok then 'PASS' else 'FAIL' end as result, name from t_results order by ok, name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_results;

delete from public.vendor_files where vendor_id in (select id from public.vendors where name like '\_\_vp2%');
delete from public.vendor_submissions where vendor_id in (select id from public.vendors where name like '\_\_vp2%');
delete from public.vendor_accounts where vendor_id in (select id from public.vendors where name like '\_\_vp2%');
delete from public.vendors where name like '\_\_vp2%';
