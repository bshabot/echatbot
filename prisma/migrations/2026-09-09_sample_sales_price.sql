-- Adds a per-sample sales price so it can sit next to SSP's vendorPurchCost
-- (get-vendorcost) for margin comparisons. Additive/nullable; existing rows
-- are unaffected. Surfaced through the sample_with_stones_export view so it
-- flows into the Samples import/export xlsx alongside the other cost fields.

ALTER TABLE starting_info ADD COLUMN IF NOT EXISTS "salesPrice" numeric(10,2);

-- View recreated with salesPrice appended (Postgres requires new columns to
-- be added at the end of a CREATE OR REPLACE VIEW's column list).
-- See prisma/views/public/sample_with_stones_export.sql for the current
-- full definition.
