-- Cache the data-confidence score on the PO row so the list view can show
-- it without recomputing per-row. POLinesView writes this when the modal
-- opens and computes summary.confidence.
alter table public.running_line_purchase_orders
  add column if not exists confidence_score numeric(5,2);

create index if not exists idx_po_confidence_score
  on public.running_line_purchase_orders (confidence_score);
