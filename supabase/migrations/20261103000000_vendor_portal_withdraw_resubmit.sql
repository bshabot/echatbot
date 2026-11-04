-- Withdrawn items stay in the vendor's list and can be edited and resubmitted.

drop function if exists public.vendor_portal_update(text, bigint, jsonb);
create or replace function public.vendor_portal_update(p_session text, p_id bigint, p_data jsonb, p_files jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; s public.vendor_submissions; dropped text[] := '{}'; keep uuid[] := '{}'; one jsonb;
begin
  select * into r from public.vp_resolve(p_session);
  select * into s from public.vendor_submissions where id = p_id and vendor_id = r.vendor_id for update;
  if not found or s.status not in ('pending','rejected','needs_changes','withdrawn') then
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
             where vendor_id = r.vendor_id
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
