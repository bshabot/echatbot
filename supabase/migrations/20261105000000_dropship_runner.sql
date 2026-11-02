alter table dropship_jobs
  add column if not exists prev_status text,
  add column if not exists last_step text,
  add column if not exists last_step_at timestamptz,
  add column if not exists stock_plan jsonb;

create table if not exists dropship_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
insert into dropship_settings(key, value) values ('paused', 'true'::jsonb) on conflict do nothing;
alter table dropship_settings enable row level security;
create policy "auth read settings" on dropship_settings for select to authenticated using (true);
create policy "auth update settings" on dropship_settings for update to authenticated using (true) with check (true);
