-- Vendor names are unique (case/whitespace-insensitive). Backs the duplicate guard in the
-- Add Vendor forms: a double submit or retry hits this index (23505) instead of inserting twice.
-- Already applied to the live project after removing the unreferenced duplicate test vendors.
create unique index if not exists vendors_name_unique_ci
  on public.vendors (lower(btrim(name)));
