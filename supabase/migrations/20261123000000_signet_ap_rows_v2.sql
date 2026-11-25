-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Signet AP: signet_ap_rows becomes the full 18-column Signet export, keyed by "Vim Invoice#"
-- (Signet reuses/re-keys vendor references). Changes the existing table IN PLACE.
--
-- IMPORTANT: the ~5,869 existing rows have no Vim Invoice# and cannot be backfilled, so this migration
-- DELETES them (only when the key swap hasn't happened yet). Re-upload the Signet export on the
-- Signet AP page afterwards; every row (and first_seen_at) is rebuilt from that file.
-- invoice_match_notes is NOT touched (its 34 rows stay).

alter table public.signet_ap_rows add column if not exists vendor                text;
alter table public.signet_ap_rows add column if not exists vim_invoice           text;
alter table public.signet_ap_rows add column if not exists supplier_invoice_date date;
alter table public.signet_ap_rows add column if not exists sap_invoice_number    text;
alter table public.signet_ap_rows add column if not exists sap_invoice_date      date;
alter table public.signet_ap_rows add column if not exists net_due_date          date;
alter table public.signet_ap_rows add column if not exists disc1_pct             numeric;
alter table public.signet_ap_rows add column if not exists disc1_due_date        date;
alter table public.signet_ap_rows add column if not exists disc2_pct             numeric;
alter table public.signet_ap_rows add column if not exists disc2_due_date        date;
alter table public.signet_ap_rows add column if not exists sap_payment_no        text;
alter table public.signet_ap_rows add column if not exists first_seen_at         timestamptz not null default now();
alter table public.signet_ap_rows add column if not exists last_changed_at       timestamptz not null default now();
alter table public.signet_ap_rows add column if not exists last_seen_at          timestamptz not null default now();

do $$
declare
  pk_on_vim boolean;
begin
  select exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'public.signet_ap_rows'::regclass and i.indisprimary and a.attname = 'vim_invoice'
  ) into pk_on_vim;

  if not pk_on_vim then
    delete from public.signet_ap_rows where vim_invoice is null;          -- legacy rows, see header
    alter table public.signet_ap_rows drop constraint if exists signet_ap_rows_pkey;
    alter table public.signet_ap_rows alter column vim_invoice set not null;
    alter table public.signet_ap_rows add primary key (vim_invoice);
  end if;
end $$;

-- vendor_invoice is no longer unique (Signet re-keys references) but is still how we match QB.
alter table public.signet_ap_rows alter column vendor_invoice drop not null;
create index if not exists signet_ap_rows_vendor_invoice_idx on public.signet_ap_rows(vendor_invoice);
create index if not exists signet_ap_rows_payment_idx        on public.signet_ap_rows(sap_payment_no);
create index if not exists signet_ap_rows_status_idx         on public.signet_ap_rows(status);
create index if not exists signet_ap_rows_net_due_idx        on public.signet_ap_rows(net_due_date);
