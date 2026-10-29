-- Vendor portal database security tests.
-- Run against a STAGING copy after the migration (psql -f this file as a
-- superuser/postgres role). It creates its own throwaway vendor rows and
-- cleans up. Prints PASS/FAIL lines; any FAIL means do not go live.

create temp table t_results(name text, ok boolean);
grant all on t_results to public;

create or replace function pg_temp.expect_denied(label text, stmt text, as_role text) returns void
language plpgsql as $$
declare denied boolean := false;
begin
  begin
    execute format('set local role %I', as_role);
    execute stmt;
  exception when others then denied := true;
  end;
  reset role;
  insert into t_results values (label, denied);
end $$;

create or replace function pg_temp.expect_msg(label text, stmt text, want text) returns void
language plpgsql as $$
declare got text := '';
begin
  begin execute stmt; exception when others then got := sqlerrm; end;
  insert into t_results values (label, got like want);
end $$;

create or replace function pg_temp.expect_true(label text, cond boolean) returns void
language plpgsql as $$ begin insert into t_results values (label, coalesce(cond, false)); end $$;

-- fixtures
insert into public.vendors(name) values ('__vp_test_A'), ('__vp_test_B');
do $$
declare va int; vb int; aa uuid; ab uuid; r jsonb;
begin
  select id into va from public.vendors where name = '__vp_test_A';
  select id into vb from public.vendors where name = '__vp_test_B';
  aa := public.vendor_admin_create_account(va, 'A@test.example', 'HASH_A_SECRET');
  ab := public.vendor_admin_create_account(vb, 'b@test.example', 'HASH_B_SECRET');
  perform set_config('vp.aa', aa::text, false); perform set_config('vp.ab', ab::text, false);
  perform set_config('vp.va', va::text, false);
end $$;

-- 1. direct table access denied for anon and logged-in users
select pg_temp.expect_denied('anon cannot read accounts',    'select * from public.vendor_accounts', 'anon');
select pg_temp.expect_denied('anon cannot read sessions',    'select * from public.vendor_sessions', 'anon');
select pg_temp.expect_denied('anon cannot read submissions', 'select * from public.vendor_submissions', 'anon');
select pg_temp.expect_denied('anon cannot write submissions', $q$insert into public.vendor_submissions(vendor_id,batch_id,data) values (1,gen_random_uuid(),'{}')$q$, 'anon');
select pg_temp.expect_denied('anon cannot read audit',       'select * from public.vendor_audit_log', 'anon');
select pg_temp.expect_denied('anon cannot read rate limits', 'select * from public.vendor_rate_limits', 'anon');
select pg_temp.expect_denied('staff cannot read sessions',   'select * from public.vendor_sessions', 'authenticated');
select pg_temp.expect_denied('staff cannot read rate limits','select * from public.vendor_rate_limits', 'authenticated');
select pg_temp.expect_denied('staff cannot read password hash', 'select password_hash from public.vendor_accounts', 'authenticated');
select pg_temp.expect_denied('staff cannot select * on accounts', 'select * from public.vendor_accounts', 'authenticated');
select pg_temp.expect_denied('staff cannot write accounts',  $q$update public.vendor_accounts set password_hash='x'$q$, 'authenticated');
select pg_temp.expect_denied('staff cannot insert submissions', $q$insert into public.vendor_submissions(vendor_id,batch_id,data) values (1,gen_random_uuid(),'{}')$q$, 'authenticated');

-- 2. portal and admin functions: server key only
select pg_temp.expect_denied('anon cannot call login_lookup', $q$select * from public.vendor_login_lookup('a@test.example')$q$, 'anon');
select pg_temp.expect_denied('staff cannot call login_lookup', $q$select * from public.vendor_login_lookup('a@test.example')$q$, 'authenticated');
select pg_temp.expect_denied('anon cannot call submit',  $q$select public.vendor_portal_submit('x','[]')$q$, 'anon');
select pg_temp.expect_denied('staff cannot call submit', $q$select public.vendor_portal_submit('x','[]')$q$, 'authenticated');
select pg_temp.expect_denied('staff cannot call admin_create', $q$select public.vendor_admin_create_account(1,'x@y.z','h')$q$, 'authenticated');
select pg_temp.expect_denied('anon cannot call vp_resolve', $q$select * from public.vp_resolve('x')$q$, 'anon');
select pg_temp.expect_denied('staff cannot call vp_clean_row', $q$select public.vp_clean_row('{}',1)$q$, 'authenticated');

