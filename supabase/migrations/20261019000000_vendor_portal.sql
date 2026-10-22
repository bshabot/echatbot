-- Vendor portal: vendors enter items through our own login, into a staging
-- table that staff approve. Additive only: no existing table is changed.
--
-- Vendors never get a Supabase session and never touch these tables. Every
-- vendor request goes Netlify function (server key) -> the vendor_* functions
-- below. Those functions are revoked from anon and authenticated, so holding
-- the public key, or being a logged-in staff user, gets nothing on them.
-- Plan: docs/vendor-portal-build-plan.md

-- ---------------------------------------------------------------- tables

create table if not exists public.vendor_accounts (
  id                   uuid primary key default gen_random_uuid(),
  vendor_id            integer not null references public.vendors(id) on delete cascade,
  email                text not null,
  password_hash        text not null,            -- argon2id, hashed in the Netlify function
  enabled              boolean not null default true,
  must_change_password boolean not null default true,
  failed_attempts      integer not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  constraint vendor_accounts_email_lower check (email = lower(email))
);
create unique index if not exists vendor_accounts_email_key on public.vendor_accounts (email);
create index if not exists vendor_accounts_vendor_idx on public.vendor_accounts (vendor_id);

create table if not exists public.vendor_sessions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.vendor_accounts(id) on delete cascade,
  session_hash  text not null unique,            -- sha256 of the cookie value; raw id never stored
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  idle_expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked       boolean not null default false
);
create index if not exists vendor_sessions_account_idx on public.vendor_sessions (account_id);

create table if not exists public.vendor_submissions (
  id            bigint generated always as identity primary key,
  vendor_id     integer not null references public.vendors(id) on delete cascade,
  account_id    uuid references public.vendor_accounts(id) on delete set null,
  batch_id      uuid not null,
  data          jsonb not null,
  status        text not null default 'pending'
                  check (status in ('pending','approving','approved','rejected','needs_changes','withdrawn')),
  review_note   text,                            -- shown to the vendor
  internal_note text,                            -- never shown to the vendor
  version       integer not null default 1,
  previous_data jsonb,
  edited_by     text not null default 'vendor' check (edited_by in ('vendor','staff')),
  edited_at     timestamptz,
  correction_note text,                          -- vendor's request on an approved row
  correction_at   timestamptz,
  sample_id     integer,                         -- resulting sample once approved
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists vendor_submissions_vendor_status_idx on public.vendor_submissions (vendor_id, status);
create index if not exists vendor_submissions_batch_idx on public.vendor_submissions (batch_id);

create table if not exists public.vendor_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  account_id  uuid,
  action      text not null,
  outcome     text not null                      -- never holds passwords or session ids
);
create index if not exists vendor_audit_log_at_idx on public.vendor_audit_log (at desc);

create table if not exists public.vendor_rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

-- ---------------------------------------------------------------- RLS / grants

-- Supabase grants new objects to anon / authenticated by default. Everything
-- below is revoked explicitly, including the identity sequences.

alter table public.vendor_accounts     enable row level security;
alter table public.vendor_sessions     enable row level security;
alter table public.vendor_submissions  enable row level security;
alter table public.vendor_audit_log    enable row level security;
alter table public.vendor_rate_limits  enable row level security;

revoke all on public.vendor_accounts, public.vendor_sessions, public.vendor_submissions,
              public.vendor_audit_log, public.vendor_rate_limits from anon, authenticated;

-- Staff (logged-in users) policies. No policy exists for anon, so anon is denied.
-- Staff can read accounts but never password_hash: column-level grant only.
grant select (id, vendor_id, email, enabled, must_change_password, failed_attempts,
              locked_until, last_login_at, created_at)
  on public.vendor_accounts to authenticated;
create policy "staff read accounts" on public.vendor_accounts
  for select to authenticated using ((select auth.uid()) is not null);

grant select on public.vendor_submissions to authenticated;
grant update (data, status, review_note, internal_note, sample_id, reviewed_at)
  on public.vendor_submissions to authenticated;
create policy "staff read submissions" on public.vendor_submissions
  for select to authenticated using ((select auth.uid()) is not null);
create policy "staff update submissions" on public.vendor_submissions
  for update to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);

