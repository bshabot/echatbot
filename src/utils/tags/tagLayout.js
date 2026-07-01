// src/utils/tags/tagLayout.js
// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the sample-tag layout.
//
// This module computes every element's position and size in PRINTER DOTS for
// the ZT TJT-306 "rat-tail" tag. BOTH consumers read from here:
//   - zplTag.js       -> emits ZPL for the Zebra GX430T (what actually prints)
//   - tagPreview.js   -> draws a 1:1 SVG of these exact dot coordinates
// so the on-screen preview equals the flat print. Never lay out geometry in
// either consumer again.
//
// Stock (do not change): TJT-306. The printable flag is 0.875" wide x 0.4375"
// tall, split by a center vertical fold at 0.4375" into two 0.4375" square
// faces (FRONT | BACK). A clear tail extends right for the remaining ~2.625"
// (full label 3.5" x 0.4375"). Printer 300 dpi; feed/vertical repeat 0.625".
//
// Layout (matches the approved target image, FLAT):
//   FRONT face (x 0 -> 0.4375"): QR on the left; weight to the RIGHT of the QR,
//     large, as "<salesWeight to 1 decimal> gr" (e.g. "2.4 gr", shown stacked).
//   Center fold at x = 0.4375".
//   BACK face (x 0.4375 -> 0.875"): three LEFT-aligned, vertically-centered
//     lines: style# (bold, largest) / metal+karat / plating.
//   ABOVE THE TAIL: "MFG# <code>   <VENDOR>" - an internal handling reference,
//     printed above the tail strip (Brian does not want it on the finished tag).
//   TAIL: "E CHABOT" only.
//
// The BACK face folds over the center line, so for the physical print it may
// need a 180 rotation to read right-side-up once folded. That is applied by
// zplTag.js via the single `backRotation` flag - it is NOT baked into this
// flat layout, which always matches the flat target.
//
// SECURITY: the QR payload is the SANITIZED style number as a plain string.
// No URL, no domain. Do not change.
// ---------------------------------------------------------------------------

import { resolvePlatingLabel } from './plating.js';

// ---- physical constants (inches) ----
// Geometry per the actual TJT-306 die sheet AND the target image (its "7/8"
// dimension arrow spans one face): the flag is 1.75" wide (two 0.875" faces),
// the fold is at 0.875", and the tail is the remaining 1.75". (This differs
// from the 0.875"/0.4375" note in the brief; a 0.4375" face can't fit the real
// text - "14k Gold Plated .5mic" etc. - which is why the image shows wider
// faces. Full label 3.5" x 0.4375" and the 0.625" feed are unchanged.)
const LABEL_W_IN = 3.5;    // full label width (flag + tail)
const FACE_IN = 0.875;     // each fold face (front / back)
const FLAG_W_IN = FACE_IN * 2; // 1.75" printable flag (two fold faces)
const FLAG_H_IN = 0.4375;  // printable height
const FEED_IN = 0.625;     // feed / vertical repeat

const AVG = 0.6; // avg advance / height for the scalable A0 font (fit estimate)

const d = (inch, dpi) => Math.round(inch * dpi);

// ---------------------------------------------------------------------------
// text-fit helpers (shared -> preview and print shrink identically)
// ---------------------------------------------------------------------------

/** Estimated printed width (dots) of `text` at font height `h` (dots). */
export function estimateWidth(text, h) {
  return String(text).length * h * AVG;
}

/** Largest font height <= targetH at which `text` fits `maxW` (down to minH). */
export function fitHeight(text, maxW, targetH, minH) {
  let h = targetH;
  while (h > minH && estimateWidth(text, h) > maxW) h -= 1;
  return Math.max(minH, h);
}

/** Hard-truncate `text` so it fits `maxW` at height `h` (used at the floor). */
export function truncateToFit(text, maxW, h) {
  let t = String(text);
  while (t.length > 1 && estimateWidth(t, h) > maxW) t = t.slice(0, -1);
  return t;
}

/** Fit a line to its box: shrink to fit, then truncate if still too long. */
function fitLine(text, maxW, targetH, minH) {
  const h = fitHeight(text, maxW, targetH, minH);
  const t = estimateWidth(text, h) > maxW ? truncateToFit(text, maxW, h) : String(text);
  return { text: t, h };
}

