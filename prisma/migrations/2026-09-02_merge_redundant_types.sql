-- Merge type rows that are nothing more than a spelling of their own SSP
-- category, now that starting_info.category stores that second level.
--
-- `type = hoop` and `type = earrings, category = hoop` say the identical
-- thing to Signet, so the extra row only invites drift. Every affected
-- record already carries the exact category value (verified 2026-09-02:
-- 187/187 hoop, 45/45 earring charm, 16/16 bangle, 1/1 tennis), so this is
-- a relabel, not a collapse -- what gets sent to SSP is unchanged, and the
-- split is reversible from the category value if a row is ever wanted back.
--
-- Deliberately NOT merged:
--   nose (33)        -- left as its own type, along with the body piercings row
--   Flatbacks (48)   -- "Flatbacks" is the program name, not a shape;
--                       earrings/cartilage is what Signet needs to hear
--   Clasp (13)       -- no SSP type or category at all; never sends to SSP
--   Pendant / Kids Earring / Charm -- empty, kept as history
--
-- RUN THIS ONLY AFTER the app is deployed against the type/category rename.

begin;

-- 1. Belt and braces: make sure every record about to move carries its
--    category before the row that supplied it disappears.
update starting_info si
set category = c.ssp_category
from category c
where c.id = si.type
  and si.category is null
  and c.ssp_category is not null
  and c.name in ('hoop','earring charm','bangle','tennis','fashion studs');

-- 2. Repoint the records onto the product-type row.
update starting_info si
set type = t.id
from category src, category t
where si.type = src.id
  and src.name in ('hoop','earring charm','bangle','tennis','fashion studs')
  and t.name = src.ssp_product_type;

-- samples.type is the near-dead copy, but 3 of its 9 rows point at
-- hoop/tennis -- move them too or the delete below will refuse.
update samples s
set type = t.id
from category src, category t
where s.type = src.id
  and src.name in ('hoop','earring charm','bangle','tennis','fashion studs')
  and t.name = src.ssp_product_type;

-- 3. Drop the merged rows, plus empty rows for types E. Chabot does not sell.
--    The not-exists guards mean a row still in use is left alone rather than
--    silently orphaning records.
delete from category
where name in ('hoop','earring charm','bangle','tennis','fashion studs',
               'accessories','giftware','Silver Flatbacks')
  and not exists (select 1 from starting_info si where si.type = category.id)
  and not exists (select 1 from samples s where s.type = category.id);

commit;

-- Expected after:
--   earrings 2,533 | rings 928 | charms 567 | necklaces 463 | bracelets 197
--   Flatbacks 48 | nose 33 | Clasp 13 | body piercings 0
--   Charm 0 | Kids Earring 0 | Pendant 0
--   12 rows, down from 20.