grant select on public.vendor_audit_log to authenticated;
create policy "staff read audit" on public.vendor_audit_log
  for select to authenticated using ((select auth.uid()) is not null);
-- vendor_sessions and vendor_rate_limits: no policy, no grant for anyone but the server key.

-- ---------------------------------------------------------------- versioning trigger

create or replace function public.vp_submission_versioning()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.data is distinct from old.data then
    new.version       := old.version + 1;
    new.previous_data := old.data;
    new.edited_at     := now();
    new.edited_by     := case when coalesce(current_setting('vp.actor', true), '') = 'vendor'
                              then 'vendor' else 'staff' end;
  end if;
  return new;
end $$;

drop trigger if exists vp_submission_versioning on public.vendor_submissions;
create trigger vp_submission_versioning before update on public.vendor_submissions
  for each row execute function public.vp_submission_versioning();

-- ---------------------------------------------------------------- helpers (internal)

create or replace function public.vp_audit(p_account uuid, p_action text, p_outcome text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.vendor_audit_log (account_id, action, outcome)
  values (p_account, left(p_action, 60), left(p_outcome, 120));
$$;

-- Resolves a vendor session. Any invalid, expired, revoked or disabled session
-- raises the same generic error. Returns the account id and vendor id.
create or replace function public.vp_resolve(p_session text, p_allow_must_change boolean default false)
returns table (account_id uuid, vendor_id integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.vendor_sessions; a public.vendor_accounts;
begin
  select * into s from public.vendor_sessions where session_hash = p_session;
  if not found or s.revoked or s.idle_expires_at < now() or s.absolute_expires_at < now() then
    raise exception 'vp_denied';
  end if;
  select * into a from public.vendor_accounts where id = s.account_id;
  if not found or not a.enabled or (a.must_change_password and not p_allow_must_change) then
    raise exception 'vp_denied';
  end if;
  update public.vendor_sessions
     set last_seen_at = now(),
         idle_expires_at = least(s.absolute_expires_at, now() + (s.idle_expires_at - s.last_seen_at))
   where id = s.id;
  account_id := a.id; vendor_id := a.vendor_id;
  return next;
end $$;

-- Validates one submitted row against an allow-list. Unknown keys (price,
-- sample id, status, ...) are dropped. Raises vp_invalid:<reason> (safe text).
create or replace function public.vp_clean_row(p jsonb, p_idx integer)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  out jsonb := '{}'::jsonb;
  k text; v text; n numeric; st jsonb; sk text; sv text; cleaned_stones jsonb := '[]'::jsonb; one jsonb;
  text_limits constant jsonb := '{"style_number":40,"manufacturer_code":40,"type":60,"metal_type":20,
    "karat":10,"color":20,"plating":60,"detail":300,"description":500,"selling_pair":10,"back_type":20}'::jsonb;
  num_limits constant jsonb := '{"weight":10000,"length":1000,"width":1000,"height":1000}'::jsonb;
  -- control characters, DEL/C1, zero-width and bidi-override characters (used to disguise text)
  bad constant text := '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]';
  -- a value that Excel/Sheets would run as a formula if staff export it
  formula constant text := '^[=+@\-\t\r]';
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'vp_invalid:row %: not an object', p_idx;
  end if;
  if pg_column_size(p) > 8000 then
    raise exception 'vp_invalid:row %: too large', p_idx;
  end if;

  for k in select jsonb_object_keys(text_limits) loop
    v := nullif(btrim(p ->> k), '');
    if v is null then continue; end if;
    if jsonb_typeof(p -> k) not in ('string','number') then
      raise exception 'vp_invalid:row %: % must be text', p_idx, k;
    end if;
    if char_length(v) > (text_limits ->> k)::int then
      raise exception 'vp_invalid:row %: % is too long', p_idx, k;
    end if;
    if v ~ bad or v ~ formula then
      raise exception 'vp_invalid:row %: % has invalid characters', p_idx, k;
    end if;
    out := out || jsonb_build_object(k, v);
  end loop;

  for k in select jsonb_object_keys(num_limits) loop
    v := nullif(btrim(p ->> k), '');
    if v is null then continue; end if;
    if v !~ '^[0-9]{1,6}(\.[0-9]{1,4})?$' then
      raise exception 'vp_invalid:row %: % must be a number', p_idx, k;
    end if;
    n := v::numeric;
    if n > (num_limits ->> k)::numeric then
      raise exception 'vp_invalid:row %: % is out of range', p_idx, k;
    end if;
    out := out || jsonb_build_object(k, n);
  end loop;

  if not (out ? 'style_number') then
    raise exception 'vp_invalid:row %: style number is required', p_idx;
  end if;
  if coalesce((out ->> 'weight')::numeric, 0) <= 0 then
    raise exception 'vp_invalid:row %: weight is required', p_idx;
  end if;
  if not (out ? 'metal_type') or not (out ->> 'metal_type') in ('Gold','Silver','Brass') then
    raise exception 'vp_invalid:row %: metal type must be Gold, Silver or Brass', p_idx;
  end if;
  if not (out ? 'karat') or not (out ->> 'karat') in ('10K','14K','18K','22K','24K','925','Brass') then
    raise exception 'vp_invalid:row %: karat is not valid', p_idx;
  end if;
  if out ? 'color' and not (out ->> 'color') in
     ('Yellow','White','Silver','Rose','Antique','Two-Tone','Tri-Tone','Black') then
    raise exception 'vp_invalid:row %: color is not valid', p_idx;
  end if;
  if out ? 'selling_pair' then
    out := out || jsonb_build_object('selling_pair', lower(out ->> 'selling_pair'));
    if (out ->> 'selling_pair') not in ('pairs','pair','piece','single','set') then
      raise exception 'vp_invalid:row %: selling pair is not valid', p_idx;
    end if;
  end if;
  if out ? 'back_type' then
    out := out || jsonb_build_object('back_type', lower(out ->> 'back_type'));
    if (out ->> 'back_type') not in ('silicone','screw','flat','hook','crawler','none') then
      raise exception 'vp_invalid:row %: back type is not valid', p_idx;
    end if;
  end if;

  st := p -> 'stones';
  if st is not null and jsonb_typeof(st) <> 'null' then
    if jsonb_typeof(st) <> 'array' or jsonb_array_length(st) > 10 then
      raise exception 'vp_invalid:row %: stones must be a list of at most 10', p_idx;
    end if;
    for one in select * from jsonb_array_elements(st) loop
      if jsonb_typeof(one) <> 'object' then
        raise exception 'vp_invalid:row %: bad stone', p_idx;
      end if;
      declare s2 jsonb := '{}'::jsonb;
      begin
        foreach sk in array array['type','shape','color','size','notes'] loop
          sv := nullif(btrim(one ->> sk), '');
          if sv is null then continue; end if;
          if char_length(sv) > 60 or sv ~ bad or sv ~ formula then
            raise exception 'vp_invalid:row %: stone % is not valid', p_idx, sk;
          end if;
          s2 := s2 || jsonb_build_object(sk, sv);
        end loop;
        sv := nullif(btrim(one ->> 'quantity'), '');
        if sv is not null then
          if sv !~ '^[0-9]{1,4}$' then
            raise exception 'vp_invalid:row %: stone quantity is not valid', p_idx;
          end if;
          s2 := s2 || jsonb_build_object('quantity', sv::int);
        end if;
        if s2 <> '{}'::jsonb then cleaned_stones := cleaned_stones || jsonb_build_array(s2); end if;
      end;
    end loop;
    if jsonb_array_length(cleaned_stones) > 0 then
      out := out || jsonb_build_object('stones', cleaned_stones);
    end if;
  end if;
  return out;
end $$;

-- ---------------------------------------------------------------- login / session

create or replace function public.vendor_login_lookup(p_email text)
returns table (account_id uuid, password_hash text, enabled boolean, locked boolean, must_change boolean)
language sql security definer set search_path = public, pg_temp as $$
  select a.id, a.password_hash, a.enabled,
         (a.locked_until is not null and a.locked_until > now()), a.must_change_password
    from public.vendor_accounts a where a.email = lower(btrim(p_email));
$$;

-- Records a failed attempt; locks the account for a growing time after 5 misses.
create or replace function public.vendor_login_fail(p_account uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f integer;
begin
  update public.vendor_accounts set failed_attempts = failed_attempts + 1
   where id = p_account returning failed_attempts into f;
  if f >= 5 then
    update public.vendor_accounts
       set locked_until = now() + least(interval '24 hours', interval '5 minutes' * power(2, least(f - 5, 8)))
     where id = p_account;
  end if;
  perform public.vp_audit(p_account, 'login', 'fail');   -- p_account may be null (unknown email)
end $$;

create or replace function public.vendor_session_create(p_account uuid, p_hash text, p_idle_seconds integer, p_abs_seconds integer)
returns table (must_change boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.vendor_accounts;
begin
  select * into a from public.vendor_accounts where id = p_account and enabled;
  if not found then raise exception 'vp_denied'; end if;
  update public.vendor_accounts
     set failed_attempts = 0, locked_until = null, last_login_at = now() where id = p_account;
  -- housekeeping, and at most 10 live sessions per account (oldest are ended)
  delete from public.vendor_sessions where absolute_expires_at < now() - interval '7 days';
  update public.vendor_sessions set revoked = true
   where account_id = p_account and not revoked
     and id not in (select id from public.vendor_sessions
                     where account_id = p_account and not revoked order by created_at desc limit 9);
  insert into public.vendor_sessions (account_id, session_hash, last_seen_at, idle_expires_at, absolute_expires_at)
  values (p_account, p_hash, now(), now() + make_interval(secs => p_idle_seconds),
          now() + make_interval(secs => p_abs_seconds));
  perform public.vp_audit(p_account, 'login', 'ok');
  must_change := a.must_change_password;
  return next;
end $$;

create or replace function public.vendor_session_end(p_session text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid;
begin
  update public.vendor_sessions set revoked = true where session_hash = p_session returning account_id into acc;
  if acc is not null then perform public.vp_audit(acc, 'logout', 'ok'); end if;
end $$;

create or replace function public.vendor_change_password(p_session text, p_new_hash text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select * into r from public.vp_resolve(p_session, true);
  update public.vendor_accounts set password_hash = p_new_hash, must_change_password = false where id = r.account_id;
  -- every other session of this account is ended
  update public.vendor_sessions set revoked = true where account_id = r.account_id and session_hash <> p_session;
  perform public.vp_audit(r.account_id, 'password_change', 'ok');
end $$;

create or replace function public.vendor_rate_check(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare h integer;
begin
  insert into public.vendor_rate_limits as r (key, window_start, hits)
  values (left(p_key, 200), now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into h;
  if random() < 0.02 then
    delete from public.vendor_rate_limits where window_start < now() - interval '1 day';
  end if;
  return h <= p_max;
end $$;

-- ---------------------------------------------------------------- portal

-- Used by the vendor page on load: tells it whether a password change is due.
create or replace function public.vendor_portal_session(p_session text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; a public.vendor_accounts;
begin
  select * into r from public.vp_resolve(p_session, true);
  select * into a from public.vendor_accounts where id = r.account_id;
  return jsonb_build_object('mustChange', a.must_change_password, 'email', a.email);
end $$;

create or replace function public.vendor_portal_info(p_session text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; vname text;
begin
  select * into r from public.vp_resolve(p_session);
  select name into vname from public.vendors where id = r.vendor_id;
  return jsonb_build_object(
    'vendor', vname,
    'types',   coalesce((select jsonb_agg(name order by name) from public.category), '[]'::jsonb),
    'plating', coalesce((select jsonb_agg(name order by name) from public.plating), '[]'::jsonb),
    'metals', jsonb_build_object(
       'Gold',   jsonb_build_array('10K','14K','18K','22K','24K'),
       'Silver', jsonb_build_array('925'),
       'Brass',  jsonb_build_array('Brass')),
    'colors', jsonb_build_array('Yellow','White','Silver','Rose','Antique','Two-Tone','Tri-Tone','Black'),
    'sellingPair', jsonb_build_array('pairs','piece','set'),
    'backTypes', jsonb_build_array('silicone','screw','flat','hook','crawler','none')
  );
end $$;

create or replace function public.vendor_portal_submit(p_session text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; i integer := 0; batch uuid := gen_random_uuid(); one jsonb; open_rows integer; ids bigint[] := '{}'; nid bigint;
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
  -- validate everything first so a bad row rejects the whole call
  for one in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    perform public.vp_clean_row(one, i);
  end loop;
  for one in select * from jsonb_array_elements(p_rows) loop
    insert into public.vendor_submissions (vendor_id, account_id, batch_id, data)
    values (r.vendor_id, r.account_id, batch, public.vp_clean_row(one, 0)) returning id into nid;
    ids := ids || nid;
  end loop;
  perform public.vp_audit(r.account_id, 'submit', i || ' rows');
  return jsonb_build_object('batch', batch, 'count', i, 'ids', to_jsonb(ids));
end $$;

create or replace function public.vendor_portal_my_submissions(p_session text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select * into r from public.vp_resolve(p_session);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'batch', s.batch_id, 'data', s.data, 'status', s.status,
             'reviewNote', s.review_note, 'version', s.version,
             'correctionNote', s.correction_note, 'createdAt', s.created_at, 'editedAt', s.edited_at)
           order by s.created_at desc, s.id desc)
      from (select * from public.vendor_submissions
             where vendor_id = r.vendor_id and status <> 'withdrawn'
             order by created_at desc, id desc limit 1000) s
  ), '[]'::jsonb);
end $$;

create or replace function public.vendor_portal_update(p_session text, p_id bigint, p_data jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; s public.vendor_submissions;
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
  perform public.vp_audit(r.account_id, 'update', 'ok');
end $$;

create or replace function public.vendor_portal_withdraw(p_session text, p_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer;
begin
  select * into r from public.vp_resolve(p_session);
  update public.vendor_submissions set status = 'withdrawn'
   where id = p_id and vendor_id = r.vendor_id and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'vp_denied'; end if;
  perform public.vp_audit(r.account_id, 'withdraw', 'ok');
end $$;

create or replace function public.vendor_portal_correction(p_session text, p_id bigint, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer; note text := btrim(coalesce(p_note, ''));
begin
  select * into r from public.vp_resolve(p_session);
  if note = '' or char_length(note) > 1000
     or note ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]'
     or note ~ '^[=+@\-\t\r]' then
    raise exception 'vp_invalid:note is empty or too long';
  end if;
  update public.vendor_submissions set correction_note = note, correction_at = now()
   where id = p_id and vendor_id = r.vendor_id and status = 'approved';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'vp_denied'; end if;
  perform public.vp_audit(r.account_id, 'correction_request', 'ok');
end $$;

-- ---------------------------------------------------------------- staff account management
-- Called only by the vendor-admin Netlify function, after it verifies the
-- staff member's Supabase login. Hashing happens there; no function here can
-- read a password back.

create or replace function public.vendor_admin_create_account(p_vendor integer, p_email text, p_hash text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare nid uuid;
begin
  insert into public.vendor_accounts (vendor_id, email, password_hash)
  values (p_vendor, lower(btrim(p_email)), p_hash) returning id into nid;
  perform public.vp_audit(nid, 'admin_create', 'ok');
  return nid;
end $$;

create or replace function public.vendor_admin_reset_password(p_account uuid, p_hash text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.vendor_accounts
     set password_hash = p_hash, must_change_password = true, failed_attempts = 0, locked_until = null
   where id = p_account;
  update public.vendor_sessions set revoked = true where account_id = p_account;
  perform public.vp_audit(p_account, 'admin_reset', 'ok');
end $$;

create or replace function public.vendor_admin_set_enabled(p_account uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.vendor_accounts set enabled = p_enabled where id = p_account;
  if not p_enabled then update public.vendor_sessions set revoked = true where account_id = p_account; end if;
  perform public.vp_audit(p_account, case when p_enabled then 'admin_enable' else 'admin_disable' end, 'ok');
end $$;

create or replace function public.vendor_admin_revoke_sessions(p_account uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.vendor_sessions set revoked = true where account_id = p_account;
  perform public.vp_audit(p_account, 'admin_revoke_sessions', 'ok');
end $$;

-- ---------------------------------------------------------------- execute rights
-- Only the server key (service_role) may call any of these.

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

grant all on public.vendor_accounts, public.vendor_sessions, public.vendor_submissions,
             public.vendor_audit_log, public.vendor_rate_limits to service_role;

revoke all on sequence public.vendor_submissions_id_seq, public.vendor_audit_log_id_seq from public, anon, authenticated;
grant usage, select on sequence public.vendor_submissions_id_seq, public.vendor_audit_log_id_seq to service_role;
