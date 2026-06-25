# Sample Tag Printing — Integration Notes

## What this feature does
One-click printing of a two-sided fold sample tag straight from the PLM to the
Zebra GX430T, plus scan-to-open and reprintable import batches.

- **QR = the bare style number** (a plain string). No URL, no domain — a vendor
  who scans it gets a meaningless code. Do not encode a PLM URL (handoff §3/§9).
- All reads run through the authenticated Supabase client. No public route added.

## New files
| File | Purpose |
|------|---------|
| `src/utils/tags/zplTag.js` | ZPL generator (pure). `buildTagFromSample(row, opts)`, `buildBatchZPL(rows, opts)`. dpi-parametrized; shrink-to-fit plating. |
| `src/utils/tags/plating.js` | Plating label fallback (DB `plating_label` is preferred). |
| `src/utils/tags/browserPrint.js` | Zebra Browser Print wrapper + `printTags(rows, opts)`. |
| `src/utils/tags/tagData.js` | `findSampleByStyleNumber`, `fetchTagRowsBySampleIds`, `logImportBatch`, `listImportBatches`. |
| `src/utils/tags/printConfig.js` | `DEFAULT_PRINT_OPTIONS` — flip `backRotation` after the test print. |
| `src/assets/logoZpl.js` | Monochrome `^GFA` wordmark (regenerate via `tools/image_to_zpl.py`). |
| `src/components/Samples/PrintTagButton.jsx` | Reusable print button. |
| `src/components/Samples/ScanToOpen.jsx` | USB wedge scanner → open sample (renders nothing). |
| `src/Pages/ImportHistory.jsx` | Filterable import log; reprint sample batches. |
| `tools/image_to_zpl.py` | EPS/PNG → `^GFA` converter (for Brian's real logo). |
| `tools/gen_logo.py` | Generates the type-based stand-in wordmark. |
| `test/zplTag.test.mjs` | `node test/zplTag.test.mjs` — generator unit checks. |

## Database (already applied to the production project)
- `plating.tag_label` — the editable label that prints on the tag. Edit this cell
  to change a label; no deploy needed.
- `sample_with_stones_export.plating_label` — the view now exposes the label, so
  sample cards carry it; printing needs no extra fetch.
- `import_batches` table (RLS: authenticated full access) — one row per import.

## Edits to existing files
- `SampleCard.jsx` — "Print tag" item in the ⋮ menu (`onPrintTag` prop).
- `SampleList.jsx` — "Print Tags (N)" beside "Export Selected"; passes `onPrintTag`.
- `MiscComponenets/ViewableListActionButtons.jsx` — optional `extraSelectedActions` slot.
- `Samples.jsx` — mounts `ScanToOpen`; "print just-imported" action; passes `onPrintTag`.
- `Products/ImportModal.jsx` — logs the batch via `logImportBatch` after a successful import.
- `App.jsx` + `SideBar.jsx` — route + nav link for `/import-history`.

## Tuning the tag
Everything is in `printConfig.js` (dpi, `backRotation`, `frontFace`, `darkness`)
and `zplTag.js` (layout). After calibration, the only field you are likely to
touch is `backRotation`.

## Test
```
node test/zplTag.test.mjs        # ZPL generator
npm run lint                     # lint the new/changed files
npm run build                    # type/build check
```
