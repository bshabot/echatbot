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

## Images (NOT handled by this tool)

The UI flow is: `POST /v1/ssp/presigned-url/generateUrl` (body = the temp
key string, e.g. `"tempSspImages/NEW_<ts>.jpg"`) → `PUT` the bytes to the
returned S3 URL → include `{imageUrl: "tempSspImages/...", isPrimary,
qaStatus, QADetailedResponse}` in the header/save `images[]`. There is
also a separate AI image-QA service on AWS (`.../prod/presigned-url` +
`.../prod/quality-analysis`) whose pass text the UI embeds in the header
payload. This tool sends `images: []` — attach images separately.

## Stones — NOT CAPTURED YET

The stones tab was never opened in the capture. Expected endpoint shape
is `POST /v1/ssp/product/{ssp}/item/{id}/stone` with a get-filters
sibling, but the payload field names are unknown. To wire it in:
record one add-stone (and ideally delete-stone) in DevTools on a test
product, then implement `buildStonePayload()` in `src/payloads.js` and
replace the guard in `SspClient.addStone()`. Until then the runner
refuses workbooks that contain Stones rows.
