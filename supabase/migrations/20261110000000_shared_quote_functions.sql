-- Shared quote page for buyers: three small server functions that return/accept buyer-safe data only,
-- so the public (anon) key no longer needs direct access to quotes, lineItems, samples or images.
-- Additive: creating them changes nothing for the current app.

create or replace function public.get_shared_quote(p_quote_number text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', q.id, 'quoteNumber', q."quoteNumber", 'status', q.status, 'tags', q.tags,
    'gold', q.gold, 'silver', q.silver, 'agent', q.agent, 'buyer', q.buyer,
    'lineitems', coalesce((
      select jsonb_agg(jsonb_build_object(
               'lineItemId', li.id, 'salesPrice', li."salesPrice", 'buyerComment', li."BuyerComment",
               'product', jsonb_build_object('styleNumber', s."styleNumber", 'salesWeight', s."salesWeight", 'images', s.images))
             order by li.id)
        from public."lineItems" li
        left join public.sample_with_stones_export s on s.sample_id = li."productId"
       where li."quoteNumber" = q."quoteNumber"), '[]'::jsonb))
  from public.quotes q
  where p_quote_number is not null and char_length(p_quote_number) <= 64 and q."quoteNumber"::text = p_quote_number
  limit 1
$$;

create or replace function public.set_buyer_comment(p_quote_number text, p_line_item_id bigint, p_comment text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_quote_number is null or char_length(p_quote_number) > 64 or char_length(coalesce(p_comment, '')) > 1000 then
    raise exception 'invalid';
  end if;
  update public."lineItems" li set "BuyerComment" = p_comment
   where li.id = p_line_item_id and li."quoteNumber"::text = p_quote_number;
end $$;

create or replace function public.mark_quote_viewed(p_quote_number text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_quote_number is null or char_length(p_quote_number) > 64 then return; end if;
  update public.quotes set status = 'viewed:yellow'
   where "quoteNumber"::text = p_quote_number and status = 'Created:grey';
end $$;

revoke all on function public.get_shared_quote(text), public.set_buyer_comment(text, bigint, text), public.mark_quote_viewed(text) from public;
grant execute on function public.get_shared_quote(text), public.set_buyer_comment(text, bigint, text), public.mark_quote_viewed(text) to anon, authenticated;
