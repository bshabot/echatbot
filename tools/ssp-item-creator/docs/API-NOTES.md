# SSP item-setup API — field notes

Source: HAR capture of a real item setup in SKU Manager (2026-08-04, test
product **S180933**, charm, material + finding, no stones). Base URL:
`https://api.skumanager.cloud.jewels.com`. Auth: Microsoft Entra bearer
token (short-lived — same token the ssp-scraper pastes into `auth.json`).

## Creation flow (in order)

| # | Call | Purpose |
|---|------|---------|
| 1 | `POST /v1/ssp/product/header/save` | Creates the product. One payload carries the whole header (~35 fields: vendor, style, brand, buyer, countries, duty rates, MOQ, lead time, polybag, images). Response `data.sspCode` = the new SSP number. |
| 2 | `POST /v1/ssp/product/costing-method/update-costing-method/{ssp}/{method}` | Sets costing method, e.g. `fixed with metal lock` (URL-encoded). Empty `{}` body. |
| 3 | `PUT /v1/ssp/product/{ssp}/items/tether?userName=...` | Tether toggles (metal-loss / diamond-pricing / overcost matrices). |
| 4 | `POST /v1/ssp/product/{ssp}/item?userName=...` | Creates the item. Carries type, categories, description, weights, dims, size, quantityType, supplierPack, `productComponent` (list of tabs the item will have: `Finding` / `Material` / `Stone` / `Chain`). Response `data.itemId`. |
| 5 | `POST /v1/ssp/product/{ssp}/item/{id}/material?userName=...` | One call per material row. Plating rides inside as a nested `platings[]` block. |
| 6 | `POST /v1/ssp/product/{ssp}/item/{id}/finding?userName=...` | One call per finding row. Same plating block, `componentTab: "finding"`. |
| 7 | `PUT /v1/ssp/product/{ssp}/item/{id}/update-laborcost` | Labor tab: castings, assembly, labor/gram, finish rows. Response returns the computed totals. |

## Lookups / validation (read-only, optional)

- `POST /v1/ssp/product/header/get-filters` — every header dropdown (buyers, countries, polybag sizes...). ~53 KB.
- `GET  /v1/ssp/product/{ssp}/item/get-filters`, `.../material/get-filters`, `.../finding/get-filters` — item/component vocabularies.
- Ceiling checks the UI fires before saves (informational; server enforces anyway):
  - `POST .../costing-method/{ssp}/item/{id}/material/goldPlatingCostCeiling`
  - `POST .../costing-method/{ssp}/item/{id}/laborcost/castingCostCeiling`
  - `POST .../costing-method/{ssp}/item/{id}/laborcost/finishingCostCeilings`
- Read-back: `GET .../{ssp}/header`, `.../item/{id}`, `.../item/{id}/materials|findings`, `.../item/{id}/get-laborcost`, `GET .../product/can-edit/{ssp}`.

## Quirks (copy the UI, don't "fix" it)

- `userType` is `EXTERNAL` on header/tether calls but `INTERNAL` on item /
  material / finding, and lowercase `internal` on update-laborcost. Replicated as-is.
- The item payload misspells origin: `manufacturedCountryOfOrgin`.
- `metalPurity` came through as `583` on the material but `585` on the
  finding in the same 14k product — SSP accepted both.
- Ring size min/max were `"1"`/`"1"` even for a charm.
- The finding response had an inner `data.success: false` with empty
  message while the outer `success` was `true` — the finding was in fact
  created (confirmed by the follow-up GET). Treat outer `success` as truth.
- The HAR was exported sanitized, so the auth header itself wasn't
  captured; header name/scheme are configurable in `config.json`
  (defaults `Authorization: Bearer <token>` — match whatever the
  ssp-scraper sends).

## Images — captured 2026-08-25 (HAR: two images added to S180933)

Two independent AWS services are involved, plus SSP's own bucket. Per
image, in order:

