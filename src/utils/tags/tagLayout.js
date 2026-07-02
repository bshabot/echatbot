// src/utils/tags/tagLayout.js
// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the sample-tag layout.
//
// This module computes every element's position and size in PRINTER DOTS for
// the ZT TJT-306 "rat-tail" tag. BOTH consumers read from here:
//   - zplTag.js       -> emits ZPL for the Zebra GX430T (what actually prints)
//   - tagPreview.js   -> draws the same dot coordinates 1:1 (print fallback)
// so what you see equals the flat print. Never lay out geometry in either
// consumer again.
//
// GEOMETRY IS FROM THE TJT-306 DIE SHEET (Label I.D. Systems dwg TJT-306,
// 6/20/2014). Do not "improve" these numbers from a mockup image:
//   - Full label 3.50" x 0.4375"; feed / vertical repeat 0.625".
//   - Printable FLAG = the LEFT 7/8" (0.875"). A center vertical fold at
//     7/16" (0.4375") splits it into TWO 0.4375" x 0.4375" faces.
//   - TAIL = the remaining ~2.625": a clear strip 1/16" (0.0625") tall,
//     running at the vertical CENTER of the label. It wraps the piece.
//     (The die's 7/8" arrow spans the WHOLE flag - both faces - NOT one face.)
//
// Layout (matches the approved target image, FLAT):
//   FRONT face (x 0 -> 0.4375"): QR left (quiet zone respected), weight to the
//     RIGHT of the QR as big stacked "2.4" / "gr" (salesWeight, 1 decimal).
//   fold at x = 0.4375"
//   BACK face (x 0.4375" -> 0.875"): three LEFT-aligned lines, vertically
//     centered: style# (bold, largest) / metal+karat / plating.
//   ABOVE THE TAIL: "MFG# <code>   <VENDOR>" - internal handling reference,
//     printed on the waste area ABOVE the tail strip; NOT on the finished tag.
//   TAIL strip: "E CHABOT" only, sized to the 1/16" strip.
//
// The BACK face folds over the center line; zplTag.js applies the 180
// backRotation there. This flat layout always matches the flat target.
//
// SECURITY: the QR payload is the SANITIZED style number as a plain string.
// No URL, no domain. Do not change.
// ---------------------------------------------------------------------------

import { resolvePlatingLabel } from './plating.js';

// ---- physical constants (inches) - TJT-306 die sheet ----
const LABEL_W_IN = 3.5;      // full label width (flag + tail)
const FLAG_W_IN = 0.875;     // printable flag = the die's 7/8" (BOTH faces)
const FACE_IN = FLAG_W_IN / 2; // each fold face = 7/16" = 0.4375"
const FLAG_H_IN = 0.4375;    // printable height (7/16")
const FEED_IN = 0.625;       // feed / vertical repeat
const TAIL_STRIP_IN = 0.0625; // tail strip thickness (die: 1/16"), centered

const d = (inch, dpi) => Math.round(inch * dpi);

