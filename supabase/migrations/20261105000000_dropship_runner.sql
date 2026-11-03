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

-- History (append-only): one row per runner batch, one per step attempt.
create table if not exists dropship_runs (
  run_id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  finished_at timestamptz,
  live boolean not null,
  summary text
);
create table if not exists dropship_events (
  id bigserial primary key,
  run_id uuid references dropship_runs(run_id),
  order_id text not null,
  po_number text,
  step text not null,
  outcome text not null,
  page_url text,
  request jsonb,
  response_status int,
  response_location text,
  response_excerpt text,
  invoice_number text,
  created_at timestamptz default now()
);
create index if not exists dropship_events_order on dropship_events(order_id, created_at desc);
alter table dropship_runs enable row level security;
alter table dropship_events enable row level security;
create policy "auth read runs" on dropship_runs for select to authenticated using (true);
create policy "auth read events" on dropship_events for select to authenticated using (true);
