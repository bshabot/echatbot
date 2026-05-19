-- ============================================================
-- Add per-finding metal-price fields to running_line_findings
-- Date: 2026-05-16
-- Why: each finding (earring back, jump ring, etc.) has its own
--      metal weight + base price. When metal moves, the finding's
--      material cost moves too. We need these fields to compute
--      the full metal-price delta per SKU (not just the main material).
--
-- Paste into Supabase SQL editor and run. Idempotent.
-- ============================================================

alter table running_line_findings
  add column if not exists metal_base_price   numeric,
  add column if not exists metal_loss_percent numeric,
  add column if not exists metal_purity       text;

-- Same for chains (necklace chains carry metal that also moves with price)
create table if not exists running_line_chains (
  id                       uuid primary key default gen_random_uuid(),
  ssp_number               text not null references running_line_skus(ssp_number) on delete cascade,
  item_number              integer not null,
  row_index                integer not null,

  chain_type               text,
  material_type            text,
  metal_purity             text,
  metal_karat              text,
  metal_color              text,

  chain_net_weight         numeric,
  metal_base_price         numeric,
  metal_loss_percent       numeric,
  chain_material_cost      numeric,

  raw_data                 jsonb,
  created_at               timestamptz default now(),

  unique (ssp_number, item_number, row_index)
);

create index if not exists idx_rl_chains_ssp on running_line_chains(ssp_number);
