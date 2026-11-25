-- QuickBooks posting status for OrderStream invoices, readable by signed-in PLM users.
-- qb_invoice_posts itself stays locked (service key only); this view exposes just status.
create or replace view public.qb_invoice_status as
select j.invoice_number,
       coalesce(p.status, 'queued') as status,
       p.last_error,
       p.attempts,
       p.posted_at
from public.dropship_jobs j
left join public.qb_invoice_posts p on p.invoice_number = j.invoice_number
where j.invoice_number is not null;
revoke all on public.qb_invoice_status from anon;
grant select on public.qb_invoice_status to authenticated;
