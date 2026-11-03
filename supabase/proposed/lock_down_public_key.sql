-- PROPOSED, NOT APPLIED. Lives outside supabase/migrations on purpose so it cannot run by accident.
-- Goal: the public (anon) key should not be able to read the catalog, quotes or vendor list.
-- Findings came from the live security advisors and pg_policies on 2026-10-22.
--
-- Apply order: test on a Supabase branch (or in a quiet hour), click through the PLM
-- (samples, quotes, tag printing, images) and a shared quote link, then run part by part.
-- Each part is independent and wrapped in its own transaction.

-- =====================================================================
-- PART A1: no app change expected
-- =====================================================================
begin;

-- Internal functions that anyone with the public key could call via /rest/v1/rpc/...
-- audit_log_row, auto_link_first_image, enqueue_tracking_post are trigger functions
-- (triggers still run). post_tracking_to_teams and sweep_so_alerts are not used by any
-- trigger; if a cron job calls them, cron runs as postgres and is unaffected.
revoke execute on function public.audit_log_row()           from public, anon, authenticated;
revoke execute on function public.auto_link_first_image()   from public, anon, authenticated;
revoke execute on function public.enqueue_tracking_post()   from public, anon, authenticated;
revoke execute on function public.post_tracking_to_teams()  from public, anon, authenticated;
revoke execute on function public.sweep_so_alerts()         from public, anon, authenticated;

-- Wide open policy: anon could do anything on this table.
drop policy if exists "Allow all for anon" on public.ssp_api_failures;
revoke all on public.ssp_api_failures from anon;

-- Owner-run views readable by anon (they bypass RLS, so they expose whole tables).
revoke all on public.sample_with_stones_export from anon;
revoke all on public.sample_locations          from anon;

-- Anon read policies on internal catalog tables (logged-in staff keep their own policies).
drop policy if exists "anon read only" on public.starting_info;
drop policy if exists "anon read only" on public.stones;
drop policy if exists "anon read only" on public.vendors;
drop policy if exists "anon read only" on public.sample_sets;
drop policy if exists "anon read only" on public.sample_set_members;

commit;

-- =====================================================================
-- PART A2: check first. The shared-quote page may read these as anon.
-- If ViewQuote (or any public page) shows product photos or sample names, do part B first.
-- =====================================================================
-- begin;
-- drop policy if exists "anon read only" on public.samples;
-- drop policy if exists "anon read only" on public.images;
-- drop policy if exists "anon read only" on public.image_link;
-- revoke all on public.entity_images from anon;
-- commit;

-- =====================================================================
-- PART B: needs a code change in ViewQuote.jsx (buyer link page). Not written or tested.
-- Today anon can read every quote and line item (including internal notes, margin and
-- totalCost columns) and can UPDATE quotes and lineItems. Replace with two server-side
-- functions that return buyer-safe fields only:
--
--   create function public.get_shared_quote(p_quote_number text) returns jsonb
--     language plpgsql security definer set search_path = public, pg_temp ...
--     -- returns quote header + line items + image urls; NO internalNote, margin, totalCost
--
--   create function public.set_buyer_comment(p_quote_number text, p_line_id bigint, p_comment text)
--     returns void ... -- length-limited, only touches the buyer comment column
--
--   grant execute on function public.get_shared_quote(text), public.set_buyer_comment(text,bigint,text)
--     to anon, authenticated;
--
-- Then:
--   drop policy "anon access"                         on public."lineItems";
--   drop policy "anon read only"                      on public."lineItems";
--   drop policy "anon update buyer comment"           on public."lineItems";
--   drop policy "Anon can read quote IDs only"        on public.quotes;
--   drop policy "anon read only"                      on public.quotes;
--   drop policy "anon update status and buyercomments" on public.quotes;
--   revoke all on public.quote_with_lineitems_and_product from anon;
--   (and make the four views security_invoker, or revoke from anon, to clear the advisor errors)
--
-- Quote numbers should be unguessable (long random) before relying on them as the only key.

-- =====================================================================
-- Other, smaller items
-- =====================================================================
-- * Turn on "Leaked password protection" in Supabase Auth settings (staff logins).
-- * starting_info is in the realtime publication; remove it if the app does not subscribe:
--     alter publication supabase_realtime drop table public.starting_info;
-- * The product-image storage bucket is public. Fine for catalog photos, not for anything private.
-- * Set search_path on post_tracking_to_teams, sweep_so_alerts, tracking_link, enqueue_tracking_post.
