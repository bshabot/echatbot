-- Lock the staff side away from the public (anon) key, and so from vendors.
-- Found by the 2026-11 pen test. Safe to run: the staff app uses signed-in (authenticated)
-- sessions, which keep every right below. The buyer quote page keeps its three functions.

-- 1) Storage: anyone with the public key could list, upload, overwrite and delete files in
--    the echatbot bucket's "public" and "idea-images" folders. Signed-in staff keep full
--    access through "uthenticated full access to echatbot bucket". Public image URLs still work.
drop policy if exists "Give anon users access to JPG images in folder b2hh7u_0" on storage.objects;
drop policy if exists "Give anon users access to JPG images in folder b2hh7u_1" on storage.objects;
drop policy if exists "Give anon users access to JPG images in folder b2hh7u_2" on storage.objects;
drop policy if exists "Give anon users access to JPG images in folder b2hh7u_3" on storage.objects;
drop policy if exists "Give annonumysusers access to JPG images in folder b2hh7u_0" on storage.objects;
drop policy if exists "Give annonumysusers access to JPG images in folder b2hh7u_1" on storage.objects;
drop policy if exists "Give annonumysusers access to JPG images in folder b2hh7u_2" on storage.objects;
drop policy if exists "Give annonumysusers access to JPG images in folder b2hh7u_3" on storage.objects;

-- 2) Staff-only database functions: the public key could run the price-sync functions
--    (they call outside websites and write metal prices).
revoke execute on function public.run_china_price_sync()            from public, anon;
revoke execute on function public.refresh_china_silver_lock(date)   from public, anon;
revoke execute on function public.fetch_sge_silver(date)            from public, anon;
revoke execute on function public.fetch_usd_cny(date)               from public, anon;
revoke execute on function public.tracking_link(text)               from public, anon;
revoke execute on function public.get_distinct_metals()             from public, anon;
revoke execute on function public.get_dropdown_options()            from public, anon;
revoke execute on function public.fetch_designs_with_images(integer, integer, bigint[], bigint[], text) from public, anon;

grant execute on function public.run_china_price_sync()            to authenticated, service_role;
grant execute on function public.refresh_china_silver_lock(date)   to authenticated, service_role;
grant execute on function public.fetch_sge_silver(date)            to authenticated, service_role;
grant execute on function public.fetch_usd_cny(date)               to authenticated, service_role;
grant execute on function public.tracking_link(text)               to authenticated, service_role;
grant execute on function public.get_distinct_metals()             to authenticated, service_role;
grant execute on function public.get_dropdown_options()            to authenticated, service_role;
grant execute on function public.fetch_designs_with_images(integer, integer, bigint[], bigint[], text) to authenticated, service_role;

-- 3) Future functions are not public by default.
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;

-- Check: only the three buyer-quote functions should remain.
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
order by 1;

-- 4) daily-metal-lock-sync edge function (run AFTER setting the CRON_SECRET secret and
--    redeploying the function): make the schedule send the secret.
--    supabase secrets set CRON_SECRET=<long random string>
--    supabase functions deploy daily-metal-lock-sync
-- select cron.alter_job(2, command := $$
--   select net.http_post(
--     url := 'https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync',
--     headers := '{"Content-Type": "application/json", "x-cron-secret": "<same string>"}'::jsonb);
-- $$);
