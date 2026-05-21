-- Daily cron: fetch LBMA metal locks and upsert into metal_lock_history.
-- Runs every weekday at 11pm America/New_York local (approx).
-- pg_cron uses UTC; 03:00 UTC = 11pm EDT (prev day) / 10pm EST (prev day).
-- Day-of-week is 2-6 (Tue-Sat UTC) because 11pm Mon-Fri local crosses midnight UTC.
-- DST drift: schedule stays at 03:00 UTC year-round; local time shifts by 1 hour in winter.

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

-- Edge function is published with --no-verify-jwt, so no Authorization header needed.

select cron.schedule(
  'daily-metal-lock-sync',
  '0 3 * * 2-6',  -- 03:00 UTC, Tue-Sat (= 11pm EDT / 10pm EST, Mon-Fri local)
  $$
  select net.http_post(
    url := 'https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Sanity check
select jobid, jobname, schedule, command from cron.job where jobname = 'daily-metal-lock-sync';
