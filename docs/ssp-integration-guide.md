# SSP (Signet SKU Manager) Integration Guide

Reference doc for how the PLM talks to Signet's SSP / SKU Manager API. This is
the "how it works and why" companion to `docs/ssp-item-creator-handoff.md`
(the original branch/PR handoff, frozen as of 2026-09-14). This file is meant
to stay current -- update it whenever a new SSP quirk or field rule gets
confirmed, rather than starting another one-off doc.

Last updated: 2026-09-17.

## 1. What "Create in SSP" actually does

Clicking "Create in SSP" on a sample card walks through SSP's item-setup API
in a fixed order, each step gated on the previous one succeeding:

1. **Header** -- `sspSaveHeader` (product-level info: style, vendor, brand,
   country of origin/ship-to, etc.)
2. **Costing method** -- `sspSetCostingMethod` (silver/gold = "fixed with
   metal lock", brass = "fixed no metal lock")
3. **Tethers** -- `sspSetTethers`
4. **Item** -- `sspCreateItem` / `sspUpdateItem`
5. **Images** -- staged via `sspStageImage(s)`, tied to the real `sspCode`
6. **Material** -- `sspAddMaterial` / `sspUpdateMaterial`
7. **Finding** -- `sspAddFinding` / `sspUpdateFinding` (only if the sample's
   product type has a finding, e.g. bracelets/necklaces/earrings/charms)
8. **Stones** -- `sspAddStone` (create-only, no update endpoint)
9. **Labor cost** -- `sspUpdateLaborCost`
10. **Vendor cost** -- `sspUpdateVendorCost`

All of this is orchestrated in `src/utils/sspCreate.js`
(`buildSspPayloadsForSample` builds the payloads, `sendPreparedSspCreates`
sends them in order, `SspCreateProgress.jsx` renders the per-step ring). It's
resumable -- both via `localStorage` for a same-session retry and via the
sample's own `ssp_code` / `ssp_item_id` / `ssp_material_id` / `ssp_stone_ids`
columns for a retry in a different session or browser.

Every write follows **GET-first / verify-after-write**: SSP has a confirmed
"phantom success" bug where a `PUT` against a nonexistent id returns HTTP 200
`success:true` and persists nothing, so the flow never trusts a stored id
without confirming it live first, and re-GETs after every write to confirm it
actually landed.

## 2. Debugging technique: live-probing a 400

SSP's validation errors on write endpoints frequently come back as an **empty
400 body** -- no field name, no message, nothing to go on. The technique that
has worked every time this session:

1. Pull a live SSP OAuth token straight from the DB:
   ```sql
   select options::json->'sspIntegration'->>'token' from settings limit 1;
   ```
2. Write a small throwaway Node script (`~/scripts/*.mjs`) that does a raw
   `fetch` against `https://db.echabot.com/api/ssp/...` with that token, and
   run it with `node` via the device shell.
3. Isolate the failing field(s) by sending the **same payload with one field
   at a time changed** (e.g. null vs a real number) and comparing which
   combinations 400 and which succeed. Don't guess from the spec -- SSP's
   real validation rules don't always match what the UI implies.
4. Where possible, get Kevin to paste a real SKU Manager UI network capture
   (right-click -> copy request payload, or the browser devtools network tab)
   for the same operation, and diff field-by-field against what the PLM
   sends. This is the single most reliable way to find a missing field --
   it's how `isFixedNoMetalLock` was found missing from the finding payload.

Never assume a 400 means "this field is wrong" -- it can just as easily mean
"this combination of fields is incomplete" (see the finding size/labor/
material rule below).

## 3. Field-level rules and gotchas

### Finding payload
- **`size`, `laborCost`, and `findingMaterialCost` must ALL be non-null
  together.** Confirmed by isolation testing: three separate payloads, each
  with exactly one of the three left null, all 400'd with an empty body.
  Only sending all three non-null succeeds. If any of `ssp_finding_defaults`
  is missing one of these three for a given product type/category, every
  create for that combination will 400 with no useful error.
- **`isFixedNoMetalLock`** is required on the finding, same as on material.
  Computed independently in `sspCreate.js` (since `item` isn't built yet at
  that point in the function):
  `(s(sample.costing_method) || d.costingMethod) === "fixed no metal lock"`.
- `metalKarat` is `""` (empty string) on the finding, not `null` like on the
  material row.
- The flat `platingMaterial/Color/Method/Micron/Cost` fields on the finding
  itself stay empty (`0`/`""`) -- the real plating data goes in the
  `platings[]` array with `componentTab:"finding"`.
- `tetherMetalLossGrid`: a real capture showed `false`; the code still sends
  `true`. Left as-is deliberately (Kevin: "dont drop the plating just add
  the missing field" -- scope was limited to the one confirmed-missing
  field, nothing else).
- `findingMetalLossPercent` is 5. Quantity is 2 for a pair, 1 otherwise.
- `materialType` on the finding should follow the sample's own real metal,
  not a separate/different value:
  `s(sample.metal_material_type) || s(sample.finding_material_type) || null`.
- Item description gets the finding's description appended when present
  (not just for charms -- generalized to any product type with a finding).
  This is how charm bail types ("CASTED BAIL") and earring hinge details
  ("hidden / casted hinge / fixed") get communicated -- SSP has no dropdown
  for these, they're description text, confirmed against `ssp_vocabulary`
  (see section 4).

### Plating
- Two cost rates, not one flat rate: **rhodium $0.20/gram**, **silver
  plating up to $1.00/gram**. Constants `RHODIUM_PLATING_COST_PER_GRAM` and
  `SILVER_PLATING_COST_PER_GRAM` in `sspCreate.js`.
- Plating recipes like "RHD 0.75mic" or "Silver Plated 1 micron" are stored
  as two layers: a silver base/flash layer plus the real top coat. **That
  silver flash layer only makes sense when the base metal is brass** (it
  gives brass a reflective base before the top coat) -- sending it on an item
  whose base metal is already silver is wrong (this was the root cause of
  "T1 is wrong" -- a silver item got sent a redundant/incorrect silver-plating
  layer). `platingsForSample()` now filters out a silver-material layer when
  `sample.metalType` is already silver.

### Unit of measure / item size
- Rings: mandrel size -- send `ring_size` as `itemSize` (same value already
  used for `ringSizeMinimum`/`ringSizeMaximum`), not the raw `length` column.
  The sample form's Height field is hidden for rings (it doesn't apply).
