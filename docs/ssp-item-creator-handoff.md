# E. Chabot PLM → Signet SSP Item-Setup Integration — Branch Docs

Working doc for the `ssp-item-creator` branch of `bshabot/echatbot`. Originally written 2026-09-09, updated 2026-09-14 ahead of the pull request. Everything below reflects the live state of the database and code as of that date — verify against the repo/DB before trusting stale numbers.

## Project

- Repo: `bshabot/echatbot`, branch `ssp-item-creator` (tracks remote `ssp-item-creator-1`).
- Supabase project: `ujwdpieleyuaiammaopj` ("Echatbot").
- Goal: make the PLM able to correctly create/update items in Signet's SSP portal (SKU Manager) — header, item, material, finding, labor cost, vendor cost, stones — using real captured API payloads as ground truth, and a Signet-vocabulary system in the PLM so users pick real SSP values instead of inventing them. Also ships a standalone spreadsheet-driven CLI (`tools/ssp-item-creator/`) for bulk creation outside the app.

## What's in this PR, at a glance

- The in-app "Create in SSP" button on a sample card now creates the full item — header, item, material, finding, labor cost, vendor cost, and stones — with a live progress ring on the card showing which step is running, succeeded, or failed.
- A same-origin proxy (`netlify/functions/ssp-proxy.mjs`) forwards these calls to SSP's real API with a browser-matching header set (worked around CORS and, eventually, a request-routing quirk — see Known-bugs-fixed below).
- Every write follows a GET-first / verify-after-write pattern to defend against SSP's confirmed "phantom success" behavior (a PUT against a nonexistent id returns `success:true` and persists nothing).
- A standalone CLI tool (`tools/ssp-item-creator/`) does the same thing from a spreadsheet for bulk creation — see its own `README.md`.

## SSP API conventions (confirmed from real captured traffic)

- **Create vs update**: create = POST to a collection path (mints a new row, ignores any id in the body). Update = PUT to a path with the id in the URL, same payload shape plus the id field.
- **Phantom-success bug**: `PUT .../item/{id}/material/{materialId}` (and finding, by extension) against a nonexistent id returns HTTP 200 `success:true` with the payload echoed back, but persists nothing. Defense used everywhere: always GET live components first, never trust a stored id, and verify-after-write by GETting again post-PUT/POST.
- **204 vs error**: SSP legitimately answers a GET with plain HTTP 204 when the item has no data yet for that component (e.g. no materials, no stones) — this is not an error and must be treated as an empty result, not retried or surfaced as a failure (see Known-bugs-fixed below; this bit us hard before we understood it).
- **Finding payload gotchas**: `metalKarat` is `""` (empty string) on the finding, not `null` like on the material row. Flat `platingMaterial/Color/Method/Micron/Cost` fields on the finding stay empty (0/""); the real plating data goes in the `platings[]` array with `componentTab:"finding"`. `findingMetalLossPercent` is 5. Quantity is **2 for a pair, 1 for everything else**.
- **Finding metal cost**: derived from the finding's own weight, same formula as the material row: `ppg = lockPrice × purity ÷ 31.1`; `loss = weight × ppg × 5/95`; fixing allowance = 1% of lock price.
- **Labor cost payload**: nests everything under `model:{}`, `userType:"internal"` (lowercase), `itemId` as a STRING.
- **Vendor cost payload**: also nests under `model:{}`, but `userType:"INTERNAL"` (uppercase) and `itemId` as a NUMBER — a different convention from labor cost despite the similar shape. Real fields confirmed 2026-09-10 (S192244 capture): `pieceCostSubtotal`, `overcostCcy`/`overcostPerc`, `discountOvercostCcy`/`Perc`, `vendorDiscountCcy`/`Perc`, `dropshipFee`, `tagQty`/`tagCost`, `vdrPackagingDesc`/`Cost`, `vendorPurchCost` (the final computed total), `fixedCost`, `costValuation`. For a `costValuation: "fixed"` item, `vendorPurchCost` mirrors `fixedCost` directly — `overcostCcy` and the discount/reimbursement fields do not feed into it at all in that mode.
- **Stone payload**: create-only endpoint confirmed (`add-stone`); no update endpoint captured, so an existing stone's fields are never resent (same phantom-success caution as items). Field shape confirmed 2026-09-14 against a real capture: `type`/`cut`/`treatment` are `"NA"` (not `""`), `certificateType`/`certificationLab` are `[]` (not `null`), `additionalCharges` is `null` (not `[]`). `settingChargePerStone` and `cost` are meant to be equal (confirmed, not a placeholder gap).
- **Costing method**: resolved per metal, not one global default. Silver and gold = `"fixed with metal lock"`; brass = `"fixed no metal lock"`.
- **unitOfMeasure**: varies by type, not hardcoded. Rings = `"mandrel size"`; bracelets/necklaces = `"inches"`; earrings/charms/body piercings = `"mm"`.
- **Metal purity/karat**: `metalPurity` and (for gold) `metalKarat` both send the numeric millesimal fineness code — 925 for silver, 417 for 10K, 585 for 14K, 750 for 18K — not a `"10k"`-style label. Confirmed against real DB values (`samples.karat` stores `"10K"`/`"14K"`).
- **productCategories**: a single value is fine — does not need to be an array.