// ---------------------------------------------------------------------------
// text width model (shared -> preview and print fit identically)
// ---------------------------------------------------------------------------
// Average advance-per-character as a fraction of font height for the Zebra A0
// scalable font (CG Triumvirate Bold Condensed). Per-character table beats a
// single 0.6 factor: with 0.6, "14k Gold Plated .5mic" was forced into fonts
// half the size it actually needs.
const W_NARROW = 0.30; // space . , : ' |
const W_DEFAULT = 0.55;
function charW(ch) {
  if (/[ .,:;'!|()\[\]]/.test(ch)) return W_NARROW;
  if (ch === '-') return 0.40;
  if (/[0-9]/.test(ch)) return 0.54;
  if (/[MWmw]/.test(ch)) return 0.70;
  if (/[A-Z#&@]/.test(ch)) return 0.58;
  if (/[a-z]/.test(ch)) return 0.50;
  return W_DEFAULT;
}
const SAFETY = 1.05; // never let the estimate be optimistic

/** Estimated printed width (dots) of `text` at font height `h` (dots). */
export function estimateWidth(text, h) {
  let u = 0;
  for (const ch of String(text)) u += charW(ch);
  return u * h * SAFETY;
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
  return t.trim();
}

/** Fit a line to its box: shrink to fit, then truncate if still too long. */
function fitLine(text, maxW, targetH, minH) {
  const h = fitHeight(text, maxW, targetH, minH);
  const t = estimateWidth(text, h) > maxW ? truncateToFit(text, maxW, h) : String(text);
  return { text: t, h };
}

/** QR module count for the payload (ecc M). */
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

/** First token before any whitespace/line break (kills dirty multi-line values). */
export function sanitizeStyleNumber(styleNumber) {
  return String(styleNumber == null ? '' : styleNumber).trim().split(/\s/)[0] || '';
}

/** "<rounded to 1 decimal> gr" (2.44 -> "2.4 gr"). */
export function formatWeight(salesWeight) {
  if (salesWeight == null || salesWeight === '') return '';
  const n = Number(salesWeight);
  if (!Number.isFinite(n) || n <= 0) return ''; // 0 = missing data, don't print "0.0 gr"
  return `${n.toFixed(1)} gr`;
}

/**
 * Map a sample_with_stones_export row to tag fields.
 * @param {object} row  export-view row
 * @param {object} [opts]
 * @param {Record<string|number,string>} [opts.vendorsById] vendor id -> name
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

/** Printer-dot geometry for the frame at a given dpi (die-true). */
export function geometry(dpi = 300, labelShift = 0) {
  const widthDots = d(LABEL_W_IN, dpi);
  const feedDots = d(FEED_IN, dpi);
  const flagH = d(FLAG_H_IN, dpi);
  const faceW = d(FACE_IN, dpi);
  // labelShift (dots): calibration nudge from printConfig. + moves everything
  // DOWN the label, - moves it up. Set after the first physical test print.
  const topMargin = Math.max(0, Math.round((feedDots - flagH) / 2) + (labelShift || 0));
  const foldX = faceW;              // center fold at 7/16"
  const flagRight = d(FLAG_W_IN, dpi); // flag/tail boundary at 7/8"
  const tailStripH = d(TAIL_STRIP_IN, dpi);
  const tailStripY = topMargin + Math.round((flagH - tailStripH) / 2); // centered
  return { dpi, widthDots, feedDots, flagH, faceW, topMargin, foldX, flagRight, tailStripH, tailStripY };
}

/**
 * Compute the FLAT tag layout as primitives in printer dots.
 * element kinds:
 *   { kind:'qr',   face:'front', x, y, size, mag, modules, payload }
 *   { kind:'text', face:'front'|'back'|'above'|'tail', x, y, h, text, bold, muted }
 *   { kind:'fold', x, y0, y1 }  (guide only - preview draws it, ZPL ignores it)
 */
export function computeTagLayout(f, opts = {}) {
  const g = geometry(opts.dpi || 300, opts.labelShift || 0);
  const { dpi, flagH, faceW, topMargin, foldX, flagRight, widthDots, tailStripH, tailStripY } = g;
  const elements = [];

  const style = sanitizeStyleNumber(f.styleNumber);
  const weight = f.weight || '';
  const metal = (f.metal || '').trim();
  const plating = (f.plating || '').trim();
  const mfr = (f.manufacturerCode || '').trim();
  const vendor = (f.vendorName || '').trim();

  // ============ FRONT face (0 -> foldX): QR left + big weight right ==========
  // The QR magnification auto-fits WITH the weight: prefer a bigger symbol,
  // but never squeeze the weight number below readable (34 dots at 300dpi).
  const modules = qrModules(style || ' ');
  const [numRaw, unitRaw = 'gr'] = (weight || ' ').split(/\s+/);
  const innerPad = Math.round(dpi * 0.02); // breathing room at face edges
  let chosen = null;
  for (const mag of [4, 3, 2]) {
    const quiet = 4 * mag;                       // QR quiet zone (4 modules)
    const sym = modules * mag;
    if (sym + quiet > flagH) continue;           // must fit vertically too
    const qrX = quiet;
    const colX = qrX + sym + quiet;              // weight column starts here
    const colW = foldX - innerPad - colX;
    if (colW <= 0) continue;
    const numH = weight ? fitHeight(numRaw, colW, Math.round(flagH * 0.40), 12) : 0;
    const ok = !weight || numH >= 34 || mag === 2; // mag 2 is the floor
    if (ok) { chosen = { mag, sym, qrX, colX, colW, numH }; break; }
  }
  if (!chosen) { // pathological (huge payload) - smallest workable symbol
    const mag = 2, sym = modules * mag, qrX = 8;
    chosen = { mag, sym, qrX, colX: qrX + sym + 8, colW: Math.max(10, foldX - innerPad - (qrX + sym + 8)), numH: 12 };
  }
  const qrY = topMargin + Math.round((flagH - chosen.sym) / 2);
  elements.push({ kind: 'qr', face: 'front', x: chosen.qrX, y: qrY, size: chosen.sym, mag: chosen.mag, modules, payload: style });

  if (weight) {
    const num = fitLine(numRaw, chosen.colW, chosen.numH, 12);
    const unit = fitLine(unitRaw, chosen.colW, Math.max(14, Math.round(num.h * 0.55)), 10);
    const gap = Math.round(flagH * 0.03);
    const total = num.h + gap + unit.h;
    const top = topMargin + Math.round((flagH - total) / 2);
    elements.push({ kind: 'text', face: 'front', x: chosen.colX, y: top, h: num.h, text: num.text, bold: true });
    elements.push({ kind: 'text', face: 'front', x: chosen.colX, y: top + num.h + gap, h: unit.h, text: unit.text, bold: true });
  }

  // fold guide (preview only - never printed)
  elements.push({ kind: 'fold', x: foldX, y0: topMargin, y1: topMargin + flagH });

  // ============ BACK face (foldX -> flagRight): style / metal / plating ======
  const pad = Math.round(dpi * 0.03);
  const bx = foldX + pad;
  const bw = flagRight - pad - bx; // right pad symmetric
  const back = [];
  if (style) back.push({ ...fitLine(style, bw, Math.round(flagH * 0.26), 15), bold: true });
  if (metal) {
    const cap = back.length ? Math.max(13, back[0].h - 3) : Math.round(flagH * 0.20);
    back.push({ ...fitLine(metal, bw, cap, 12), bold: false });
  }
  if (plating) back.push({ ...fitLine(plating, bw, Math.round(flagH * 0.13), 9), bold: false });
  const bgap = Math.round(flagH * 0.045);
  const bTotal = back.reduce((s, l) => s + l.h, 0) + bgap * Math.max(0, back.length - 1);
  let by = topMargin + Math.round((flagH - bTotal) / 2);
  for (const l of back) {
    elements.push({ kind: 'text', face: 'back', x: bx, y: by, h: l.h, text: l.text, bold: l.bold });
    by += l.h + bgap;
  }

  // ============ TAIL area ====================================================
  // MFG# + vendor: internal reference on the WASTE band ABOVE the tail strip.
  const tx = flagRight + d(0.10, dpi);
  const rightLimit = widthDots - d(0.05, dpi);
  const mfgText = [mfr ? `MFG# ${mfr}` : '', vendor].filter(Boolean).join('   ');
  if (mfgText) {
    const bandH = tailStripY - topMargin;          // space above the strip
    const m = fitLine(mfgText, rightLimit - tx, Math.min(26, bandH - 4), 14);
    const my = topMargin + Math.max(2, Math.round((bandH - m.h) / 2));
    elements.push({ kind: 'text', face: 'above', x: tx, y: my, h: m.h, text: m.text, bold: false, muted: true });
  }
  // E CHABOT: the ONLY print on the tail strip, sized into the 1/16" strip.
  {
    const eh = Math.max(10, tailStripH - 4);
    const e = fitLine('E CHABOT', rightLimit - tx, eh, 10);
    elements.push({ kind: 'text', face: 'tail', x: tx, y: tailStripY + Math.round((tailStripH - e.h) / 2), h: e.h, text: e.text, bold: true });
  }

  return { ...g, elements };
}

export const TAG_GEOMETRY = {
  LABEL_W_IN, FLAG_W_IN, FACE_IN, FLAG_H_IN, FEED_IN, TAIL_STRIP_IN, geometry,
};
// end tagLayout.js
