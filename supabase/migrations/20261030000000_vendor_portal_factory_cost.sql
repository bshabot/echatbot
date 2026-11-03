-- Vendor portal, part 5: vendors can enter their factory cost per piece (factory_cost, up to 10000).
-- Allow-list change only; the rest repeats part 4. Requires parts 1 to 4.

create or replace function public.vp_clean_row(p jsonb, p_idx integer)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  out jsonb := '{}'::jsonb;
  k text; v text; n numeric; st jsonb; sk text; sv text; cleaned_stones jsonb := '[]'::jsonb; one jsonb;
  text_limits constant jsonb := '{"style_number":40,"manufacturer_code":40,"type":60,"metal_type":20,
    "karat":10,"color":20,"plating":60,"detail":300,"description":500,"selling_pair":10,"back_type":20}'::jsonb;
  num_limits constant jsonb := '{"weight":10000,"length":1000,"width":1000,"height":1000,"ring_size":100,"extension":100,"factory_cost":10000}'::jsonb;
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

  -- Vendors identify an item by their manufacturer code; the style number is assigned by E. Chabot
  -- at approval. Older rows that only carry a style number stay valid.
  if not (out ? 'manufacturer_code') and not (out ? 'style_number') then
    raise exception 'vp_invalid:row %: manufacturer code is required', p_idx;
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