| # | Call | Purpose |
|---|------|---------|
| 1 | `POST https://w0ilpcdyd6.execute-api.us-east-2.amazonaws.com/prod/presigned-url` — body `{filename, contentType}` | AI image-QA tool's own presigned upload slot. No auth header captured (cross-site, unauthenticated from the browser). Response: `{success, data:{uploadUrl, key, bucket, expiresAt}}`. |
| 2 | `PUT <uploadUrl>` — raw image bytes, header `Content-Type` matching step 1's `contentType` | Uploads to `prod-merch-ai-image-quality-tool-us-east-2`, key `Image upload/User/<ts>-<filename>`. |
| 3 | `POST https://w0ilpcdyd6.execute-api.us-east-2.amazonaws.com/prod/quality-analysis` — body `{images:[{s3Key, filename}]}` | Scores the just-uploaded image. Response: `{success, data:{validatedImages:[{inputData:{s3Key,filename,id}, resultData:{id, validationStatus, score, validationDescription, validationErrors}}]}}`. In the capture: `validationStatus:"success"`, `score:100`. |
| 4 | `POST /v1/ssp/presigned-url/generateUrl` (SSP API, needs the SSP bearer token) — body is a **bare JSON string**, not an object: `"tempSspImages/<sspCode-or-NEW>_<epoch-ms>.jpg"` | Response: `{data: "<presigned PUT url>", success}`. |
| 5 | `PUT <that url>` — same image bytes | Lands in SSP's own bucket `signet-sku-manager-upload-bucket-production`, key `tempSspImages/...` — this is the `imageUrl` value the header payload references. |

Repeat all five steps per image (the capture did this twice, back to
back, for a 2-image product). The header/save call that actually
attaches the images wasn't in this capture (it ends right after step 5
on the second image), so the exact `images[]` entry shape is carried
over from earlier reverse-engineering of the header payload, not
re-verified here: `{imageUrl: "tempSspImages/...", isPrimary, qaStatus,
QADetailedResponse}` — `qaStatus` is presumably step 3's
`validationStatus` and `QADetailedResponse` presumably wraps its
`score`/`validationDescription`; treat this one field as a best-effort
guess until a save-with-images HAR confirms it.

E. Chabot has at most one real product photo in R2 per style (silver
sample photographed, recolored to gold). SSP wants at least two images —
send the same file twice under two different filenames when only one
source image exists, mirroring what the UI itself did in the capture
(`GVC121-AM_-_Copy_-_Copy.jpg` / `GVC121-AM_-_Copy.jpg`).

## Stones — captured 2026-08-25 (HAR: one CZ stone added to S180933)

```
POST /v1/ssp/product/{ssp}/item/{itemId}/stone/add-stone
```

Real payload (a 17mm round cubic zirconia, bead-set):

```json
{
  "sspNumber": "S180933", "skuNumber": null, "itemId": 1,
  "isPrimaryStone": false,
  "category": "cubic zirconia", "type": "NA",
  "stoneMillimeter": "17", "shape": "round", "cut": "NA",
  "color": "white", "clarity": "AA",
  "stonePricingMethod": "Per Piece", "quantity": 1,
  "pricePerCarat": 0, "cost": 0.2,
  "minimumCaratWeightPerStone": 0, "minimumTotalCaratWeight": 0,
  "billWeightCaratPerStone": 0, "totalStoneCost": 0.2,
  "certificateType": [], "certificationLab": [],
  "settingLocation": "VIETNAM", "settingType": "bead", "settingMethod": "hand_wax",
  "settingChargePerStone": 0.2, "totalBillWeightCaratStone": 0, "totalSettingCost": 0.2,
  "countryOfOrigin": "VIETNAM", "treatment": "NA", "additionalCharges": null,
  "userName": "Brian@echabot.com", "userType": "EXTERNAL"
}
```

Response mirrors the request plus an assigned `stoneId`. Note `cost` ==
`settingChargePerStone` in the recorded example, and `totalStoneCost` /
`totalSettingCost` = `cost` × `quantity`.

Vocab (`GET /item/{id}/stone/get-filters`), the parts relevant to us —
category `cubic zirconia` (~99% of our stones): shapes include round,
oval, pear, square, heart, baguette, marquise, cushion...; `type` is
always `"NA"` for this category; `clarities` are `NA/A/AA/AAA`;
`treatments` is `NA`. `settingTypes`: bar, bead, bezel, channel, double
prong, flush, half bezel, invisible, pave, prong, ... `settingMethods`:
hand, hand_metal, hand_wax, machine, micro - wax, ...

A `stoneSettingCostCeiling` POST fires before the add (informational
ceiling check, same pattern as the material/labor ceiling calls) — not
required, and this tool doesn't call it, matching how the material/labor
ceiling checks are already skipped.

**Cost is a placeholder, same spirit as the category map**: the PLM's
`stones` table has a size + a stored `cost`, but not a separate
stone-vs-setting split. Per instruction, `buildStonePayload()` treats
`cost` and `settingChargePerStone` as the same number, and buckets that
number by `stoneMillimeter` (a couple cents apart between sizes like
5mm vs 7mm) rather than reading a precise number per row — refine
together once real invoices come back through reconciliation.

