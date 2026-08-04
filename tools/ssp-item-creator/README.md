# ssp-item-creator

Bulk (or one-at-a-time) item creation for Signet SSP / SKU Manager,
driven by a spreadsheet instead of clicking through the portal. Replays
the same API calls the SSP UI makes (mapped from a recorded HAR — see
`docs/API-NOTES.md`). Created products land in the hold queue with
status *Pending Vendor Submission* for manual review, exactly like a
hand-entered item.

**Images are not handled here** — they're managed separately; products
are created with an empty image list.

## Setup

```bash
cd tools/ssp-item-creator
npm install
cp auth.json.example auth.json     # then paste a fresh SSP token into it
```

The token is the same short-lived Entra bearer token the ssp-scraper
uses — paste a fresh one before each run (they expire in about an hour;
refresh tokens ~24h). `auth.json` is gitignored. If the scraper sends
the token under a different header name/scheme, adjust `authHeader` /
`authScheme` in `config.json` to match.

`config.json` also holds company defaults (vendor 30374, brand 150
Banter, MOQ 50, 30-day supplier lead time, 2X3 bag, VI duty 5%...).
Any of these can be overridden per item in the spreadsheet; blank cells
fall back to these defaults.

## Fill in the workbook

Copy `template/ssp-items-template.xlsx`, fill it in, save it as
`items.xlsx` in this folder (or anywhere, using `--file`). Sheets:

- **Items** — one row per product: styleNumber (the key), buyer,
  countryOfOrigin, productType, productCategories, itemDescription,
  weights, dims, quantityType, supplierPack, plus optional overrides of
  the config defaults.
- **Materials / Findings** — zero or more rows per styleNumber; plating
  columns on the same row (leave platingMaterial blank for no plating).
- **Labor** — one row per styleNumber: castings, assembly, labor/gram,
  finish types + costs (comma-separated, paired by position).
- **Stones** — placeholder. The stone endpoint hasn't been captured yet;
  the runner refuses workbooks with Stones rows until it's wired in
  (see `docs/API-NOTES.md`).

The example row in the template mirrors the recorded test item (S180933).

## Run

```bash
npm run dry-run        # validates the workbook and prints every payload — sends NOTHING
npm run create         # interactive menu: Bulk create / Create single (pick a style)
```

Non-interactive shortcuts:

```bash
node src/createItems.js --bulk                 # every row, no menu
node src/createItems.js --style GVC121-AM      # just that style
node src/createItems.js --file /path/to.xlsx --dry-run
```

Every run writes `results/run-<timestamp>.json` with the SSP number,
status, and completed steps per style. If an item fails mid-flow, the
log says which step it died on and the partially-created SSP number so
it can be finished or fixed in the UI. Always dry-run a new workbook
first, then try one style with `--style` before going bulk.

## Utilities

```bash
npm run vocab                       # dump header dropdown values to docs/vocab-header.json
node src/fetchVocab.js S180933      # + item/material/finding vocab for a product
```

## Layout

```
src/sspClient.js    the connector — one function per SSP endpoint, auth, dry-run
src/payloads.js     spreadsheet row -> API payload mapping
src/workbook.js     xlsx reading + validation
src/createItems.js  the runner (bulk / single menu, confirmation, results log)
src/fetchVocab.js   dropdown-vocabulary dumper
docs/API-NOTES.md   the reverse-engineered API reference
```
