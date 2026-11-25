-- NOT APPLIED. Review, then run in the PLM Supabase project (ujwdpieleyuaiammaopj).
-- Invoice issues tab: reuse invoice_match_notes with keys 'issue:<type>:<key>'.
-- linked_ref = QB invoice number stored by "Mark matched"; issue_status = open | disputed | done.
alter table public.invoice_match_notes add column if not exists linked_ref   text;
alter table public.invoice_match_notes add column if not exists issue_status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_match_notes_issue_status_chk') then
    alter table public.invoice_match_notes add constraint invoice_match_notes_issue_status_chk
      check (issue_status is null or issue_status in ('open','disputed','done'));
  end if;
end $$;