## Known bugs found and fixed on this branch (2026-09-10 through 2026-09-14)

These are worth a reviewer's attention because a couple of them were initially misdiagnosed:

1. **The recurring "error decoding lambda response ... unexpected end of JSON input" 502 on materials GET was OUR bug, not SSP's.** SSP legitimately answers with plain HTTP 204 when an item has no materials yet. Our own Netlify proxy (`ssp-proxy.mjs`) tried to relay that response as `new Response(text, { status: 204 })` — but the Fetch spec forbids any body (even an empty string) on a null-body status (204/205/304), so the proxy itself threw on every single one of these, and Netlify's Lambda-hosted runtime reported that crash back as a garbled 502 that read exactly like an SSP-side failure. Fixed by passing `null` instead of the text body for 204/205/304 responses.
2. **Missing `x-data-source: SSP` header.** The proxy already spoofs most of a real browser's header set to get through SSP's gateway (accept, origin, referer, user-agent, sec-ch-ua*, sec-fetch-*), but was missing this one header present on every real SKU Manager request. Added.
3. **Progress ring visibility.** The ring was geometrically hidden under its own button's background (radius math had it drawing entirely inside the button's circle), and separately reported "active" only after image staging finished rather than from the start of the click — both fixed.
4. **Stale staged-image cache key.** The image-staging cache was keyed only on `(sourceUrl, filename)`, not `sspCode` — if a sample's sspCode ever changed while its source photos stayed the same, a stale image reference from the old product could get reused. Fixed by keying on sspCode too.

## Getting `vendorPurchCost` to match a sales price

This took several iterations to land on the right approach, worth documenting so it isn't re-litigated:

- **Rejected**: writing directly to the vendor-cost tab's own adjustment fields (`overcostCcy`, `fixedCost`, `vendorDiscountPerc`/`Ccy` — "Vendor Reimbursement Rate %"/"Vendor Reimbursement Dollar" in the UI, `vdrPackagingCost`) to force a match after the item is created. All four were tried and explicitly rejected — these are meant to reflect real vendor terms, not be used as a slush fund to hit a price.
- **Current approach**: adjust the cost of a **new** stone (one not yet created in SSP this run) *before* it's first sent, spreading the gap between the sales price and the pre-stone `vendorPurchCost` across the stone's quantity. This uses a field the flow already sends normally, just computed to land closer to the target. An already-created stone is never rewritten (no confirmed-safe update endpoint). If there are no new stones available to adjust, the gap is reported as a warning, not forced — this is a best-effort "get as close as you can," not a guaranteed exact match.

## Schema (Supabase project `ujwdpieleyuaiammaopj`)

