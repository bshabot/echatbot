-- Daily cron: scrape Signet metal locks and upsert into metal_lock_history.
-- Runs every weekday at 6:00am America/New_York (= 10:00 UTC standard / 11:00 UTC DST).
-- We schedule against UTC since pg_cron uses UTC; pick 11:00 UTC = 6am EST / 7am EDT,
-- which covers both DST and standard time within 1 hour of the morning window.

-- Enable extensions (idempotent)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule any prior job with the same name (lets us re-run this migration safely)
do $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'daily-metal-lock-sync';
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
end $$;

-- Replace EDGE_FUNCTION_URL + SERVICE_ROLE_KEY with real values BEFORE running.
-- After deploying the function, the URL will be:
--   https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync
-- The Authorization header needs the project's service role key (or anon key
-- if the function is published with --no-verify-jwt).

select cron.schedule(
  'daily-metal-lock-sync',
  '0 11 * * 1-5',  -- 11:00 UTC, Mon-Fri (= 6am EST / 7am EDT)
  $$
  select net.http_post(
    url := 'https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Sanity check
select jobid, jobname, schedule, command from cron.job where jobname = 'daily-metal-lock-sync';
