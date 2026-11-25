-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Run after 20261123000001_signet_changes_and_runs.sql.
-- signet_deductions: one row per Signet CREDIT line (key = Vim Invoice#). Derived fields are rewritten on
-- upload; status / done_reason / note / follow_up_date / qb_txn_id belong to the team and are never overwritten
-- (the only automatic change: the row moves to Done/'repaid' when Signet pays the matching RP line).
-- signet_deduction_log: every status/note change (who, when, from, to).

create table if not exists public.signet_deductions (
  vim_invoice            text primary key,
  type                   text not null default 'unknown',
  reference              text,
  po_number              text,
  sku                    text,
  line                   text,
  amount                 numeric(12,2) not null default 0,
  status                 text not null default 'new',
  done_reason            text,
  repayment_vim_invoice  text,
  repayment_due_date     date,
  charged_before_of      text,
  linked_invoice         text,
  note                   text,
  follow_up_date         date,
  qb_txn_id              text,
  first_seen_at          timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'signet_deductions_type_chk') then
    alter table public.signet_deductions add constraint signet_deductions_type_chk
      check (type in ('price_variance','late','qc','zales_late','allowance','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signet_deductions_status_chk') then
    alter table public.signet_deductions add constraint signet_deductions_status_chk
      check (status in ('new','disputed','done'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signet_deductions_done_reason_chk') then
    alter table public.signet_deductions add constraint signet_deductions_done_reason_chk
      check (done_reason is null or done_reason in ('repaid','added_to_qb','history'));
  end if;
end $$;
create index if not exists signet_deductions_status_idx on public.signet_deductions(status);
create index if not exists signet_deductions_po_idx     on public.signet_deductions(po_number);
create index if not exists signet_deductions_ref_idx    on public.signet_deductions(reference);

create table if not exists public.signet_deduction_log (
  id          bigserial primary key,
  vim_invoice text not null,
  who         text,
  at          timestamptz not null default now(),
  from_value  text,
  to_value    text
);
create index if not exists signet_deduction_log_vim_idx on public.signet_deduction_log(vim_invoice);

alter table public.signet_deductions    enable row level security;
alter table public.signet_deduction_log enable row level security;
drop policy if exists "staff all signet_deductions" on public.signet_deductions;
create policy "staff all signet_deductions" on public.signet_deductions for all to authenticated using (true) with check (true);
drop policy if exists "staff all signet_deduction_log" on public.signet_deduction_log;
create policy "staff all signet_deduction_log" on public.signet_deduction_log for all to authenticated using (true) with check (true);

-- Carry over saved chargeback notes (best effort). Rows are normally created later, by the first upload on the
-- Signet AP page, which does the same carry-over in code; this block only matters if rows already exist.
-- Matches 'chargeback:CB#1520871' / 'chargeback:CB01520871' to reference 'CB01520871' by the digits.
-- Limits: FRT/other suffix rows are not matched; notes keyed by anything else are not matched.
update public.signet_deductions d
set note = n.note
from public.invoice_match_notes n
where coalesce(d.note, '') = ''
  and coalesce(n.note, '') <> ''
  and n.note_key like 'chargeback:%'
  and d.reference ~ '^CB0*[0-9]+$'
  and regexp_replace(substring(n.note_key from 12), '^CB\s*#?\s*0*', '') = regexp_replace(d.reference, '^CB0*', '')
  and substring(n.note_key from 12) ~ '^CB\s*#?\s*0*[0-9]+$';
