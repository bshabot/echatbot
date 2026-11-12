-- Simplified pad stock: enter the quantity on hand once (counted_at is stamped when you save it),
-- then the screen shows what's left = count minus pad units on every Signet PO dated on/after the
-- count date. Re-entering a count re-baselines from that day. Safe to re-run.
drop view if exists pad_stock_status;
create view pad_stock_status with (security_invoker = true) as
with used as (
  select m.pad_no, sum(i.quantity * p.pads_per_unit) as used
  from sku_pad_map m
  join pad_inventory p on p.pad_no = m.pad_no
  join running_line_po_items i on i.sku_number = m.sku_number
  join running_line_purchase_orders po on po.id = i.po_id
  where p.counted_at is not null
    and po.po_date >= (p.counted_at at time zone 'America/New_York')::date
  group by m.pad_no
)
select p.pad_no, p.description, p.on_hand as counted, p.counted_at,
       coalesce(u.used, 0) as used_since_count,
       p.on_hand - coalesce(u.used, 0) as remaining
from pad_inventory p left join used u using (pad_no);
