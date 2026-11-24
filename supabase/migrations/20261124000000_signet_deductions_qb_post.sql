-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Run after 20261123000002_signet_deductions.sql.
-- Posting Signet chargebacks to QuickBooks: a chargeback becomes a QB credit memo (CM# = Signet chargeback number),
-- a repaid chargeback adds a QB sales order back. These columns remember what was created so it can never be added twice.
--   qb_txn_id            QuickBooks TxnID of the credit memo (already in the table from 20261123000002)
--   qb_cm_ref            the CM# used in QuickBooks
--   qb_repayment_ref     the sales-order number used for the repayment
--   qb_repayment_txn_id  QuickBooks TxnID of the repayment sales order
--   qb_posted_by / _at   who created the credit memo and when
-- Idempotent: safe to run more than once.

alter table public.signet_deductions add column if not exists qb_txn_id            text;
alter table public.signet_deductions add column if not exists qb_cm_ref            text;
alter table public.signet_deductions add column if not exists qb_repayment_ref     text;
alter table public.signet_deductions add column if not exists qb_repayment_txn_id  text;
alter table public.signet_deductions add column if not exists qb_posted_by         text;
alter table public.signet_deductions add column if not exists qb_posted_at         timestamptz;

-- One credit memo per CM# and one repayment SO per SO# (a duplicate insert of the same number is refused by the database too).
create unique index if not exists signet_deductions_qb_cm_ref_uq on public.signet_deductions(qb_cm_ref) where qb_cm_ref is not null;
create unique index if not exists signet_deductions_qb_repayment_ref_uq on public.signet_deductions(qb_repayment_ref) where qb_repayment_ref is not null;