-- 3. sessions and isolation (as the server key)
select public.vendor_session_create(current_setting('vp.aa')::uuid, 'HASH_SESS_A', 1800, 43200);
select public.vendor_session_create(current_setting('vp.aa')::uuid, 'HASH_SESS_A_OTHER', 1800, 43200);
select public.vendor_session_create(current_setting('vp.ab')::uuid, 'HASH_SESS_B', 1800, 43200);
-- first login is forced-password-change: portal calls refuse until changed
select pg_temp.expect_msg('must-change blocks portal', $q$select public.vendor_portal_info('HASH_SESS_A')$q$, 'vp_denied');
select public.vendor_change_password('HASH_SESS_A', 'HASH_A_NEW');
select public.vendor_change_password('HASH_SESS_B', 'HASH_B_NEW');
select pg_temp.expect_true('password change ends other sessions',
  (select revoked from public.vendor_sessions where session_hash='HASH_SESS_A_OTHER'));
select pg_temp.expect_msg('revoked session is denied', $q$select public.vendor_portal_info('HASH_SESS_A_OTHER')$q$, 'vp_denied');
select pg_temp.expect_msg('unknown session is denied (same error)', $q$select public.vendor_portal_info('nope')$q$, 'vp_denied');
select pg_temp.expect_true('info returns vendor name only for own vendor',
  public.vendor_portal_info('HASH_SESS_A') ->> 'vendor' = '__vp_test_A');

-- 4. submit: extras dropped, validation enforced
select public.vendor_portal_submit('HASH_SESS_A', $j$[{"style_number":"TST1","weight":1.5,"metal_type":"Silver","karat":"925",
  "salesPrice":9,"Sales Price":9,"laborCost":3,"status":"approved","sample_id":5,"id":7,"vendor_id":999,
  "stones":[{"type":"CZ","quantity":2,"cost":50}]}]$j$);
select pg_temp.expect_true('forbidden keys are dropped',
  (select not (data ?| array['salesPrice','Sales Price','laborCost','status','sample_id','id','vendor_id'])
      and (data -> 'stones' -> 0) ? 'cost' = false
     from public.vendor_submissions where data ->> 'style_number' = 'TST1'));
select pg_temp.expect_true('vendor id comes from the session, status is pending',
  (select vendor_id = current_setting('vp.va')::int and status = 'pending'
     from public.vendor_submissions where data ->> 'style_number' = 'TST1'));