/** QR module count for a short alphanumeric payload (ecc M). */
function qrModules(payload) {
  const len = String(payload).length;
  if (len <= 20) return 21; // v1
  if (len <= 38) return 25; // v2
  if (len <= 61) return 29; // v3
  return 33;                // v4
}

// ---------------------------------------------------------------------------
// data mapping
// ---------------------------------------------------------------------------

/**
 * Sanitize a style number: take only the token before the first whitespace or
 * line break. Fixes the dirty multi-line values (e.g. a 73-char description)
 * that would otherwise overflow the tag and poison the QR payload.
 */
export function sanitizeStyleNumber(styleNumber) {
  return String(styleNumber == null ? '' : styleNumber).trim().split(/\s/)[0] || '';
}

/** Format weight as "<rounded to 1 decimal> gr" (e.g. 2.44 -> "2.4 gr"). */
export function formatWeight(salesWeight) {
  if (salesWeight == null || salesWeight === '') return '';
  const n = Number(salesWeight);
  if (!Number.isFinite(n)) return '';
  return `${n.toFixed(1)} gr`;
}

/**
 * Map a sample_with_stones_export row to tag fields.
 * @param {object} row  export-view row
 * @param {object} [opts]
 * @param {Record<string|number,string>} [opts.vendorsById]  vendor id -> name,
 *   used to resolve the vendor name when the view has no vendor_name column yet.
 */
