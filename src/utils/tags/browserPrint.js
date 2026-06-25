// src/utils/tags/browserPrint.js
// ---------------------------------------------------------------------------
// Thin wrapper around Zebra Browser Print (https://www.zebra.com/.../browser-print).
//
// Setup (one-time, on the PC running the GX430T):
//   1. Install "Zebra Browser Print" (the OS-level utility). It exposes the
//      USB/network printer to the browser over localhost (https://localhost:9101).
//   2. Vendor Zebra's "BrowserPrint-3.x.min.js" into this app's /public folder
//      and load it (e.g. a <script> in index.html, or it is loaded on demand
//      by ensureSdk() below from /BrowserPrint-3.1.250.min.js).
//
// It is NOT an npm package, which is why we load the global instead of import.
// ---------------------------------------------------------------------------

import { buildTagFromSample, buildBatchZPL } from './zplTag.js';

const SDK_URL = '/BrowserPrint-3.1.250.min.js'; // adjust to the file you vendor

let sdkPromise = null;

/** Load the Browser Print SDK global on demand (no-op if already present). */
export function ensureSdk() {
  if (typeof window !== 'undefined' && window.BrowserPrint) return Promise.resolve(window.BrowserPrint);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Browser Print is only available in the browser.'));
      return;
    }
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => {
      if (window.BrowserPrint) resolve(window.BrowserPrint);
      else reject(new Error('BrowserPrint SDK loaded but global is missing.'));
    };
    s.onerror = () =>
      reject(new Error(`Could not load the Browser Print SDK from ${SDK_URL}. Vendor it into /public.`));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/** Resolve the default Zebra printer (a BrowserPrint Device). */
export function getDefaultPrinter() {
  return ensureSdk().then(
    (BP) =>
      new Promise((resolve, reject) => {
        BP.getDefaultDevice(
          'printer',
          (device) => {
            if (device) resolve(device);
            else reject(new Error('No default Zebra printer found. Set one in Browser Print, or check it is on.'));
          },
          (err) => reject(new Error(`Browser Print error: ${err}`))
        );
      })
  );
}

/** Send raw ZPL to the default printer. */
export function printZpl(zpl) {
  return getDefaultPrinter().then(
    (device) =>
      new Promise((resolve, reject) => {
        device.send(zpl, () => resolve(true), (err) => reject(new Error(`Print failed: ${err}`)));
      })
  );
}

/**
 * Print tags for one or many sample rows (export-view shape).
 * @param {object|object[]} rows
 * @param {object} [opts] passed through to the ZPL generator (dpi, backRotation, ...)
 */
export function printTags(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return Promise.resolve(false);
  const zpl = list.length === 1 ? buildTagFromSample(list[0], opts) : buildBatchZPL(list, opts);
  return printZpl(zpl);
}

/** True if the SDK global is already available (no load attempt). */
export function isBrowserPrintReady() {
  return typeof window !== 'undefined' && !!window.BrowserPrint;
}
