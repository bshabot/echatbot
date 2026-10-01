-- Sample sets: one product card that links 2+ samples (e.g. studs + necklace)
-- so they can later be created as ONE SSP with several items.
-- Additive only: no existing table or view is changed. A sample can belong to
-- at most one set; `position` becomes the SSP itemId order (1, 2, ...).

create table if not exists public.sample_sets (
  id           bigint generated always as identity primary key,
  style_number text not null,
  name         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists sample_sets_style_number_key
  on public.sample_sets (lower(style_number));

create table if not exists public.sample_set_members (
  set_id     bigint  not null references public.sample_sets(id) on delete cascade,
  sample_id  integer not null references public.samples(id)     on delete cascade,
  position   smallint not null check (position >= 1),
  created_at timestamptz not null default now(),
  primary key (set_id, sample_id),
  unique (sample_id),
  unique (set_id, position)
);
create index if not exists sample_set_members_set_idx on public.sample_set_members (set_id);

alter table public.sample_sets        enable row level security;
alter table public.sample_set_members enable row level security;

-- Same access rules as public.samples
create policy "anon read only" on public.sample_sets
  for select to anon using (true);
create policy "authenticated full access" on public.sample_sets
  for all to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);

create policy "anon read only" on public.sample_set_members
  for select to anon using (true);
create policy "authenticated full access" on public.sample_set_members
  for all to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
