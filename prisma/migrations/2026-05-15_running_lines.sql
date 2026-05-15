-- ============================================================
-- Running Lines feature — initial schema
-- Date: 2026-05-15
-- Sections: /running-lines, /purchase-orders, /back-engineering
--
-- Paste into Supabase SQL editor and run.
-- All tables are additive — does not touch existing schema.
-- No RLS added (consistent with rest of PLM; revisit org-wide).
-- ============================================================

-- ------------------------------------------------------------
-- 1. SKUs scraped from Signet SSP (Banter only for v1)
-- One row per ssp_number. Wide structured cols for the audit
-- math + raw_data jsonb for everything else.
-- ------------------------------------------------------------
create table if not exists running_line_skus (
  ssp_number               text primary key,                  -- "S82598" — Signet's id
  sku_number               text,                              -- header.skuNumber — "Product Sku", starts with 20
  vendor_style_number      text,                              -- header.vendorStyleNumber — match key vs samples.styleNumber

  brand                    text,                              -- "Banter" etc.
  description              text,
  status                   text,                              -- skuAttributes.currentStatus
  merchant                 text,
  country_of_origin        text,

  -- HTS / tariff (from header.data)
  tariff_code              text,
  tariff_code_description  text,
  tariff_percentage        numeric,                           -- Signet-stored placeholder; NOT the live tariff Brian bills at

  duty_rate                numeric,                           -- vendorCost.vendorDutyRate (typ. 5)

  -- Bottom-line cost dollars from VendorCost
  vendor_purch_cost        numeric,                           -- vendorCost.vendorPurchCost — Signet Purchase Cost
  piece_cost_subtotal      numeric,                           -- vendorCost.pieceCostSubtotal
  total_labor_cost         numeric,                           -- vendorCost.ttlAllLaborCosts
  total_material_cost      numeric,                           -- vendorCost.ttlAllMaterialCost
  total_stone_cost         numeric,                           -- vendorCost.ttlStoneCost
  total_duty_cost          numeric,                           -- vendorCost.ttlVendorDutyCost
  total_plating_cost       numeric,                           -- summed from findings.platings JSON
  tag_cost                 numeric,                           -- vendorCost.tagCost (a.k.a. ticket cost)

  -- Metal weights from metalSummary
  total_net_weight         numeric,                           -- grams
  total_gross_weight       numeric,                           -- grams

  item_count               integer,                           -- usually 1; multi-item SKUs (chains) > 1
  image_url                text,                              -- S3 presigned, ~7-day expiry; refresh strategy TBD

  -- Brian's per-SKU billing deltas (editable in the procurement-card grid)
  labor_delta              numeric default 0,                 -- labor I add ON TOP of factory labor when billing Signet
  weight_delta             numeric default 0,                 -- weight I bill ON TOP of factory weight (grams)

  note                     text,                              -- free text per SKU
  flagged                  boolean default false,             -- triage flag

  last_scraped_at          timestamptz,
  raw_data                 jsonb,                             -- full scrape blob (166-col SKUs row)
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

create index if not exists idx_rl_skus_vendor_style on running_line_skus(vendor_style_number);
create index if not exists idx_rl_skus_sku_number   on running_line_skus(sku_number);
create index if not exists idx_rl_skus_flagged      on running_line_skus(flagged) where flagged = true;


-- ------------------------------------------------------------
-- 2. Material rows — one per metal alloy per SKU
-- ------------------------------------------------------------
create table if not exists running_line_materials (
  id                       uuid primary key default gen_random_uuid(),
  ssp_number               text not null references running_line_skus(ssp_number) on delete cascade,
  item_number              integer not null,
  row_index                integer not null,

  material_type            text,
  metal_purity             text,
  metal_karat              text,
  metal_color              text,

  material_net_weight      numeric,                           -- grams
  metal_base_price         numeric,                           -- SSP placeholder (e.g. 90 for silver)
  metal_loss_percent       numeric,
  metal_cost_per_gram      numeric,
  material_cost            numeric,

  raw_data                 jsonb,
  created_at               timestamptz default now(),

  unique (ssp_number, item_number, row_index)
);

create index if not exists idx_rl_materials_ssp on running_line_materials(ssp_number);


-- ------------------------------------------------------------
-- 3. Finding rows — carries the parsed plating from data.platings
-- ------------------------------------------------------------
create table if not exists running_line_findings (
  id                       uuid primary key default gen_random_uuid(),
  ssp_number               text not null references running_line_skus(ssp_number) on delete cascade,
  item_number              integer not null,
  row_index                integer not null,

  finding_type             text,
  finding_qty              integer,
  finding_net_weight       numeric,
  finding_material_cost    numeric,

  -- parsed plating (from data.platings JSON array on FindingDetails)
  plating_material         text,
  plating_color            text,
  plating_method           text,
  plating_micron           numeric,
  plating_cost             numeric,

  raw_data                 jsonb,
  created_at               timestamptz default now(),

  unique (ssp_number, item_number, row_index)
);

create index if not exists idx_rl_findings_ssp on running_line_findings(ssp_number);


-- ------------------------------------------------------------
-- 4. Stone rows
-- ------------------------------------------------------------
create table if not exists running_line_stones (
  id                       uuid primary key default gen_random_uuid(),
  ssp_number               text not null references running_line_skus(ssp_number) on delete cascade,
  item_number              integer not null,
  row_index                integer not null,

  stone_type               text,
  category                 text,
  shape                    text,
  quantity                 integer,
  stone_cost               numeric,

  raw_data                 jsonb,
  created_at               timestamptz default now(),

  unique (ssp_number, item_number, row_index)
);

create index if not exists idx_rl_stones_ssp on running_line_stones(ssp_number);


-- ------------------------------------------------------------
-- 5. Scrape log — append-only per `npm run scrape`
-- ------------------------------------------------------------
create table if not exists running_line_scrape_log (
  id                       uuid primary key default gen_random_uuid(),
  started_at               timestamptz not null default now(),
  completed_at             timestamptz,
  sku_count                integer,
  success_count            integer,
  failure_count            integer,
  source_file              text,
  notes                    text
);


-- ------------------------------------------------------------
-- 6. Purchase orders (both directions)
--    direction='forward' = my factory PO   (what I pay)
--    direction='reverse' = Signet PO to me (what they pay me)
-- ------------------------------------------------------------
create table if not exists running_line_purchase_orders (
  id                       uuid primary key default gen_random_uuid(),
  direction                text not null check (direction in ('forward','reverse')),

  po_number                text,
  po_date                  date,
  supplier                 text,                              -- factory name for forward, "Signet/Banter" for reverse

  file_format              text check (file_format in ('A','B')),
  file_name                text,

  -- tariff applied AT THE TIME of this PO (variable; was 20%, now 10%, may be 0%)
  tariff_percent           numeric default 0,
  upcharge_percent         numeric,

  line_count               integer,
  total_amount             numeric,

  notes                    text,
  raw_data                 jsonb,                             -- whole parsed xlsx blob
  uploaded_at              timestamptz default now()
);

create index if not exists idx_rl_po_direction on running_line_purchase_orders(direction);
create index if not exists idx_rl_po_date      on running_line_purchase_orders(po_date desc);


-- ------------------------------------------------------------
-- 7. PO line items
--    For direction='reverse' POs, the back-engineering output
--    (implied_metal_rate, rate_gap, rate_gap_status) is populated
--    by the /back-engineering screen.
-- ------------------------------------------------------------
create table if not exists running_line_po_items (
  id                       uuid primary key default gen_random_uuid(),
  po_id                    uuid not null references running_line_purchase_orders(id) on delete cascade,
  line_number              integer,

  ssp_number               text,
  sku_number               text,
  vendor_style_number      text,
  description              text,

  quantity                 integer,
  unit_price               numeric,
  total_price              numeric,

  -- back-engineering output (reverse direction only)
  implied_metal_rate       numeric,                           -- $/oz that Signet's price implies
  rate_gap                 numeric,                           -- implied - PM Fix on PO date + 3 BD
  rate_gap_status          text check (rate_gap_status in ('ok','underbilled','overbilled') or rate_gap_status is null),

  raw_data                 jsonb,
  created_at               timestamptz default now()
);

create index if not exists idx_rl_po_items_po  on running_line_po_items(po_id);
create index if not exists idx_rl_po_items_ssp on running_line_po_items(ssp_number);
create index if not exists idx_rl_po_items_vsn on running_line_po_items(vendor_style_number);


-- ============================================================
-- Sanity check (run after migration):
--
--   select count(*) from running_line_skus;            -- 0 (until import.js runs)
--   select count(*) from running_line_purchase_orders; -- 0
--   \d running_line_skus                                -- inspect columns
-- ============================================================
