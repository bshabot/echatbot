-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Run after 20261123000000_signet_ap_rows_v2.sql.
-- signet_ap_changes: what Signet changed between uploads (repricing, status, payment, due date).
-- signet_payment_runs: one row per SAP Payment#. Totals are derived on upload; status/qb_txn_id/approved_*
-- are user-owned and never overwritten by the upload.

create table if not exists public.signet_ap_changes (
  id          bigserial primary key,
  vim_invoice text not null,
  field       text not null,
  old_value   text,
  new_value   text,
  changed_at  timestamptz not null default now()
);
create index if not exists signet_ap_changes_vim_idx on public.signet_ap_changes(vim_invoice);
create index if not exists signet_ap_changes_at_idx  on public.signet_ap_changes(changed_at desc);

create table if not exists public.signet_payment_runs (
  sap_payment_no  text primary key,
  payment_date    date,
  invoice_total   numeric(14,2) not null default 0,
  deduction_total numeric(14,2) not null default 0,
  net_paid        numeric(14,2) not null default 0,
  line_count      integer not null default 0,
  status          text not null default 'new',
  qb_txn_id       text,
  approved_by     text,
  approved_at     timestamptz
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'signet_payment_runs_status_chk') then
    alter table public.signet_payment_runs
      add constraint signet_payment_runs_status_chk check (status in ('new','approved','posted'));
  end if;
end $$;
create index if not exists signet_payment_runs_date_idx on public.signet_payment_runs(payment_date desc);

alter table public.signet_ap_changes   enable row level security;
alter table public.signet_payment_runs enable row level security;
drop policy if exists "staff all signet_ap_changes" on public.signet_ap_changes;
create policy "staff all signet_ap_changes" on public.signet_ap_changes for all to authenticated using (true) with check (true);
drop policy if exists "staff all signet_payment_runs" on public.signet_payment_runs;
create policy "staff all signet_payment_runs" on public.signet_payment_runs for all to authenticated using (true) with check (true);
