-- 1) Fix pad_stock_status: count only open demand (the first version summed every PO line ever).
--    Open = PO not marked shipped and due no more than 30 days ago (older unmarked POs are
--    assumed shipped but never marked in the PLM).
create or replace view pad_stock_status as
with demand as (
  select m.pad_no, sum(i.quantity) as committed_units
  from running_line_po_items i
  join running_line_purchase_orders po on po.id = i.po_id
  join sku_pad_map m on m.sku_number = i.sku_number
  where po.marked_shipped_at is null
    and po.due_date >= current_date - 30
  group by m.pad_no
)
select p.pad_no, p.description, p.on_hand, p.on_order,
       coalesce(d.committed_units,0) * p.pads_per_unit as committed,
       p.on_hand + p.on_order - coalesce(d.committed_units,0) * p.pads_per_unit as projected_balance,
       p.reorder_point,
       (p.on_hand + p.on_order - coalesce(d.committed_units,0) * p.pads_per_unit) <= p.reorder_point as order_now
from pad_inventory p left join demand d using (pad_no);
alter view pad_stock_status set (security_invoker = true);

-- 2) Starting reorder points = avg weekly pad usage over the last 26 weeks (Signet PO units by
--    po_date, as of 2026-11-11) x (45-day lead time + 2 weeks safety stock) in weeks. Edit in the app.
update pad_inventory p set reorder_point = v.rp, updated_at = now()
from (values
 ('NPP-16',41086),('NPP-16GP',7491),('NPP-26',6336),('NPP-16-SB',6309),('NPP-60',5897),
 ('NPP-25',5064),('NPP-135',4449),('NPP-61',2537),('NPP-129',2360),('NPP-22',2272),
 ('NPP-23',1482),('NPP-20',1370),('NPP-367',1364),('NPP-135GP',1271),('NPP-25GP',1265),
 ('NPP-FINDINGSINSERT',425),('NPP-24',216),('NPP-80',187),('NPP-23GP',166),('NPP-22GP',124)
) as v(pad_no, rp)
where p.pad_no = v.pad_no;
