-- NOT APPLIED. Run after 20261119000000_invoice_match.sql (safe to run either way).
-- Per-row status for the Invoice Match screen (currently just 'ready').
alter table public.invoice_match_notes add column if not exists status text;
