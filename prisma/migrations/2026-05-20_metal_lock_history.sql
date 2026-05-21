-- Daily silver + gold metal lock history.
-- Source of truth for "what was the metal lock on date X".
-- Used by tariff detection on PO uploads (lookup lock for po_date,
-- adjust today's piece_cost_subtotal back to that date's matrix).

create table if not exists public.metal_lock_history (
  date date primary key,
  silver_lock numeric(10,2),
  gold_lock numeric(10,2),
  source text default 'manual' check (source in ('manual', 'signet', 'scraper', 'imported')),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_metal_lock_history_date_desc on public.metal_lock_history (date desc);

-- RLS: authenticated users can read/write
alter table public.metal_lock_history enable row level security;

create policy "metal_lock_history_select" on public.metal_lock_history
  for select to authenticated using (true);

create policy "metal_lock_history_insert" on public.metal_lock_history
  for insert to authenticated with check (true);

create policy "metal_lock_history_update" on public.metal_lock_history
  for update to authenticated using (true);

create policy "metal_lock_history_delete" on public.metal_lock_history
  for delete to authenticated using (true);

-- Auto-bump updated_at on row update
create or replace function public.touch_metal_lock_history_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_metal_lock_history_touch on public.metal_lock_history;
create trigger trg_metal_lock_history_touch
  before update on public.metal_lock_history
  for each row execute function public.touch_metal_lock_history_updated_at();
