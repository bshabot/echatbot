-- Necklaces: length plus an extension (extender) in inches.
-- Additive and nullable; nothing else changes.
alter table public.starting_info
  add column if not exists extension numeric;

comment on column public.starting_info.extension is 'Necklace extender length in inches (length + extension).';