- Bracelets & necklaces: **inches** -- convert stored mm via `/25.4`.
- Everything else (earrings, charms, body piercings): **mm**, sent as-is.

### Stones
- `settingType` (new): Prong / Bezel / Shared Prong / Pave, picked per-stone
  in the Stone form and sent through. SSP's real vocabulary spelling is
  lowercase "pave" (no accent) -- the PLM normalizes "pave" (accented) to
  the plain spelling before sending. Falls back to "prong" if unset.
- `type`/`cut`/`treatment` are `"NA"` (not `""`); `certificateType`/
  `certificationLab` are `[]` (not `null`); `additionalCharges` is `null`
  (not `[]`). `settingChargePerStone` and `cost` are meant to be equal.
- Create-only endpoint (`add-stone`) -- no update endpoint exists, so an
  existing stone's fields are never resent.

### Vendor cost / ticket cost / supplier pack
- Ticket cost: fixed **$0.38** (`sample.tag_cost ?? 0.38`), sent
  unconditionally (previously only set if present).
- Supplier pack: **1**, for everything (previously `piecesPerUnit`, which
  could be 2).

### Country of origin / ship-to
- Manufacturing origin (`countryOfOrigin` / `shippedFromCountry`) is always
  **VIETNAM**.
- Ship-to / sold-to (`shippedToCountry`) is always **`"USA"`** (previously
  an unconfirmed guess of `"UNITED STATES"` -- corrected).

### Costing method
- Resolved per metal: silver and gold = `"fixed with metal lock"`; brass =
  `"fixed no metal lock"`.

### Images
- Confirmed (2026-09-17 spot check) NOT currently broken -- every one of the
  10 test items showed its expected 2 images live via GET. The earlier
  "images missing" bug (already fixed once, for stones) is not recurring.
- SSP runs its own AI photo-QA scorer on every staged image
  (`qaStatus: "pass"|"fail"`, `QADetailedResponse`). A "fail" does **not**
  reject the upload -- the image still attaches and the item still saves, it
  just sits in the SKU Manager hold queue with a quality flag. This is easy
  to mistake for a real bug later, so it's surfaced as a quiet per-item
  warning in the send-results banner (no popup, no blocking dialog) rather
  than going unnoticed.

