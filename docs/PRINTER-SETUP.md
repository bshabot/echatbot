# Sample Tag Printing — Printer Setup (Zebra GX430T)

One-time setup on the PC that drives the label printer.

## 1. Hardware / media
- **Printer:** Zebra GX430T (300 dpi), thermal transfer.
- **Stock:** ZT Labels TJT-306 "rat-tail" jewelry tag (polypropylene, black sensor mark).
- **Ribbon:** black resin (TTR-W-RES-74M-CSO). Resin — not wax — for polypropylene.

## 2. Install Zebra Browser Print
1. Download **Zebra Browser Print** (free) from zebra.com and install it.
2. Open it, confirm the GX430T is listed, and **set it as the default device**.
3. It serves on `https://localhost:9101`. The first time, accept its local certificate
   in the browser (visit the URL once) so the web app can reach it.

## 3. Vendor the Browser Print JS into the app
Browser Print's browser SDK is **not** an npm package. Download
`BrowserPrint-3.x.min.js` (and `BrowserPrint-Zebra-x.x.min.js` if provided) from
Zebra and place it in the app's **`public/`** folder. The app loads it from
`/BrowserPrint-3.1.250.min.js` (see `src/utils/tags/browserPrint.js` — update the
filename there if your version differs).

## 4. Calibrate to the TJT-306
In Zebra Setup Utilities (or the printer's controls):
- **Media type:** Mark / black-line sensing (matches the die's sensor mark).
- **Auto-calibrate** so the printer learns the 0.625" feed repeat.
- **Darkness:** start ~20–24 for resin on polypropylene; nudge until edges are
  crisp and the QR has clean quiet zones. Too dark bleeds and kills QR scans.
- **Print width / length:** the app sends `^PW` and `^LL`; calibration just needs
  to track the mark.

## 5. Test print + the fold question
1. Print one tag from the PLM (any sample → ⋮ → Print tag).
2. Fold at the center line. Check the **back face reads upright**.
   - If it's upside-down, open `src/utils/tags/printConfig.js` and set
     `backRotation: true`, redeploy (or test locally), reprint.
3. Confirm the **QR scans** with the USB scanner and resolves to the sample.

## Troubleshooting
- *"Could not load the Browser Print SDK"* → the JS isn't in `public/`, or the
  filename in `browserPrint.js` doesn't match.
- *"No default Zebra printer found"* → set the default device in Browser Print;
  confirm the printer is on and connected.
- *QR won't scan* → reduce darkness; ensure the QR isn't clipped by the fold line.
- *Back face inverted* → `backRotation: true` in `printConfig.js`.
