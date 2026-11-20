-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Invoice Match screen (/invoice-match): saved notes + the saved Signet AP export,
-- so the page doesn't reset and you don't re-upload every visit.

-- One row per Signet payment-export line. Re-uploading upserts (newer export wins).
create table if not exists public.signet_ap_rows (
  vendor_invoice text primary key,            -- "Vendor Invoice#" (our QB invoice #, or CB0152...[FRT])
  type           text not null,               -- INVOICE | CREDIT
  status         text,                        -- PAID | APPROVED
  po_number      text,
  amount         numeric(12,2) not null,
  posting_date   date,
  payment_date   date,
  uploaded_at    timestamptz not null default now()
);
create index if not exists signet_ap_rows_posting_idx on public.signet_ap_rows(posting_date);

-- Free-text note + resolved flag per invoice / chargeback.
-- note_key = '<section>:<number>', e.g. 'invoice:692350', 'chargeback:CB#1520871'.
create table if not exists public.invoice_match_notes (
  note_key    text primary key,
  note        text not null default '',
  resolved    boolean not null default false,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.signet_ap_rows enable row level security;
alter table public.invoice_match_notes enable row level security;

-- Staff (logged-in PLM users) only. No policy for anon = denied.
create policy "staff all signet_ap_rows" on public.signet_ap_rows
  for all to authenticated using (true) with check (true);
create policy "staff all invoice_match_notes" on public.invoice_match_notes
  for all to authenticated using (true) with check (true);