### Renames (completed)
What the PLM called "category" is actually SSP's **product type**. Renamed:
- `starting_info.category` → `starting_info.type` (FK into the `category` table)
- `starting_info.ssp_category` → `starting_info.category` (SSP's second-level free text)
- `samples.category` → `samples.type`
- Dropped `starting_info.ssp_product_type` (now derived from the type row)
- The `category` TABLE itself was **not** renamed or dropped — it holds the type list (earrings, rings, charms, bracelets, necklaces, body piercings, nose, Flatbacks, Clasp) plus SSP defaults per type.

### Three-piece SSP defaults design
1. **Material** — `ssp_metal_defaults`, keyed `(metal_type, karat)`: Silver/925, Gold/10K, Gold/14K, Brass. Also carries `costing_method`.
2. **Category/Type** — the `category` table, extended with stone/setting/finding/labor/vendor-cost columns and `unit_of_measure`, `finishing_type`, `finishing_cost`.
3. **Plating** — `plating_layers`, one-to-many off `plating` (SSP's `platings[]` is an array — e.g. "BPT + GPT" = two coats). Each layer has material, color, method, micron, cost, coverage.

### Vocabulary tables (so a dropdown can never send an invalid SSP value)
- `ssp_vocabulary (field, parent, value)` — seeded from real captured `get-filters` responses, ~129 values across ~14 fields.
- `ssp_product_categories (product_type, category)` — 169 raw pairs from SSP's `item/get-filters`.

### `ssp_finding_defaults`, by product type/category — see the table in the code comments in `sspCreate.js` for current live values (earrings, charms, bracelets fallback + tennis). Bracelet lobster finding still needs a real size/labor/material cost — flagged, not yet supplied.

### `ssp_api_failures` (new, 2026-09-10)
Logs failed SSP GET calls during Create in SSP — which call, whether the item was freshly created that run, elapsed time since the previous step, HTTP status, and error text. Added to diagnose the 502 pattern above; kept in place for future debugging.

### Costing rules (ceilings vs fixed values — do not confuse the two)
- Ticket cost: **ceiling** 0.38 (warn if over, never send as a value).
- Assembly charge: **ceiling** 0.75 (warn if over).
- Metal loss: **ceiling** 5% (warn if over).
- Casting cost: **variable by item, intentionally no default** — left null everywhere.
- Finishing: **fixed value** — all items get "high polish", cost 1.
- Dropship: **fixed value** 1.50 when dropshipped, on vendor cost's `dropshipFee`. **Still not wired in** — there is no dropship/DS flag anywhere in the PLM's data model yet (known gap, confirmed with Kevin 2026-09-10 — proceed without it for now).

## Key code

- **`src/utils/sspClient.js`** — thin wrappers per SSP endpoint (`sspSaveHeader`, `sspSetCostingMethod`, `sspSetTethers`, `sspCreateItem`, `sspUpdateItem`, `sspAddMaterial`, `sspUpdateMaterial`, `sspGetItemMaterials`, `sspAddStone`, `sspStageImage(s)`, `sspGetHeader`, `sspGetItemFilters`, `sspGetItemFindings`, `sspAddFinding`, `sspUpdateFinding`, `sspUpdateLaborCost`, `sspGetLaborCost`, `sspUpdateVendorCost`, `sspGetVendorCost`). `sspRequest` retries idempotent GETs 3x (~1.3s total backoff) on 502/503/504; writes are never retried (they already follow the GET-first/verify pattern, and blindly retrying a write risks duplicate-item creation).
- **`src/utils/sspCreate.js`** — the main payload-building/orchestration file. `buildSspPayloadsForSample` builds every component's payload from a sample row; `prepareSspCreatesForSamples` batches that; `sendPreparedSspCreates` does the actual sends in order (header → item → material → finding → labor → vendor cost → stones), reporting step-by-step progress via an `onProgress` callback, and resumable via both `localStorage` (same-session retry) and the sample's own `ssp_code`/`ssp_item_id`/`ssp_material_id`/`ssp_stone_ids` columns (durable across sessions/browsers).
- **`src/components/SspCreateProgress.jsx`** — the progress ring on the sample card's kebab button. One continuous ring fills more green per completed step (not separate arc segments), turns red and stops on failure, and shows a pulsing "starting" sliver during the gap before the first real step reports in.
- **`netlify/functions/ssp-proxy.mjs`** — same-origin proxy to `api.skumanager.cloud.jewels.com`, forwarding a browser-matching header set plus the caller's bearer token.

## Views
`sample_with_stones_export` (and the dependent `quote_with_lineitems_and_product`) join in `unit_of_measure`, `costing_method`, `salesPrice`, and a two-tier finding-default lookup.

## Status as of 2026-09-14

**Built and working:**
- Header, item, material, finding, labor cost, vendor cost, and stones all send with the GET-first/verify-after-write pattern.
- Per-step progress ring on the sample card, resumable creates (won't mint duplicate SSP products on retry).
- Gold purity/karat now sends the correct numeric fineness code.

**Known, documented gaps (not blocking, but real):**
- Dropship/DS flag doesn't exist in the PLM's data model — vendor cost's `dropshipFee` is never set.
- Stone cost can only be pre-set for a NEW stone (not yet created in SSP) — there is no confirmed-safe way to update an existing stone's cost after the fact.
- Bracelet lobster finding defaults (size/labor/material cost) still need real numbers.
- Header/save has been seen to throw a generic 500 (`"Exception occured during product header Save"`) at least once, cause not yet confirmed — worth a HAR capture from SKU Manager if it recurs.

## Open questions / needs a decision from Brian
- Whether to replace the PLM's category list with SSP's 8 product types outright (would merge Earring/Hoops/Studs/Flatbacks/Kids Earring into one "earrings" row, repointing ~4,773 `starting_info` records). Interim choice made 2026-09-02: rename category rows to SSP wording only, no merging, no repointing.
- Which SSP category the flatback program maps to (body piercings/labret vs earrings/cartilage).
- No clean SSP equivalent yet identified for Pendant, Clasp, Kids Earring.
