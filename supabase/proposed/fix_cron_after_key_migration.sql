-- Run AFTER deploying the functions with the CRON_SECRET secret set (see steps in chat).
-- 1) Keep the shared secret in the Vault (use the SAME value as the CRON_SECRET function secret).
select vault.create_secret('<paste the same long random string>', 'cron_secret', 'Shared secret for scheduled edge-function calls');

-- 2) UPS tracking refresh (currently failing: it sent the old, now disabled, key).
select cron.alter_job(6, command := $$
  select net.http_post(
    url := 'https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/ups-track',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);

-- 3) Metal lock sync: send the secret too (the function now checks it).
select cron.alter_job(2, command := $$
  select net.http_post(
    url := 'https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    )
  );
$$);

-- Check (no secrets shown): both jobs should now mention vault, and no eyJ key should remain.
select jobid, jobname, command ~ 'vault.decrypted_secrets' as uses_vault, command ~ 'eyJ' as has_old_key from cron.job order by jobid;
