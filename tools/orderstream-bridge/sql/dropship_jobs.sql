-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- One row per OrderStream order id. The bridge inserts new rows only; later steps move status forward.

create table if not exists public.dropship_jobs (
  order_id      text primary key,               -- OrderStream order(<id>)
  po_number     text not null,                  -- Signet PO (one PO can hold several orders)
  merchant      text not null default 'signetjewelers',
  order_date    date,
  ship_to       jsonb not null,
  items         jsonb not null,                 -- [{item_id, line, merchant_sku, vendor_sku, description, qty}]
  status        text not null default 'new'
                check (status in ('new','labeled','shipped','invoiced','stock_updated','done','error','skipped')),
  tracking      text,
  ship_method   text,                           -- OrderStream code, e.g. UG
  invoice_number text,
  error         text,
  problems      text[] not null default '{}',   -- parse warnings; non-empty = do not auto-process
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists dropship_jobs_status_idx on public.dropship_jobs(status);
create index if not exists dropship_jobs_po_idx on public.dropship_jobs(po_number);

alter table public.dropship_jobs enable row level security;

-- Staff (logged-in PLM users) can read and update. No policy for anon = denied.
-- The bridge uses the service role key, which bypasses RLS.
create policy "staff read dropship_jobs" on public.dropship_jobs
  for select to authenticated using (true);
create policy "staff update dropship_jobs" on public.dropship_jobs
  for update to authenticated using (true) with check (true);
