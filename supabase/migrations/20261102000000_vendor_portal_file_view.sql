-- Vendor portal, part 8: a vendor can see a small preview of their own picture files.
-- Returns the storage path of one of THIS vendor's finished picture files (up to 8 MB). Anything else
-- (someone else's file, a file still uploading, a CAD or PDF file, a missing id) gets the same denial.
-- The path is used only by the server to make a short-lived link; the browser never receives it.
-- Requires part 2 (files).

create or replace function public.vendor_portal_file_view(p_session text, p_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; pth text;
begin
  select * into r from public.vp_resolve(p_session);
  select path into pth from public.vendor_files
   where id = p_id and vendor_id = r.vendor_id and status = 'uploaded'
     and ext in ('jpg','jpeg','png','gif','webp','bmp') and size_bytes <= 8388608;
  if pth is null then raise exception 'vp_denied'; end if;
  return pth;
end $$;

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