## Update vs create — captured 2026-09-01/02 (S189427, S189443, S189748)

Create and update are **different endpoints**, not the same one with an id in
the body. Passing an id to a create endpoint does not update anything — it
mints a new row and you get a duplicate.

| Thing | Create | Update |
|---|---|---|
| Item | `POST .../{ssp}/item` | `PUT .../{ssp}/item/{itemId}` |
| Material | `POST .../{ssp}/item/{id}/material` | `PUT .../{ssp}/item/{id}/material/{materialId}` |
| Labor cost | — | `PUT .../{ssp}/item/{id}/update-laborcost` (one row per item, upsert) |

Update bodies are the same shape as create, plus the id field included
(`itemId` / `materialId`). Both confirmed against real HARs of edit-and-save
in the live SKU Manager UI. **Stone update is still unconfirmed** — no
edit-and-save HAR captured yet, so the code only creates stones it has no id
for.

### The phantom-success trap (important)

`PUT .../item/{id}/material/{materialId}` against a materialId that **does not
exist** returns `HTTP 200` with `success: true` and echoes the payload back
(it even assigns a `platingId`) — while persisting **nothing**.

Confirmed on S189748/item 1: the PUT came back green, while
`GET .../item/1/materials` returned `204 No Content` and SSP's own validator
kept reporting *"Item indicates it should have 1 or more Material components,
but none were found."*

This is self-perpetuating if you trust it: the app writes the phantom id back
to Supabase, so every later send sees a stored id, PUTs again, gets another
fake green, and the item stays empty forever.

**Rule: never branch on a stored id.** `GET .../item/{id}/materials` first and
branch on what is actually there (204 = genuinely empty → create). After any
write, GET again to confirm it landed, and refuse to persist an id you could
not verify. Implemented in `src/utils/sspCreate.js` via `sspGetItemMaterials`.

### Material gotchas

- `metalKarat` is **`null`** for silver (925) — not a descriptive string.
  Sending `"925 silver"` returns `HTTP 500 "Exception occured during Update
  Product Material"`. Confirmed against two independent HARs.
- Metal loss must be computed, not zeroed: `loss = base × L/(100−L)` with
  L ≈ 5. Real captured values for a silver item: base 3.19, lossAmt 0.17,
  metalCost 3.36.

### Labor cost shape

Different envelope from item/material — everything nests under `model`, and
`itemId` is a **string**:

```json
{"userName":"...","userType":"internal","model":{
  "sspCode":"S189443","itemId":"1","sku":0,
  "noOfCastings":2,"ttlLaborCastingCost":0.5,
  "noOfAssembly":2,"assemblyCharge":0.2,
  "finish":[{"sspCode":"S189443","sku":0,"itemId":"1",
             "finishId":null,"finishType":"high polish","finishCost":0.01}]}}
```

SSP computes the rollups — send the inputs and leave every `ttlAll*` /
`ttlLabor*` total null. The response returned `ttlAllLaborCosts: 0.91`
(casting 0.50 + assembly 2×0.20 + finish 0.01).

Vendor cost reads via `GET .../item/{id}/get-vendorcost`; its **write shape is
not yet captured** — presumably `update-vendorcost` with the same `model`
wrapper, but do not ship a guess given the phantom-success behavior above.

### Product type / category vocabulary

`GET .../{ssp}/item/get-filters` returns `productTypeAndCategories`: a
two-level map, 8 product types → 169 categories total (rings 45, necklaces 36,
body piercings 25, earrings 21, bracelets 18, accessories 12, charms 7,
giftware 5). Both levels are required on the item payload.

Seeded into the PLM as `ssp_product_categories` (Supabase) so the UI can pick
from real values. The old hardcoded `CATEGORY_TO_SSP` map in `sspCreate.js`
contained mostly **invalid** values — `stud earrings`, `hoop earrings`,
`necklace`, `ring`, `bracelet`, `pendant`, and the product type
`body jewelry` do not exist in SSP's vocabulary. Only `bangle`,
`earring charm` and `nose` were real.

### Finding shape — captured 2026-09-02 (S177067 / item 1 / finding 1)

Same create-vs-update split as item and material:

- create: `POST .../v1/ssp/product/{ssp}/item/{itemId}/finding?userName=...`
- update: `PUT  .../v1/ssp/product/{ssp}/item/{itemId}/finding/{findingId}?userName=...`

