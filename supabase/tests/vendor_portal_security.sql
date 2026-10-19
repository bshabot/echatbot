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

-- report + cleanup
select case when ok then 'PASS' else 'FAIL' end as result, name from t_results order by ok, name;
select count(*) filter (where not ok) as failures from t_results;

delete from public.vendor_submissions where vendor_id in (select id from public.vendors where name like '\_\_vp\_test%');
delete from public.vendor_accounts where vendor_id in (select id from public.vendors where name like '\_\_vp\_test%');
delete from public.vendors where name like '\_\_vp\_test%';
delete from public.vendor_rate_limits where key = 'test:rl';
