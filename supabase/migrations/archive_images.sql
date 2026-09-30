-- PROPOSED - needs Brian's approval before applying.
-- Lookup of archive photos in R2 (keys are bucket paths, e.g. archive/legacy/N617P-AUG.jpg).
create table if not exists public.archive_images (
  style  text not null,
  r2_key text primary key
);
create index if not exists archive_images_style_idx on public.archive_images (style);
alter table public.archive_images enable row level security;
create policy "archive_images read" on public.archive_images
  for select to authenticated using (true);
-- Load archive_r2_keys.csv (columns: style, r2_key; 23,501 rows) via admin/SQL import, not from the app.
