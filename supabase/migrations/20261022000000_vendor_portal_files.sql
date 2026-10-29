-- Vendor portal, part 2: CAD files per item.
-- Files go straight from the vendor's browser to a PRIVATE storage bucket using a
-- one-time signed upload URL that only the server function can mint. Nothing in
-- the browser ever holds a storage key. Staff download through short-lived signed
-- URLs minted by the vendor-admin function after it verifies their login.
-- Requires 20261019000000_vendor_portal.sql. Additive, except that vendor_portal_submit /
-- _update / _my_submissions are replaced (same names, file-aware).

-- ---------------------------------------------------------------- private bucket
-- No storage.objects policy mentions this bucket, so only the server key can touch it.
insert into storage.buckets (id, name, public, file_size_limit)
values ('vendor-uploads', 'vendor-uploads', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = 104857600;

-- ---------------------------------------------------------------- table
create table if not exists public.vendor_files (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     integer not null references public.vendors(id) on delete cascade,
  account_id    uuid references public.vendor_accounts(id) on delete set null,
  submission_id bigint references public.vendor_submissions(id) on delete set null,
  path          text not null unique,               -- bucket path; never sent to the browser
  original_name text not null,
  ext           text not null,
  size_bytes    bigint not null,
  status        text not null default 'pending' check (status in ('pending','uploaded','removed')),
  copied_at     timestamptz,                         -- set by staff once copied into the PLM CAD section
  created_at    timestamptz not null default now(),
  uploaded_at   timestamptz
);
create index if not exists vendor_files_vendor_idx on public.vendor_files (vendor_id, status);
create index if not exists vendor_files_submission_idx on public.vendor_files (submission_id);

alter table public.vendor_files enable row level security;
revoke all on public.vendor_files from anon, authenticated;
-- Staff may read everything except the storage path, and may stamp copied_at.
grant select (id, vendor_id, account_id, submission_id, original_name, ext, size_bytes, status, copied_at, created_at, uploaded_at)
  on public.vendor_files to authenticated;
grant update (copied_at) on public.vendor_files to authenticated;
create policy "staff read files" on public.vendor_files
  for select to authenticated using ((select auth.uid()) is not null);
create policy "staff update files" on public.vendor_files
  for update to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
grant all on public.vendor_files to service_role;

-- ---------------------------------------------------------------- file functions
-- Step 1: reserve a file record and its bucket path. The server then mints the upload URL.
create or replace function public.vendor_portal_file_begin(p_session text, p_name text, p_size bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; nid uuid := gen_random_uuid(); raw text; base text; e text; safe text; pth text;
  pending_n integer; total_n integer; stale text[] := '{}';
  allowed constant text[] := array['jpg','jpeg','png','gif','webp','heic','bmp','tif','tiff','pdf',
                                   'dwg','dxf','step','stp','iges','igs','sat','3dm','stl'];
begin
  select * into r from public.vp_resolve(p_session);
  raw := btrim(coalesce(p_name, ''));
  -- keep only the last path segment, drop anything that is not a plain filename character
  raw := regexp_replace(raw, '^.*[\\/]', '');
  if raw = '' or char_length(raw) > 150 or raw ~ '[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]' then
    raise exception 'vp_invalid:file name is not valid';
  end if;
  if position('.' in raw) = 0 then raise exception 'vp_invalid:file needs an extension'; end if;
  e := lower(regexp_replace(raw, '^.*\.', ''));
  if not (e = any (allowed)) then
    raise exception 'vp_invalid:that file type is not allowed';
  end if;
  if p_size is null or p_size < 1 or p_size > 104857600 then
    raise exception 'vp_invalid:file must be between 1 byte and 100 MB';
  end if;
  -- abandoned uploads (never attached to an item) expire after 24 hours; the server deletes their objects
  select coalesce(array_agg(path), '{}') into stale from public.vendor_files
   where vendor_id = r.vendor_id and submission_id is null and status in ('pending','uploaded') and created_at < now() - interval '24 hours';
  update public.vendor_files set status = 'removed'
   where vendor_id = r.vendor_id and submission_id is null and status in ('pending','uploaded') and created_at < now() - interval '24 hours';
  select count(*) filter (where status = 'pending' or (status = 'uploaded' and submission_id is null)),
         count(*) filter (where status <> 'removed')
    into pending_n, total_n
    from public.vendor_files where vendor_id = r.vendor_id;
  if pending_n >= 30 then raise exception 'vp_invalid:too many unattached files, submit or remove some first'; end if;
  if total_n >= 2000 then raise exception 'vp_invalid:file limit reached'; end if;

  base := regexp_replace(regexp_replace(raw, '\.[^.]*$', ''), '[^A-Za-z0-9_\- ]+', '_', 'g');
  base := btrim(left(base, 80));
  if base = '' then base := 'file'; end if;
  safe := base || '.' || e;
  pth := 'vendor/' || r.vendor_id || '/' || nid || '/' || replace(safe, ' ', '_');
  insert into public.vendor_files (id, vendor_id, account_id, path, original_name, ext, size_bytes)
  values (nid, r.vendor_id, r.account_id, pth, left(raw, 150), e, p_size);
  perform public.vp_audit(r.account_id, 'file_begin', e);
  return jsonb_build_object('id', nid, 'path', pth, 'stale_paths', to_jsonb(stale));
end $$;

-- Path of one of this vendor's own pending files, so the server can check the stored object.
create or replace function public.vendor_portal_file_path(p_session text, p_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; pth text;
begin
  select * into r from public.vp_resolve(p_session);
  select path into pth from public.vendor_files where id = p_id and vendor_id = r.vendor_id and status = 'pending';
  if pth is null then raise exception 'vp_denied'; end if;
  return pth;
end $$;

-- Step 2: after the browser finished uploading, the server confirms the real size from
-- storage and calls this. The browser cannot call it itself.
create or replace function public.vendor_portal_file_done(p_session text, p_id uuid, p_actual_size bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer;
begin
  select * into r from public.vp_resolve(p_session);
  update public.vendor_files
     set status = 'uploaded', uploaded_at = now(), size_bytes = p_actual_size
   where id = p_id and vendor_id = r.vendor_id and status = 'pending'
     and p_actual_size > 0 and p_actual_size <= 104857600;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'vp_denied'; end if;
end $$;

-- Remove an unattached or still-editable file. Returns the storage path so the server can
-- delete the object. Files on an approved item cannot be removed.
create or replace function public.vendor_portal_file_remove(p_session text, p_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; f public.vendor_files; st text;
begin
  select * into r from public.vp_resolve(p_session);
  select * into f from public.vendor_files where id = p_id and vendor_id = r.vendor_id and status <> 'removed' for update;
  if not found then raise exception 'vp_denied'; end if;
  if f.submission_id is not null then
    select status into st from public.vendor_submissions where id = f.submission_id;
    if st is distinct from 'pending' and st is distinct from 'needs_changes' and st is distinct from 'rejected' then
      raise exception 'vp_denied';
    end if;
  end if;
  update public.vendor_files set status = 'removed', submission_id = null where id = f.id;
  return f.path;
end $$;

-- Staff download: the vendor-admin function (after verifying the staff login) asks for the path.
create or replace function public.vendor_admin_file_path(p_file uuid)
returns text language sql security definer set search_path = public, pg_temp as $$
  select path from public.vendor_files where id = p_file and status = 'uploaded';
$$;

-- ---------------------------------------------------------------- file-aware submit / update / list
-- Attaches up to 3 uploaded, unattached files of this vendor to a submission.
create or replace function public.vp_attach_files(p_vendor integer, p_sub bigint, p_files jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare ids uuid[] := '{}'; one jsonb; n integer;
begin
  if p_files is null or jsonb_typeof(p_files) = 'null' then return; end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'vp_invalid:at most 3 files per item';
  end if;
  for one in select * from jsonb_array_elements(p_files) loop
    if jsonb_typeof(one) <> 'string' or (one #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'vp_invalid:bad file reference';
    end if;
    ids := ids || (one #>> '{}')::uuid;
  end loop;
  if cardinality(ids) = 0 then return; end if;
  if (select count(distinct x) from unnest(ids) x) <> cardinality(ids) then
    raise exception 'vp_invalid:duplicate file';
  end if;
  update public.vendor_files set submission_id = p_sub
   where id = any (ids) and vendor_id = p_vendor and status = 'uploaded'
     and (submission_id is null or submission_id = p_sub);
  get diagnostics n = row_count;
  if n <> cardinality(ids) then raise exception 'vp_invalid:a file is missing or already used'; end if;
end $$;

drop function if exists public.vendor_portal_submit(text, jsonb);
create or replace function public.vendor_portal_submit(p_session text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; i integer := 0; batch uuid := gen_random_uuid(); one jsonb; open_rows integer; ids bigint[] := '{}'; nid bigint;
        used uuid[] := '{}'; fe jsonb;
begin
  select * into r from public.vp_resolve(p_session);
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'vp_invalid:no rows';
  end if;
  if jsonb_array_length(p_rows) > 100 then
    raise exception 'vp_invalid:at most 100 rows per submit';
  end if;
  select count(*) into open_rows from public.vendor_submissions
   where vendor_id = r.vendor_id and status in ('pending','needs_changes','rejected');
  if open_rows + jsonb_array_length(p_rows) > 1000 then
    raise exception 'vp_invalid:too many open rows, wait for review';
  end if;
  for one in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    perform public.vp_clean_row(one, i);
    -- a file may only appear once across the whole call
    if jsonb_typeof(one -> 'files') = 'array' then
      if jsonb_array_length(one -> 'files') > 3 then raise exception 'vp_invalid:at most 3 files per item'; end if;
      for fe in select * from jsonb_array_elements(one -> 'files') loop
        if jsonb_typeof(fe) <> 'string' or (fe #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
          raise exception 'vp_invalid:bad file reference';
        end if;
        if (fe #>> '{}')::uuid = any (used) then raise exception 'vp_invalid:duplicate file'; end if;
        used := used || (fe #>> '{}')::uuid;
      end loop;
    end if;
  end loop;
  for one in select * from jsonb_array_elements(p_rows) loop
    insert into public.vendor_submissions (vendor_id, account_id, batch_id, data)
    values (r.vendor_id, r.account_id, batch, public.vp_clean_row(one, 0)) returning id into nid;
    ids := ids || nid;
    perform public.vp_attach_files(r.vendor_id, nid, one -> 'files');
  end loop;
  perform public.vp_audit(r.account_id, 'submit', i || ' rows');
  return jsonb_build_object('batch', batch, 'count', i, 'ids', to_jsonb(ids));
end $$;

drop function if exists public.vendor_portal_update(text, bigint, jsonb);
create or replace function public.vendor_portal_update(p_session text, p_id bigint, p_data jsonb, p_files jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; s public.vendor_submissions; dropped text[] := '{}'; keep uuid[] := '{}'; one jsonb;
begin
  select * into r from public.vp_resolve(p_session);
  select * into s from public.vendor_submissions where id = p_id and vendor_id = r.vendor_id for update;
  if not found or s.status not in ('pending','rejected','needs_changes') then
    raise exception 'vp_denied';
  end if;
  perform set_config('vp.actor', 'vendor', true);
  update public.vendor_submissions
     set data = public.vp_clean_row(p_data, 1),
         status = 'pending', reviewed_at = null
   where id = p_id;
  if p_files is not null and jsonb_typeof(p_files) = 'array' then
    if jsonb_array_length(p_files) > 3 then raise exception 'vp_invalid:at most 3 files per item'; end if;
    for one in select * from jsonb_array_elements(p_files) loop
      if jsonb_typeof(one) = 'string' and (one #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        keep := keep || (one #>> '{}')::uuid;
      end if;
    end loop;
    -- files that were attached and are no longer listed are removed; the server deletes their objects
    select coalesce(array_agg(path), '{}') into dropped
      from public.vendor_files where submission_id = p_id and status = 'uploaded' and not (id = any (keep));
    update public.vendor_files set status = 'removed', submission_id = null
     where submission_id = p_id and status = 'uploaded' and not (id = any (keep));
    perform public.vp_attach_files(r.vendor_id, p_id, p_files);
  end if;
  perform public.vp_audit(r.account_id, 'update', 'ok');
  return jsonb_build_object('removed_paths', to_jsonb(dropped));
end $$;

drop function if exists public.vendor_portal_my_submissions(text);
create or replace function public.vendor_portal_my_submissions(p_session text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select * into r from public.vp_resolve(p_session);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'batch', s.batch_id, 'data', s.data, 'status', s.status,
             'reviewNote', s.review_note, 'version', s.version,
             'correctionNote', s.correction_note, 'createdAt', s.created_at, 'editedAt', s.edited_at,
             'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.original_name, 'ext', f.ext, 'size', f.size_bytes) order by f.created_at)
                                  from public.vendor_files f where f.submission_id = s.id and f.status = 'uploaded'), '[]'::jsonb))
           order by s.created_at desc, s.id desc)
      from (select * from public.vendor_submissions
             where vendor_id = r.vendor_id and status <> 'withdrawn'
             order by created_at desc, id desc limit 1000) s
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- execute rights (same rule as part 1)
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname like 'vendor\_%' or p.proname like 'vp\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