## 4. `ssp_vocabulary` -- check before adding new dropdown options

`ssp_vocabulary (field, parent, value)` holds every value SSP's real
`get-filters` API actually accepts, per field. **Before adding any new
dropdown option that will get sent to SSP, query this table first** to
confirm it's a real value -- this has already prevented one invalid addition
this session ("hidden" / "casted hinge" / "fixed" are NOT valid `findingType`
values; they turned out to be description text, not vocabulary, the same way
charm bail types are). "hinge" and "snap lock" ARE valid `findingType`
values and were added as real earring finding options.

```sql
select value from ssp_vocabulary where field = 'findingType' order by value;
```

## 5. `ssp_finding_defaults` -- how findings get their default numbers

Keyed by `(ssp_product_type, ssp_category)`, with a **unique constraint on
`(ssp_product_type, COALESCE(ssp_category, ''))`**. The one row per product
type with `ssp_category IS NULL` is the type-wide default; anything else is
a named variant (e.g. bracelets has both a `NULL` default and a specific
"box / tongue" row).

To offer a real *choice* between finding types for the same product type
(e.g. earrings: hinge vs snap lock; bracelets: lobster-oval default vs
box/tongue), each option needs its **own distinct `ssp_category` value**.
When there's no natural SSP category to key on, a synthetic key is used
(e.g. `'hinge'`, `'snap lock'`) -- always verify first that the synthetic key
doesn't collide with a real value in `ssp_product_categories`, since the
view's lookup does `COALESCE(starting_info.category, t.ssp_category)` and an
accidental collision would silently become the wrong default for real
samples.

A sample picks up a specific variant via `starting_info.category` (or
`starting_info.finding_type`, depending on the lookup path) -- if that's
never set, the sample silently falls through to the `NULL` type-wide
default, which can be wrong even when the sample's name suggests otherwise
(this bit T10-BRAC-LOBSTERBOX-test: it fell through to the generic
lobster-oval default instead of "box / tongue" because `finding_type` was
never set on that one row).

**Every option must ship with real numbers for `size`, `labor_cost`, and
`material_cost` together** (see section 3) -- a row with any of the three
still null will 400 every create that resolves to it, silently, with no
useful error message.

### Editing findings today

- **Settings -> Product Options -> the category section, per product type**
  (`src/components/Settings/SspTemplatesCard.jsx`) edits the **one
  `ssp_category IS NULL` (type-wide default) row**, and only three fields:
  `finding_type`, `finding_material_type`, `labor_cost`.
- It does **not** currently expose: `size`, `material_cost`, `net_weight`,
  `finding_description`, or any of the category-specific variant rows
  (bracelets' box/tongue vs lobster-oval, earrings' hinge vs snap lock).
  Those still need a direct SQL update. Offered to extend the UI to cover
  the full set of fields and variant rows -- say the word and it gets built.

## 6. Stale dropdown data after a DB change (the `useGenericStore` cache)

The `settings` entity -- which holds every dropdown option list, including
`stonePropertiesForm.settingType` -- is cached in the browser's `localStorage`
with a **24-hour TTL**. A change made directly in the database (e.g. adding
a new option to a dropdown's list) does **not** reach an already-open
browser session until that cache naturally expires.

Settings page now has an always-visible **Refresh** button (top of the
page, next to the "Settings" heading) that reloads dropdown options from the
server immediately, bypassing the 24h cache -- use this any time a newly
added option (a finding type, a setting type, anything in `settings.options`)
doesn't show up. Previously the only refresh mechanism was gated behind a
hard-failure state, so it never appeared for "just stale," only for
"nothing loaded at all."

## 7. Known open items

- Dropship/DS flag doesn't exist in the PLM's data model yet -- vendor cost's
  `dropshipFee` is never set (confirmed gap, proceed without it).
- Stone cost can only be pre-set for a NEW stone (no confirmed-safe update
  endpoint for an existing one).
- `SspTemplatesCard.jsx` doesn't expose the full finding field set or the
  category-specific variant rows -- direct SQL still needed for those until
  it's extended.
- Header/save has been seen to throw a generic 500 at least once, cause not
  confirmed -- worth a HAR capture from SKU Manager if it recurs.
