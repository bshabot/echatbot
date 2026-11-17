-- ALREADY APPLIED 2026-11-17 (kept for the record).
-- Scheduled jobs now authenticate to edge functions with a secret that lives only in the Vault.
-- Functions check it through public.check_cron_secret(text), callable only by service_role.
select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'cron_secret', 'Shared secret for scheduled edge-function calls');

create or replace function public.check_cron_secret(p text) returns boolean
language sql stable security definer set search_path = public, vault, pg_temp as $$
  select p is not null and length(p) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p)
$$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- ups-tracking-refresh (job 6) and daily-metal-lock-sync (job 2) send the secret from the Vault:
--   headers := jsonb_build_object('Content-Type','application/json',
--     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))
