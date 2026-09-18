# Sample Tag Printing — Setup & How It Works (Zebra GX430T)

One-time setup on **each PC** that prints tags, plus how the print path works.

---

## How it works (why there's no PDF step)

Clicking **Print tag** in the PLM sends **raw ZPL straight to the printer** — no
browser print dialog, no paper-size negotiation, no PDF. That's why none of the
Letter-page / margin / scale problems apply on this path.

The chain (`src/utils/tags/browserPrint.js`):

1. **Zebra Browser Print** — an OS-level utility on the PC. Browsers can't talk to
   a USB printer directly; this runs a local service at `https://localhost:9101`
   that bridges the gap. **This is the piece that makes silent printing possible.**
2. `ensureSdk()` loads Zebra's `BrowserPrint-3.1.250.min.js` from `public/`
   (it's not on npm, so it's a script-tag load setting a `window.BrowserPrint` global).
3. `getDefaultPrinter()` asks the SDK for the default Zebra device.
4. `printZpl()` calls `device.send(zpl)` — the printer gets its native command language.

**Fallback:** if any of that throws (Browser Print not installed, printer off, send
failed), the app builds a real PDF instead (`tagPreview.js`) sized to the label and
opens it ready to print. The toast reports *why* it fell back (`lastPrintError`),
so a fallback is never a silent mystery.

> Installing only the **Windows printer driver** is not enough. The driver lets
> Browser Print *discover* the USB printer, but without the Browser Print utility
> you'll get the PDF fallback every time.

---

## 1. Hardware / media

- **Printer:** Zebra GX430T (300 dpi), thermal transfer.
- **Stock:** ZT Labels TJT-306 "rat-tail" jewelry tag (polypropylene, black sensor mark).
- **Ribbon:** black resin (TTR-W-RES-74M-CSO). Resin — not wax — for polypropylene.

## 2. Install Zebra Browser Print  ← the important one

1. Download **Zebra Browser Print** (free, zebra.com) and install it.
2. Open it, confirm the GX430T is listed, and **set it as the default device**
   (the app calls `getDefaultDevice('printer')`).
3. It serves over HTTPS on `https://localhost:9101`. **Visit that URL once in the
   browser and accept its certificate.** If the cert isn't trusted the browser
   blocks the calls — this is the most common "I installed it but it still shows
   a PDF" cause.

## 3. Browser Print JS — already done ✅

Both SDK files are already vendored in the repo's `public/` folder:

- `BrowserPrint-3.1.250.min.js` (what `browserPrint.js` loads)
- `BrowserPrint-Zebra-1.1.250.min.js`

Nothing to do unless you upgrade the SDK — then update `SDK_URL` in
`src/utils/tags/browserPrint.js` to match the new filename.

## 4. Calibrate to the TJT-306

Run this **once** per stock change. From the app, call `calibratePrinter()`
(`browserPrint.js`) — it does the whole thing in one send:

- `~JC` — full media calibration (the printer feeds a few blank tags while it
  measures the stock; same as the feed-button hold dance).
- `^MNM` — lock black-mark sensing.
- `^MFF,F` — auto feed-to-mark on every power-up and head-close (ribbon/label changes).
- `^JUS` — **save to printer memory** so it survives power cycles.

After this, the printer re-syncs itself. Re-run only if you load a different stock
type, or if tags ever start printing shifted again.

**Darkness:** start ~20–24 for resin on polypropylene. Too dark bleeds and kills QR
scans; too light gives thin strokes. Adjust until edges are crisp and the QR has
clean quiet zones.

## 5. Test print + the fold check

1. Print one tag from the PLM (any sample → ⋮ → **Print tag**).
2. Fold at the center line (7/16"). Confirm the **back face reads upright**.
   - If inverted, flip `backRotation` in `src/utils/tags/printConfig.js` and reprint.
3. Confirm the **QR scans** and resolves to the sample. The payload is the bare
   sanitized style number — no URL, no domain (vendor security rule).

---

## Registration & alignment

- Every job prepends a **sync blank** (`buildSyncBlank()`): one blank tag feeds to
  the black mark so registration re-locks before the real tags print.
- `y = 0` is the **top of the label** — the driver's stock top (PDF path) and the
  black-mark registration point (ZPL path). The layout is *not* centered into the
  0.625" feed; doing that pushed the print ~0.1" down the tag and clipped the
  bottom lines.
- If print sits slightly high or low on the physical tag, use the **`labelShift`**
  option (dots; `+` down, `−` up) as a calibration nudge rather than editing the layout.

## Layout source of truth

All geometry lives in **`src/utils/tags/tagLayout.js`** (positions/sizes in printer
dots, from the TJT-306 die sheet). Both consumers read from it:

- `zplTag.js` → the ZPL that actually prints
- `tagPreview.js` → the PDF fallback, drawn 1:1 from the same coordinates

So the preview equals the flat print. Don't lay out geometry in either consumer.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Always opens a PDF instead of printing | Browser Print not installed, or its localhost cert not trusted. Check the toast — it now shows the actual error. |
| *"Could not load the Browser Print SDK"* | Filename mismatch — `SDK_URL` in `browserPrint.js` vs the file in `public/`. |
| *"No default Zebra printer found"* | Set the default device in Browser Print; confirm the printer is on and connected. |
| Print shifted up/down on the tag | Run `calibratePrinter()`; if still off, nudge with `labelShift`. |
| Tags feed two at a time / drift | Registration lost — `calibratePrinter()` (re-locks mark sensing + saves it). |
| QR won't scan | Reduce darkness; make sure the QR isn't clipped by the fold. |
| Back face upside-down after folding | Flip `backRotation` in `printConfig.js`. |

**Per-machine:** Browser Print is installed per computer. Any PC that prints tags
needs steps 2 and 4 done on it.
