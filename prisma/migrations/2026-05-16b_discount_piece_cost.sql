-- ============================================================
-- Add discount_piece_cost_subtotal to running_line_skus
-- Date: 2026-05-16
-- Why: piece_cost_subtotal misses signet's vendor discount.
--      discountPieceCostSubtotal = pieceCostSubtotal + vendorDiscountCcy
--      (discount is typically negative — so discount_piece < piece)
--      Using this as the recompute baseline gets us closer to signet's
--      actual billing total.
--
-- Paste into Supabase SQL editor. Idempotent.
-- ============================================================

alter table running_line_skus
  add column if not exists discount_piece_cost_subtotal numeric,
  add column if not exists vendor_discount_ccy          numeric,
  add column if not exists vendor_discount_perc         numeric,
  add column if not exists overcost_ccy                 numeric,
  add column if not exists overcost_perc                numeric;
