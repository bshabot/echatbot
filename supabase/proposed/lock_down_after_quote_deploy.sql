-- Run ONLY after the new ViewQuote.jsx is deployed and a shared quote link has been checked in a private window.
-- Closes the last public-key access: quotes, line items (incl. internal notes and margins), samples and images.
-- The buyer page now reads through get_shared_quote / set_buyer_comment / mark_quote_viewed.
begin;
drop policy if exists "anon access"                          on public."lineItems";
drop policy if exists "anon read only"                       on public."lineItems";
drop policy if exists "anon update buyer comment"            on public."lineItems";
drop policy if exists "Anon can read quote IDs only"         on public.quotes;
drop policy if exists "anon read only"                       on public.quotes;
drop policy if exists "anon update status and buyercomments" on public.quotes;
drop policy if exists "anon read only" on public.samples;
drop policy if exists "anon read only" on public.images;
drop policy if exists "anon read only" on public.image_link;
revoke all on public.quote_with_lineitems_and_product from anon;
revoke all on public.entity_images from anon;
commit;
