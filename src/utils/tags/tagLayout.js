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
// Layout (Brian's locked mockup, 7/1/26 evening):
//   FACE 1 (0 -> 0.4375"): QR only, centered. | fold at 0.4375" |
//   FACE 2 (0.4375" -> 0.875"): weight, big stacked "2.4" / "gr". Face 2
//     becomes the BACK of the folded square -> zplTag rotates it 180.
//   WHITE STRIP (0.875" -> ~1.70"): style# (biggest text on the tag, bold) /
//     metal+karat / plating - centered as a block, readable flat. NOT folded.
//   CLEAR TAIL (past the die notch at 1.75"): "MFG# <code>   <VENDOR>" and
//     "E CHABOT" small under it - only print on the clear strip, so the whole
//     white body stays free for the label content.
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

/** Fit a line to its box: shrink to fit, then truncate if still too long.
 *  `stretch` scales glyph width (^A0 h,w): <1 condenses, >1 stretches. */
function fitLine(text, maxW, targetH, minH, stretch = 1) {
  const eff = maxW / (stretch || 1);
  const h = fitHeight(text, eff, targetH, minH);
  const t = estimateWidth(text, h) > eff ? truncateToFit(text, eff, h) : String(text);
  return { text: t, h, stretch };
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
  // y = 0 is the TOP OF THE LABEL: the driver's stock top (PDF path) and the
  // black-mark registration point (ZPL path). Do NOT center into the 0.625"
  // feed - the old (feed-flag)/2 offset shoved the whole print ~0.1" down the
  // physical tag and clipped the bottom lines (seen on the 7/1 test print).
  // labelShift (dots) stays as the calibration nudge: + down, - up.
  const topMargin = labelShift || 0; // may be NEGATIVE (shift print UP); emitters clamp at 0
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

  // ============ Brian's locked layout (mockup 7/1 eve) =====================
  // Folded square = FACE 1 (QR) + FACE 2 (weight). The descriptive block
  // (style# / metal / plating) prints on the STRIP past the flag end and stays
  // readable flat - it is NOT part of the folded square. MFG#+vendor and
  // E CHABOT live further out on the tail. Fold cuts NOTHING.

  // ---- FACE 1 (0 -> foldX): QR only, centered ----
  const modules = qrModules(style || ' ');
  const mag = Math.max(2, Math.min(6, Math.floor((flagH * 0.83) / modules) || 2)); // ~85% of label height (Brian 7/1)
  const sym = modules * mag;
  elements.push({
    kind: 'qr', face: 'front',
    x: Math.max(4 * mag, Math.round((faceW - sym) / 2)),
    y: Math.max(6, topMargin + Math.round((flagH - sym) / 2)), // min 6: keep the symbol tip off the label's top edge
    size: sym, mag, modules, payload: style,
  });

  // fold guide (preview only - never printed)
  elements.push({ kind: 'fold', x: foldX, y0: topMargin, y1: topMargin + flagH });

  // ---- FACE 2 (foldX -> flagRight): weight, big, stacked "2.1" / "gr" ----
  // This face becomes the BACK of the folded square -> zplTag applies the 180
  // backRotation to face:'back' elements.
  if (weight) {
    const [numRaw, unitRaw = 'gr'] = weight.split(/\s+/);
    const wx = foldX + Math.round(dpi * 0.04);
    const ww = flagRight - Math.round(dpi * 0.025) - wx;
    const num = fitLine(numRaw, ww, Math.round(flagH * 0.28), 14);   // ~37 dots
    const unit = fitLine(unitRaw, ww, Math.round(num.h * 0.8), 12);  // gr nearly as big
    const gap = Math.round(flagH * 0.04);
    const total = num.h + gap + unit.h;
    const top = topMargin + Math.round((flagH - total) / 2);
    elements.push({ kind: 'text', face: 'back', x: wx, y: top, h: num.h, text: num.text, bold: true });
    elements.push({ kind: 'text', face: 'back', x: wx, y: top + num.h + gap, h: unit.h, text: unit.text, bold: true });
  }

  // ---- STRIP block (past flagRight): style# / metal / plating, centered ----
  // Style# is the biggest text on the tag (Brian). Lines center on a common
  // axis. Auto-fit guards against the strip end.
  const bx0 = flagRight + Math.round(dpi * 0.045);      // ~0.92" from label start
  const bMax = d(1.70, dpi) - bx0;                      // stop before the die notch at 1.75"
  const blk = [];
  if (style) blk.push({ ...fitLine(style, bMax, Math.round(flagH * 0.29), 16), bold: true });   // ~38
  if (metal) blk.push({ ...fitLine(metal, bMax, Math.round(flagH * 0.20), 13), bold: true });   // ~26
  if (plating) blk.push({ ...fitLine(plating, bMax, Math.round(flagH * 0.20), 12, 0.85), bold: true }); // bigger, slightly condensed
  const bgap = Math.round(flagH * 0.035);
  const bTotal = blk.reduce((s2, l) => s2 + l.h, 0) + bgap * Math.max(0, blk.length - 1);
  let by = topMargin + Math.round((flagH - bTotal) / 2);
  const axis = bx0 + Math.round((blk.length ? Math.max(...blk.map((l) => estimateWidth(l.text, l.h) * (l.stretch || 1))) : 0) / 2);
  for (const l of blk) {
    const w = estimateWidth(l.text, l.h) * (l.stretch || 1);
    elements.push({ kind: 'text', face: 'strip', x: Math.max(bx0, Math.round(axis - w / 2)), y: by, h: l.h, text: l.text, bold: l.bold, stretch: l.stretch || 1 });
    by += l.h + bgap;
  }

  // ---- CLEAR TAIL STRIP ONLY (past the die notch at 1.75"): MFG# + VENDOR,
  //      E CHABOT small under. Brian 7/1: pushed all the way right so the
  //      whole white body stays free for the label content. ----
  const TAIL_LIFT = 6; // Brian 7/1: tail text rides 6 dots higher than the global shift
  const tx = d(1.85, dpi);
  const rightLimit = widthDots - d(0.05, dpi);
  const mfgText = [mfr ? `MFG# ${mfr}` : '', vendor].filter(Boolean).join('   ');
  if (mfgText) {
    const m = fitLine(mfgText, rightLimit - tx, Math.round(flagH * 0.19), 14); // ~25, more visible
    elements.push({ kind: 'text', face: 'above', x: tx, y: topMargin + Math.round(flagH * 0.17) - TAIL_LIFT, h: m.h, text: m.text, bold: true, muted: true });
  }
  {
    // taller + stretched wide (^A0 w = 1.7h) so it reads bold along the strip
    const e = fitLine('E CHABOT', rightLimit - tx, Math.max(12, tailStripH - 3), 10, 1.7);
    elements.push({ kind: 'text', face: 'tail', x: tx, y: tailStripY + Math.round((tailStripH - e.h) / 2) - TAIL_LIFT, h: e.h, text: e.text, bold: true, stretch: e.stretch });
  }

  return { ...g, elements };
}

export const TAG_GEOMETRY = {
  LABEL_W_IN, FLAG_W_IN, FACE_IN, FLAG_H_IN, FEED_IN, TAIL_STRIP_IN, geometry,
};
// end tagLayout.js