The body below is the captured **update** (findingId 1 present). Create is
the same shape without a real id. Applies to **charms and earrings** (snap
locks, posts, backs). Not yet wired into the send.

Assume the same phantom-success risk documented above until proven
otherwise: read `GET .../item/{itemId}/findings` first and branch on what is
actually there, rather than trusting a stored findingId or a green response.

```json
{"sspNumber":"S177067","skuNumber":20633297,"itemId":1,"findingId":1,
 "findingType":"snap lock","materialType":"silver","metalPurity":925,
 "metalKarat":"","metalColor":"white","nickelContent":"nickel safe",
 "description":"925 Hinged ","quantity":2,"size":6,"netWeight":0.15,
 "metalCostPerGram":1.952613,"findingMetalBasePrice":65,
 "findingMetalFixingAllowPercent":1,"findingMetalFixingAllowAmt":0.65,
 "findingMetalLossPercent":5,"findingMetalLossAmt":0.02,
 "findingMaterialType":"","manufacturingType":"casted","laborCost":0.2,
 "countryOfOrigin":"VIETNAM","findingMaterialCost":0.31,
 "tetherMetalLossGrid":true,
 "platingMaterial":"","platingColor":"","platingMethod":"",
 "platingMicron":0,"platingCost":0,
 "platings":[{"platingId":6,"platingMaterial":"rhodium","platingColor":"white",
   "platingMethod":"galvanic / electroplating","platingMicron":0.75,
   "platingCost":0.03,"componentTab":"finding",
   "platingCoverageClassification":""}]}
```

Notes:

- `metalKarat` is `""` here, not `null` as on the material row — silver in
  both cases. Copy each component's own convention rather than sharing one.
- The flat `platingMaterial` / `platingColor` / `platingMethod` /
  `platingMicron` / `platingCost` fields sit alongside the `platings[]`
  array and are all empty/zero. The array is what carries the real plating;
  the flat fields appear to be legacy. Send both, matching the UI.
- `findingMetalLossPercent` is 5, same loss convention as material.
- `tetherMetalLossGrid` is a boolean `true` here, while the item payload uses
  the string `"N"`. Do not normalise them to one type.
- `quantity` 2 on an earring finding matches a pair — same piece count the
  item's quantityType and the labor tab's castings/assembly use.

### Stone shape — captured 2026-09-02 (S177067 / item 1 / stone 1)

Read-back path is irregular — note the `get-stone` segment:
`GET .../v1/ssp/product/{ssp}/item/{itemId}/stone/get-stone/{stoneId}?userName=...`

Create stays `POST .../item/{itemId}/stone`. One stone row is created per
entry in the PLM's stones array. Update-by-id is still **unconfirmed** — no
edit-and-save HAR captured yet.

```json
{"sspNumber":"S177067","skuNumber":20633297,"itemId":1,"stoneId":1,
 "isPrimaryStone":false,"category":"cubic zirconia","type":"",
 "stoneMillimeter":"1.75","shape":"round","cut":"","color":"white",
 "clarity":"AA","stonePricingMethod":"Per Piece","quantity":120,
 "pricePerCarat":0,"cost":0,
 "minimumCaratWeightPerStone":0,"minimumTotalCaratWeight":0,
 "billWeightCaratPerStone":0,"totalBillWeightCaratStone":0,
 "totalStoneCost":1.2,"certificateType":null,"certificationLab":null,
 "settingLocation":"VIETNAM","settingType":"shared prong",
 "settingMethod":"hand_wax","settingChargePerStone":0.01,
 "settingChargePerStoneCeiling":null,"totalSettingCost":1.2,
 "countryOfOrigin":"VIETNAM","treatment":"","additionalCharges":[]}
```

Where our current payload (`buildSspPayloadsForSample`) disagrees with this:

| Field | SSP's real value | We send | 
|---|---|---|
| `type` / `cut` / `treatment` | `""` | `"NA"` |
| `certificateType` / `certificationLab` | `null` | `[]` |
| `additionalCharges` | `[]` | `null` (inverted) |
| `settingType` | `"shared prong"` | `"prong"` |
| `settingChargePerStone` | `0.01` | the stone's own cost |
| `settingChargePerStoneCeiling` | `null` | omitted |

The last one is the substantive one: we pass the stone cost through as the
setting charge, so stone cost and setting cost come out identical
(`totalStoneCost` == `totalSettingCost` from the same number). In the real
record they are independent — `cost` is 0 while the setting charge is 0.01
per stone across 120 stones. Needs a real per-stone setting rate before it
can be sent honestly.