select pg_temp.expect_msg('missing weight rejected', $q$select public.vendor_portal_submit('HASH_SESS_A','[{"style_number":"X","metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('bad metal rejected', $q$select public.vendor_portal_submit('HASH_SESS_A','[{"style_number":"X","weight":1,"metal_type":"Lead","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('long field rejected', format($q$select public.vendor_portal_submit('HASH_SESS_A','[{"style_number":"%s","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, repeat('a',41)), 'vp_invalid:%');
select pg_temp.expect_msg('too many rows rejected', format($q$select public.vendor_portal_submit('HASH_SESS_A','%s')$q$,
  (select jsonb_agg('{"style_number":"X","weight":1,"metal_type":"Silver","karat":"925"}'::jsonb) from generate_series(1,101))), 'vp_invalid:%');
select pg_temp.expect_msg('control chars rejected', $q$select public.vendor_portal_submit('HASH_SESS_A', jsonb_build_array(jsonb_build_object('style_number', 'A'||chr(1), 'weight',1,'metal_type','Silver','karat','925')))$q$, 'vp_invalid:%');
select pg_temp.expect_msg('too many stones rejected', format($q$select public.vendor_portal_submit('HASH_SESS_A','[{"style_number":"X","weight":1,"metal_type":"Silver","karat":"925","stones":%s}]')$q$,
  (select jsonb_agg('{"type":"CZ"}'::jsonb) from generate_series(1,11))), 'vp_invalid:%');
select public.vendor_portal_submit('HASH_SESS_A', $j$[{"style_number":"<script>alert(1)</script>","weight":2,"metal_type":"Silver","karat":"925"}]$j$);
select pg_temp.expect_true('script text is stored as inert text',
  exists(select 1 from public.vendor_submissions where data ->> 'style_number' = '<script>alert(1)</script>'));

-- 5. vendor isolation
select pg_temp.expect_true('vendor B sees none of vendor A rows',
  jsonb_array_length(public.vendor_portal_my_submissions('HASH_SESS_B')) = 0);
select pg_temp.expect_msg('B cannot edit A row', format($q$select public.vendor_portal_update('HASH_SESS_B', %s, '{"style_number":"HACK","weight":1,"metal_type":"Silver","karat":"925"}')$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1')), 'vp_denied');
select pg_temp.expect_msg('B cannot withdraw A row', format($q$select public.vendor_portal_withdraw('HASH_SESS_B', %s)$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1')), 'vp_denied');
select pg_temp.expect_msg('B cannot correct A row', format($q$select public.vendor_portal_correction('HASH_SESS_B', %s, 'x')$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1')), 'vp_denied');

-- 6. edits, versions, approved rows read-only
select public.vendor_portal_update('HASH_SESS_A', (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1'),
  '{"style_number":"TST1","weight":2.5,"metal_type":"Silver","karat":"925"}');
select pg_temp.expect_true('edit bumps version and keeps previous',
  (select version = 2 and (previous_data ->> 'weight')::numeric = 1.5 and edited_by = 'vendor'
     from public.vendor_submissions where data ->> 'style_number' = 'TST1'));
update public.vendor_submissions set status = 'approved', sample_id = 1 where data ->> 'style_number' = 'TST1';
select pg_temp.expect_msg('edit on approved row refused', format($q$select public.vendor_portal_update('HASH_SESS_A', %s, '{"style_number":"TST1","weight":9,"metal_type":"Silver","karat":"925"}')$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1')), 'vp_denied');
select pg_temp.expect_msg('withdraw on approved row refused', format($q$select public.vendor_portal_withdraw('HASH_SESS_A', %s)$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1')), 'vp_denied');
select public.vendor_portal_correction('HASH_SESS_A', (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1'), 'weight should be 2.4');
select pg_temp.expect_true('correction request stored without changing data',
  (select correction_note = 'weight should be 2.4' and (data ->> 'weight')::numeric = 2.5
     from public.vendor_submissions where data ->> 'style_number' = 'TST1'));

-- 7. lockout
select public.vendor_login_fail(current_setting('vp.ab')::uuid) from generate_series(1,5);
select pg_temp.expect_true('account locks after repeated failures',
  (select locked from public.vendor_login_lookup('b@test.example')));
select pg_temp.expect_true('unknown email returns no row (server uses dummy hash)',
  not exists(select 1 from public.vendor_login_lookup('nobody@test.example')));

-- 8. rate limiter
select pg_temp.expect_true('rate limit allows then blocks',
  (select bool_and(public.vendor_rate_check('test:rl', 3, 60) = (g <= 3)) from generate_series(1,5) g));

-- 9. disable / reset revoke sessions at once
select public.vendor_admin_set_enabled(current_setting('vp.aa')::uuid, false);
select pg_temp.expect_msg('disabled account session rejected', $q$select public.vendor_portal_info('HASH_SESS_A')$q$, 'vp_denied');
select public.vendor_admin_set_enabled(current_setting('vp.aa')::uuid, true);
select pg_temp.expect_msg('revoked by disable stays revoked', $q$select public.vendor_portal_info('HASH_SESS_A')$q$, 'vp_denied');

-- 10. expiry
select public.vendor_session_create(current_setting('vp.aa')::uuid, 'HASH_EXP', 1800, 43200);
update public.vendor_accounts set must_change_password = false;
update public.vendor_sessions set idle_expires_at = now() - interval '1 second' where session_hash = 'HASH_EXP';
select pg_temp.expect_msg('idle-expired session rejected', $q$select public.vendor_portal_info('HASH_EXP')$q$, 'vp_denied');

-- 11. audit log holds no secrets
select pg_temp.expect_true('audit log has no hashes or session ids',
  not exists(select 1 from public.vendor_audit_log where outcome ilike '%HASH%' or action ilike '%HASH%'));

-- 12. staff can still do the reviewer reads
do $$
declare n1 int; n2 int;
begin
  perform set_config('test.uid', gen_random_uuid()::text, true);
  set local role authenticated;
  select count(*) into n1 from public.vendor_submissions;
  select count(*) into n2 from (select email, enabled from public.vendor_accounts) q;
  reset role;
  insert into t_results values ('staff can read submissions', n1 > 0), ('staff can read non-secret account columns', n2 > 0);
end $$;


-- ====================================================================
-- Extended lockdown checks
-- ====================================================================

select public.vendor_session_create(current_setting('vp.aa')::uuid, 'HASH_SESS_A9', 1800, 43200);

-- 13. grants: enumerate instead of sampling, so a new object cannot slip through
select pg_temp.expect_true('anon has NO privilege of any kind on the 5 vendor tables',
  not exists (select 1 from unnest(array['vendor_accounts','vendor_sessions','vendor_submissions','vendor_audit_log','vendor_rate_limits']) t,
              unnest(array['select','insert','update','delete','truncate','references','trigger']) p
              where has_table_privilege('anon', 'public.'||t, p)));
select pg_temp.expect_true('logged-in users cannot insert, delete or truncate any vendor table',
  not exists (select 1 from unnest(array['vendor_accounts','vendor_sessions','vendor_submissions','vendor_audit_log','vendor_rate_limits']) t,
              unnest(array['insert','delete','truncate','references','trigger']) p
              where has_table_privilege('authenticated', 'public.'||t, p)));
select pg_temp.expect_true('logged-in users have no access at all to sessions and rate limits',
  not exists (select 1 from unnest(array['vendor_sessions','vendor_rate_limits']) t,
              unnest(array['select','insert','update','delete']) p
              where has_table_privilege('authenticated', 'public.'||t, p)));
select pg_temp.expect_true('password_hash is not readable or writable by anon or logged-in users',
  not has_column_privilege('anon','public.vendor_accounts','password_hash','select')
  and not has_column_privilege('authenticated','public.vendor_accounts','password_hash','select')
  and not has_column_privilege('authenticated','public.vendor_accounts','password_hash','update'));
select pg_temp.expect_true('staff cannot change protected submission columns',
  not exists (select 1 from unnest(array['vendor_id','account_id','batch_id','version','previous_data','edited_by','edited_at','correction_note','correction_at','created_at','id']) c
              where has_column_privilege('authenticated','public.vendor_submissions',c,'update')));
select pg_temp.expect_true('staff cannot change any account column',
  not exists (select 1 from information_schema.columns where table_schema='public' and table_name='vendor_accounts'
              and has_column_privilege('authenticated','public.vendor_accounts',column_name,'update')));
select pg_temp.expect_true('RLS is on for every vendor table',
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.vendor_accounts'::regclass,'public.vendor_sessions'::regclass,
   'public.vendor_submissions'::regclass,'public.vendor_audit_log'::regclass,'public.vendor_rate_limits'::regclass)));
select pg_temp.expect_true('no policy gives anon access to any vendor table',
  not exists (select 1 from pg_policies where tablename like 'vendor\_%' and ('anon' = any(roles) or 'public' = any(roles))));
select pg_temp.expect_true('identity sequences are not usable by anon or logged-in users',
  not has_sequence_privilege('anon','public.vendor_submissions_id_seq','usage')
  and not has_sequence_privilege('authenticated','public.vendor_submissions_id_seq','usage')
  and not has_sequence_privilege('anon','public.vendor_audit_log_id_seq','usage'));
select pg_temp.expect_true('vendor tables are not in any realtime publication',
  not exists (select 1 from pg_publication_tables where tablename like 'vendor\_%'));

-- 14. every vendor_* / vp_* function: server key only, definer functions pin search_path
select pg_temp.expect_true('there are at least 20 portal functions (guards against an empty check)',
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'vendor\_%' or p.proname like 'vp\_%')) >= 20);
select pg_temp.expect_true('no portal function is executable by anon, logged-in users or PUBLIC',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and (p.proname like 'vendor\_%' or p.proname like 'vp\_%')
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))));
select pg_temp.expect_true('every portal function pins search_path',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and (p.proname like 'vendor\_%' or p.proname like 'vp\_%')
       and not coalesce(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false)));
select pg_temp.expect_true('every account-facing portal function is security definer',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and (p.proname like 'vendor\_%' or p.proname like 'vp\_resolve' or p.proname like 'vp\_audit') and not p.prosecdef));

-- 15. staff are logged-in users, not vendors: they still cannot touch protected data
select pg_temp.expect_denied('staff cannot change version',          'update public.vendor_submissions set version = 99', 'authenticated');
select pg_temp.expect_denied('staff cannot move a row to another vendor', 'update public.vendor_submissions set vendor_id = 1', 'authenticated');
select pg_temp.expect_denied('staff cannot forge previous_data',     $q$update public.vendor_submissions set previous_data = '{}'$q$, 'authenticated');
select pg_temp.expect_denied('staff cannot delete submissions',      'delete from public.vendor_submissions', 'authenticated');
select pg_temp.expect_denied('staff cannot truncate submissions',    'truncate public.vendor_submissions', 'authenticated');
select pg_temp.expect_denied('staff cannot delete accounts',         'delete from public.vendor_accounts', 'authenticated');
select pg_temp.expect_denied('staff cannot read audit as anon would', 'select * from public.vendor_audit_log', 'anon');
select pg_temp.expect_denied('anon cannot use the identity sequence', $q$select nextval('public.vendor_submissions_id_seq')$q$, 'anon');
select pg_temp.expect_denied('staff cannot use the identity sequence', $q$select nextval('public.vendor_submissions_id_seq')$q$, 'authenticated');

-- 16. input attacks: spreadsheet formulas, disguised text, injection strings
select pg_temp.expect_msg('formula "=" start rejected',  $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"=cmd|calc","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('formula "+" start rejected',  $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"+1+1","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('formula "@" start rejected',  $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"@SUM(A1)","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('formula "-" start rejected',  $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"-2+3","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('formula in description rejected', $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"OK1","description":"=HYPERLINK(\"http://x\")","weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('formula in stone field rejected', $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"OK2","weight":1,"metal_type":"Silver","karat":"925","stones":[{"type":"=1+1"}]}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('bidi override rejected',      format($q$select public.vendor_portal_submit('HASH_SESS_A9', jsonb_build_array(jsonb_build_object('style_number','AB'||%L,'weight',1,'metal_type','Silver','karat','925')))$q$, chr(8238)), 'vp_invalid:%');
select pg_temp.expect_msg('zero-width space rejected',   format($q$select public.vendor_portal_submit('HASH_SESS_A9', jsonb_build_array(jsonb_build_object('style_number','AB'||%L,'weight',1,'metal_type','Silver','karat','925')))$q$, chr(8203)), 'vp_invalid:%');
select pg_temp.expect_msg('NUL / control char rejected', $q$select public.vendor_portal_submit('HASH_SESS_A9', jsonb_build_array(jsonb_build_object('style_number','AB'||chr(7),'weight',1,'metal_type','Silver','karat','925')))$q$, 'vp_invalid:%');
select pg_temp.expect_msg('negative weight rejected',    $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"N1","weight":-5,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('scientific-notation weight rejected', $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"N2","weight":"1e9","metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('array instead of row rejected',  $q$select public.vendor_portal_submit('HASH_SESS_A9','[[1,2,3]]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('nested object as text rejected', $q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":{"a":1},"weight":1,"metal_type":"Silver","karat":"925"}]')$q$, 'vp_invalid:%');
select pg_temp.expect_msg('oversized row rejected',      format($q$select public.vendor_portal_submit('HASH_SESS_A9','[{"style_number":"BIG","weight":1,"metal_type":"Silver","karat":"925","pad":"%s"}]')$q$, repeat('x', 9000)), 'vp_invalid:%');
select pg_temp.expect_msg('overlong correction note rejected', format($q$select public.vendor_portal_correction('HASH_SESS_A9', 1, %L)$q$, repeat('n', 1001)), 'vp_invalid:%');
select public.vendor_portal_submit('HASH_SESS_A9', $j$[{"style_number":"X1","description":"'); drop table public.vendor_accounts; --","weight":1,"metal_type":"Silver","karat":"925"}]$j$);
select pg_temp.expect_true('SQL injection text is stored as inert text and the table still exists',
  exists (select 1 from public.vendor_submissions where data ->> 'description' like '%drop table%') and to_regclass('public.vendor_accounts') is not null);
select public.vendor_portal_submit('HASH_SESS_A9', $j$[{"style_number":"Étoile № 1 日本","description":"Ring – 14k, 0.5µ","weight":2,"metal_type":"Gold","karat":"14K"}]$j$);
select pg_temp.expect_true('normal accented / non-Latin text is still accepted',
  exists (select 1 from public.vendor_submissions where data ->> 'style_number' = 'Étoile № 1 日本'));

-- 17. cross-vendor isolation, no oracle
create temp table t_ids as
  select (select id from public.vendor_submissions where data ->> 'style_number' = 'TST1') as a_row, 999999999::bigint as ghost;
do $$
declare e1 text := ''; e2 text := ''; aid bigint; begin
  select a_row into aid from t_ids;
  begin perform public.vendor_portal_withdraw('HASH_SESS_B', aid); exception when others then e1 := sqlerrm; end;
  begin perform public.vendor_portal_withdraw('HASH_SESS_B', 999999999); exception when others then e2 := sqlerrm; end;
  insert into t_results values ('withdraw: other vendor row vs missing row give identical error (no ID oracle)', e1 <> '' and e1 = e2);
  e1 := ''; e2 := '';
  begin perform public.vendor_portal_update('HASH_SESS_B', aid, '{"style_number":"HACK","weight":1,"metal_type":"Silver","karat":"925"}'); exception when others then e1 := sqlerrm; end;
  begin perform public.vendor_portal_update('HASH_SESS_B', 999999999, '{"style_number":"HACK","weight":1,"metal_type":"Silver","karat":"925"}'); exception when others then e2 := sqlerrm; end;
  insert into t_results values ('update: other vendor row vs missing row give identical error', e1 <> '' and e1 = e2);
  e1 := ''; e2 := '';
  begin perform public.vendor_portal_correction('HASH_SESS_B', aid, 'x'); exception when others then e1 := sqlerrm; end;
  begin perform public.vendor_portal_correction('HASH_SESS_B', 999999999, 'x'); exception when others then e2 := sqlerrm; end;
  insert into t_results values ('correction: other vendor row vs missing row give identical error', e1 <> '' and e1 = e2);
  e1 := ''; e2 := '';
  begin perform public.vendor_portal_info('not-a-session'); exception when others then e1 := sqlerrm; end;
  begin perform public.vendor_portal_info('HASH_SESS_A_OTHER'); exception when others then e2 := sqlerrm; end;
  insert into t_results values ('unknown session and revoked session give identical error', e1 <> '' and e1 = e2);
end $$;

-- 18. mass assignment: update cannot change status, vendor, version or batch through the data blob
select public.vendor_portal_submit('HASH_SESS_A9', '[{"style_number":"MA1","weight":1,"metal_type":"Silver","karat":"925"}]');
select public.vendor_portal_update('HASH_SESS_A9', (select id from public.vendor_submissions where data ->> 'style_number' = 'MA1'),
  '{"style_number":"MA1","weight":1,"metal_type":"Silver","karat":"925","status":"approved","vendor_id":999,"version":50,"sample_id":3,"review_note":"pwn","internal_note":"pwn"}');
select pg_temp.expect_true('update cannot set status, vendor, sample or notes via extra keys',
  (select status = 'pending' and vendor_id = current_setting('vp.va')::int and sample_id is null and review_note is null
          and internal_note is null and version = 1 and not (data ?| array['status','vendor_id','version','sample_id','review_note','internal_note'])
     from public.vendor_submissions where data ->> 'style_number' = 'MA1'));
-- a vendor who edits a row staff already sent back puts it back in the queue, never straight to approved
update public.vendor_submissions set status = 'needs_changes', review_note = 'fix weight' where data ->> 'style_number' = 'MA1';
select public.vendor_portal_update('HASH_SESS_A9', (select id from public.vendor_submissions where data ->> 'style_number' = 'MA1'),
  '{"style_number":"MA1","weight":1.1,"metal_type":"Silver","karat":"925"}');
select pg_temp.expect_true('resubmitting a needs-changes row returns it to pending',
  (select status = 'pending' from public.vendor_submissions where data ->> 'style_number' = 'MA1'));
-- a row being approved cannot be edited or withdrawn out from under staff
update public.vendor_submissions set status = 'approving' where data ->> 'style_number' = 'MA1';
select pg_temp.expect_msg('vendor cannot edit a row that is being approved', format($q$select public.vendor_portal_update('HASH_SESS_A9', %s, '{"style_number":"MA1","weight":9,"metal_type":"Silver","karat":"925"}')$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'MA1')), 'vp_denied');
select pg_temp.expect_msg('vendor cannot withdraw a row that is being approved', format($q$select public.vendor_portal_withdraw('HASH_SESS_A9', %s)$q$,
  (select id from public.vendor_submissions where data ->> 'style_number' = 'MA1')), 'vp_denied');

-- 19. what vendors are shown: never internal notes, hashes, other vendors, other vendors' names
update public.vendor_submissions set internal_note = 'SECRET-INTERNAL-NOTE' where data ->> 'style_number' = 'TST1';
select pg_temp.expect_true('my_submissions never returns internal notes, hashes or previous data',
  (select p !~* 'SECRET-INTERNAL|internalnote|internal_note|password|passwordhash|"previous|"vendor_id"|accountid' from (select public.vendor_portal_my_submissions('HASH_SESS_A9')::text p) q));
select pg_temp.expect_true('session / info responses contain no hash or session id',
  (select p !~* 'hash|password|HASH_SESS' from (select (public.vendor_portal_session('HASH_SESS_A9')::text || public.vendor_portal_info('HASH_SESS_A9')::text) p) q));
select pg_temp.expect_true('info shows own vendor name only, never the vendors table',
  (select p like '%__vp_test_A%' and p not like '%__vp_test_B%' and p not like '%email%' from (select public.vendor_portal_info('HASH_SESS_A9')::text p) q));
select pg_temp.expect_true('vendor B sees none of vendor A rows (after all the writes above)',
  (select p !~ 'TST1|MA1|X1' from (select public.vendor_portal_my_submissions('HASH_SESS_B')::text p) q));

-- 20. caps and housekeeping
do $$
declare i int; failed boolean := false; begin
  for i in 1..11 loop
    begin
      perform public.vendor_portal_submit('HASH_SESS_B', (select jsonb_agg(jsonb_build_object('style_number','CAP'||i||'-'||g,'weight',1,'metal_type','Silver','karat','925')) from generate_series(1,100) g));
    exception when others then failed := true; exit;
    end;
  end loop;
  insert into t_results values ('open-row cap (1000) stops a vendor from flooding staging', failed);
end $$;
do $$
declare i int; live int; acc uuid := current_setting('vp.aa')::uuid; begin
  for i in 1..14 loop perform public.vendor_session_create(acc, 'CAPSESS'||i, 1800, 43200); end loop;
  select count(*) into live from public.vendor_sessions where account_id = acc and not revoked and idle_expires_at > now();
  insert into t_results values ('at most 10 live sessions per account', live <= 10);
end $$;
select pg_temp.expect_msg('duplicate login email (any case) rejected', $q$select public.vendor_admin_create_account(1, 'A@TEST.EXAMPLE', 'h')$q$, '%duplicate%');

-- report + cleanup
select case when ok then 'PASS' else 'FAIL' end as result, name from t_results order by ok, name;
select count(*) filter (where not ok) as failures from t_results;

delete from public.vendor_submissions where vendor_id in (select id from public.vendors where name like '\_\_vp\_test%');
delete from public.vendor_accounts where vendor_id in (select id from public.vendors where name like '\_\_vp\_test%');
delete from public.vendors where name like '\_\_vp\_test%';
delete from public.vendor_rate_limits where key = 'test:rl';
