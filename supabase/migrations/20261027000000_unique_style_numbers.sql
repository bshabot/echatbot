-- Style numbers must be unique across everything that creates samples
-- (Import, Bulk Add, vendor portal approvals, anything else).
-- Existing duplicates (e.g. N1764E-new / N1764E-NEW) are left alone: the check only fires
-- when a row is inserted, or when its style number is changed to a different value.
-- Comparison ignores case and surrounding spaces.

create index if not exists samples_style_number_lower_idx
  on public.samples (lower(btrim("styleNumber")));

create or replace function public.samples_style_number_unique()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new."styleNumber" is null or btrim(new."styleNumber") = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and lower(btrim(new."styleNumber")) is not distinct from lower(btrim(old."styleNumber")) then
    return new;
  end if;
  if exists (
    select 1 from public.samples s
    where lower(btrim(s."styleNumber")) = lower(btrim(new."styleNumber"))
      and s.id is distinct from new.id
  ) then
    raise exception 'Style number % already exists', new."styleNumber" using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists samples_style_number_unique on public.samples;
create trigger samples_style_number_unique
  before insert or update of "styleNumber" on public.samples
  for each row execute function public.samples_style_number_unique();
