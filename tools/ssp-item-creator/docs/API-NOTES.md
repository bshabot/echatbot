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