export function mapSampleToTagFields(row = {}, opts = {}) {
  const vendorsById = opts.vendorsById || null;
  const vendorName =
    row.vendor_name != null
      ? row.vendor_name
      : vendorsById && row.vendor != null && vendorsById[row.vendor] != null
        ? vendorsById[row.vendor]
        : '';
  return {
    styleNumber: sanitizeStyleNumber(row.styleNumber),
    weight: formatWeight(row.salesWeight),
    metal: [row.metalType, row.karat].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(' '),
    plating: resolvePlatingLabel({
      platingLabel: row.plating_label ?? null,
      platingName: row.plating_name ?? null,
    }),
    manufacturerCode: row.manufacturerCode == null ? '' : String(row.manufacturerCode).trim(),
    vendorName: String(vendorName || '').trim().toUpperCase(),
  };
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/** Printer-dot geometry for the frame at a given dpi. */
export function geometry(dpi = 300) {
  const widthDots = d(LABEL_W_IN, dpi);
  const feedDots = d(FEED_IN, dpi);
  const flagH = d(FLAG_H_IN, dpi);
  const faceW = d(FACE_IN, dpi);
  const topMargin = Math.max(0, Math.round((feedDots - flagH) / 2));
  const foldX = faceW;          // center fold
  const flagRight = faceW * 2;  // end of the flag / start of the tail
  return { dpi, widthDots, feedDots, flagH, faceW, topMargin, foldX, flagRight };
}

/**
 * Compute the FLAT tag layout as a list of primitives in printer dots.
 * @param {object} f  tag fields (see mapSampleToTagFields) - already sanitized
 * @param {object} [opts] { dpi = 300 }
 * @returns {{ dpi, widthDots, feedDots, flagH, foldX, flagRight, topMargin, elements }}
 *
 * element kinds:
 *   { kind:'qr',   face:'front', x, y, size, mag, modules, payload }
 *   { kind:'text', face, x, y, h, text, align:'left', bold, muted }
 *   { kind:'fold', x, y0, y1 }   (guide only; preview draws it, ZPL ignores it)
 */
export function computeTagLayout(f, opts = {}) {
  const g = geometry(opts.dpi || 300);
  const { dpi, flagH, faceW, topMargin, foldX, flagRight, widthDots } = g;
  const elements = [];

  const style = sanitizeStyleNumber(f.styleNumber);
  const weight = f.weight || '';                 // already "x.x gr"
  const metal = (f.metal || '').trim();
  const plating = (f.plating || '').trim();
  const mfr = (f.manufacturerCode || '').trim();
  const vendor = (f.vendorName || '').trim();

  // ================= FRONT face: QR (left) + weight (right) =================
  const modules = qrModules(style || ' ');
  const qrTarget = Math.min(Math.round(flagH * 0.82), Math.round(faceW * 0.56));
  const mag = Math.max(2, Math.min(10, Math.floor(qrTarget / modules)));
  const qrPix = modules * mag;
  const qrX = d(0.03, dpi);
  const qrY = topMargin + Math.round((flagH - qrPix) / 2);
  elements.push({ kind: 'qr', face: 'front', x: qrX, y: qrY, size: qrPix, mag, modules, payload: style });

  if (weight) {
    const [numRaw, unitRaw = 'gr'] = weight.split(/\s+/);
    const wx = qrX + qrPix + d(0.03, dpi);
    const ww = foldX - wx - d(0.02, dpi);
    const num = fitLine(numRaw, ww, Math.round(flagH * 0.5), Math.round(flagH * 0.22));
    const unitH = Math.max(Math.round(flagH * 0.2), Math.round(num.h * 0.7));
    const unit = fitLine(unitRaw, ww, unitH, Math.round(flagH * 0.16));
    const gap = Math.round(flagH * 0.04);
    const total = num.h + gap + unit.h;
    const top = topMargin + Math.round((flagH - total) / 2);
    elements.push({ kind: 'text', face: 'front', x: wx, y: top, h: num.h, text: num.text, align: 'left', bold: true });
    elements.push({ kind: 'text', face: 'front', x: wx, y: top + num.h + gap, h: unit.h, text: unit.text, align: 'left', bold: true });
  }

  // fold guide (preview only)
  elements.push({ kind: 'fold', x: foldX, y0: topMargin, y1: topMargin + flagH });

  // ================= BACK face: style / metal / plating =====================
  const pad = d(0.035, dpi);
  const bx = foldX + pad;
  const bw = faceW - pad * 2;
  const back = [];
  if (style) back.push({ ...fitLine(style, bw, Math.round(flagH * 0.34), Math.round(flagH * 0.16)), bold: true });
  if (metal) back.push({ ...fitLine(metal, bw, Math.round(flagH * 0.28), Math.round(flagH * 0.13)), bold: false });
  if (plating) back.push({ ...fitLine(plating, bw, Math.round(flagH * 0.26), Math.round(flagH * 0.12)), bold: false });
  const bgap = Math.round(flagH * 0.05);
  const bTotal = back.reduce((s, l) => s + l.h, 0) + bgap * Math.max(0, back.length - 1);
  let by = topMargin + Math.round((flagH - bTotal) / 2);
  for (const l of back) {
    elements.push({ kind: 'text', face: 'back', x: bx, y: by, h: l.h, text: l.text, align: 'left', bold: l.bold });
    by += l.h + bgap;
  }

  // ================= TAIL: MFG# reference (above) + E CHABOT ================
  const mfgText = [mfr ? `MFG# ${mfr}` : '', vendor].filter(Boolean).join('   ');
  if (mfgText) {
    const mx = flagRight + d(0.1, dpi);
    const mw = widthDots - mx - d(0.05, dpi);
    const m = fitLine(mfgText, mw, Math.round(flagH * 0.22), Math.round(flagH * 0.14));
    elements.push({ kind: 'text', face: 'above', x: mx, y: topMargin + Math.round(flagH * 0.08), h: m.h, text: m.text, align: 'left', bold: false, muted: true });
  }
  {
    const ex = flagRight + d(0.08, dpi);
    const ew = widthDots - ex - d(0.05, dpi);
    const e = fitLine('E CHABOT', ew, Math.round(flagH * 0.26), Math.round(flagH * 0.16));
    // Sit E CHABOT on the tail centerline (vertically centered in the print
    // area, which is where the physical tail strip runs).
    elements.push({ kind: 'text', face: 'tail', x: ex, y: topMargin + Math.round((flagH - e.h) / 2), h: e.h, text: e.text, align: 'left', bold: true });
  }

  return { ...g, elements };
}

export const TAG_GEOMETRY = {
  LABEL_W_IN, FLAG_W_IN, FACE_IN, FLAG_H_IN, FEED_IN, geometry,
};
// end tagLayout.js
