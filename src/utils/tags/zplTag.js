// src/utils/tags/zplTag.js
// ---------------------------------------------------------------------------
// ZPL generator for the E. Chabot two-sided fold sample tag.
//
// Stock: ZT Labels TJT-306 "rat-tail" jewelry tag (polypropylene, thermal
// transfer, black sensor mark) + black resin ribbon. Single color (black).
//
// Geometry (from the ZT TJT-306 die spec, in inches so any dpi works):
//   - Full label width: 3.50" (body + rat tail), height 0.4375".
//   - Body (the folded "flag"): 0.875" wide -> a center fold splits it into
//     two 0.4375" squares, the two faces of the folded tag.
//   - Rat tail: the remaining 2.625" -> torn off / discarded after folding,
//     never folded, so anything printed there is never rotated.
//   - Feed / vertical repeat: 0.625".
//
// LEFT square  (front, unrotated): QR (opaque style number) on top, weight
//              underneath.
// RIGHT square (becomes the back once folded -> gets backRotation): style
//              number, metal/karat, plating - stacked.
// RAT TAIL     (discard section): manufacturer # just past the body/tail
//              fold line, E CHABOT wordmark further out along the tail.
//
// SECURITY (handoff Section 3): the QR payload is the style number as a PLAIN
// STRING. No URL, no domain, nothing. Do not change this.
// ---------------------------------------------------------------------------

import { LOGO_ZPL, LOGO_DIMS } from '../../assets/logoZpl.js';
import { resolvePlatingLabel } from './plating.js';

const LABEL_W_IN = 3.5;    // full label width, body + rat tail
const BODY_W_IN = 0.875;   // printable body/flag width (folds into two squares)
const FLAG_H_IN = 0.4375;  // printable flag height
const FEED_IN = 0.625;     // feed / vertical repeat (label length)
const FACE_IN = 0.4375;    // each folded square's side (= BODY_W_IN / 2)
const TAIL_W_IN = LABEL_W_IN - BODY_W_IN; // 2.625" rat tail (discard section)

const inToDots = (inch, dpi) => Math.round(inch * dpi);

/** Strip ZPL control characters from field data. */
function zplEscape(s) {
  return String(s == null ? '' : s).replace(/[\^~]/g, ' ').trim();
}

/** Approx printed width (dots) of `text` at scalable-font height `font`. */
function textWidth(text, font) {
  return Math.round(String(text).length * font * 0.6);
}

/** Shrink a font height so `text` fits within `maxW` dots (down to `minFont`). */
function fitFont(text, maxW, baseFont, minFont = 12) {
  let f = baseFont;
  while (f > minFont && textWidth(text, f) > maxW) f -= 1;
  return f;
}

/** Pick a QR magnification so the symbol fits inside the face. */
function qrMagnification(payload, faceDots) {
  const len = payload.length;
  const modules = len <= 10 ? 21 : len <= 17 ? 25 : 29; // QR v1/v2/v3
  return Math.max(2, Math.min(10, Math.floor((faceDots * 0.82) / modules)));
}

/**
 * Map a sample_with_stones_export row to the fields the tag needs.
 * Weight = salesWeight (per Brian/Kevin's decision).
 */
export function mapSampleToTagFields(row = {}) {
  return {
    styleNumber: row.styleNumber,
    weight: row.salesWeight,
    metalType: row.metalType,
    karat: row.karat,
    manufacturerCode: row.manufacturerCode,
    plating: resolvePlatingLabel({
      platingLabel: row.plating_label ?? null,
      platingName: row.plating_name ?? null,
    }),
  };
}

/**
 * Build the ZPL for one sample tag.
 *
 * @param {object} f  tag fields (see mapSampleToTagFields)
 * @param {object} [opts]
 * @param {number} [opts.dpi=300]
 * @param {boolean} [opts.backRotation=false]  rotate the right square 180 -
 *   it becomes the back once the tag is folded at the center line (confirm
 *   true/false against a test print on the actual GX430T).
 * @param {string} [opts.logoZpl=LOGO_ZPL]  raw ^GFA wordmark graphic for the
 *   rat tail; pass null/'' to fall back to plain scalable-font text.
 * @param {number} [opts.darkness]  optional ^MD darkness (resin on PP)
 * @returns {string} ZPL for one ^XA..^XZ label
 */
export function buildSampleTagZPL(f, opts = {}) {
  const dpi = opts.dpi || 300;
  const backRotation = !!opts.backRotation;
  const logoZpl = opts.logoZpl != null ? opts.logoZpl : LOGO_ZPL;

  const labelW = inToDots(LABEL_W_IN, dpi); // full label width, incl. rat tail
  const bodyW = inToDots(BODY_W_IN, dpi);   // folded body (left + right squares)
  const feed = inToDots(FEED_IN, dpi);
  const face = inToDots(FACE_IN, dpi);      // each square's side
  const flagH = inToDots(FLAG_H_IN, dpi);
  const topMargin = Math.max(0, Math.round((feed - flagH) / 2));
  const innerFace = face - 12; // usable width inside a square, small margins

  const leftX = 0;     // LEFT square: QR + weight (front, unrotated)
  const rightX = face; // RIGHT square: style/metal/plating (back-after-fold)

  const style = zplEscape(f.styleNumber);
  const weightTxt = f.weight != null && f.weight !== '' ? `${f.weight} g` : '';
  const metalLine = [zplEscape(f.metalType), zplEscape(f.karat)].filter(Boolean).join(' ');
  const plating = zplEscape(f.plating);
  const mfr = zplEscape(f.manufacturerCode);

  // ---- LEFT square: QR on top, weight underneath ----
  const mag = qrMagnification(style, face);
  const qrX = leftX + Math.round(face * 0.08);
  const qrY = topMargin + Math.round(face * 0.05);
  const left = [`^FO${qrX},${qrY}^BQN,2,${mag},M^FDMA,${style}^FS`];
  if (weightTxt) {
    const weightFont = fitFont(weightTxt, innerFace, 15, 9);
    left.push(
      `^FO${leftX + 6},${topMargin + flagH - weightFont - 2}^A0N,${weightFont},${weightFont}^FD${weightTxt}^FS`
    );
  }

  // ---- RIGHT square: style # / metal+karat / plating, stacked ----
  // This square becomes the back of the tag once folded at the center line,
  // so it gets the 180 (backRotation) treatment - the left square never does.
  const rLines = [];
  let ry = 6;
  const styleFont = fitFont(style, innerFace, 16, 8);
  rLines.push({ x: 6, y: ry, font: styleFont, text: style });
  ry += styleFont + 5;
  if (metalLine) {
    const metalFont = fitFont(metalLine, innerFace, 14, 7);
    rLines.push({ x: 6, y: ry, font: metalFont, text: metalLine });
    ry += metalFont + 5;
  }
  if (plating) {
    // Plating labels can be long (e.g. "14k Gold Plated .5mic"); allow a
    // small floor so they still fit on one line.
    const platingFont = fitFont(plating, innerFace, 13, 7);
    rLines.push({ x: 6, y: ry, font: platingFont, text: plating });
  }

  const right = rLines
    .map((l) => {
      if (backRotation) {
        // 180 deg: orientation 'I', mirror within the right square's box.
        const ax = rightX + (face - l.x);
        const ay = topMargin + (face - l.y);
        return `^FO${ax},${ay}^A0I,${l.font},${l.font}^FD${l.text}^FS`;
      }
      return `^FO${rightX + l.x},${topMargin + l.y}^A0N,${l.font},${l.font}^FD${l.text}^FS`;
    })
    .join('');

  // ---- RAT TAIL (discard section, never folded -> always unrotated):
  //      manufacturer # just past the body/tail fold line, E CHABOT
  //      wordmark further out along the tail. ----
  const tailParts = [];
  if (mfr) {
    const mfrTxt = `Mfr# ${mfr}`;
    const mfrMaxW = inToDots(1.2, dpi);
    const mfrFont = fitFont(mfrTxt, mfrMaxW, 16, 11);
    const mfrX = bodyW + inToDots(0.06, dpi);
    tailParts.push(`^FO${mfrX},${topMargin + 4}^A0N,${mfrFont},${mfrFont}^FD${mfrTxt}^FS`);
  }
  const logoX = bodyW + inToDots(1.5, dpi);
  if (logoZpl) {
    const lh = (LOGO_DIMS && LOGO_DIMS.height) || 18;
    const logoY = topMargin + Math.max(0, Math.round((flagH - lh) / 2));
    tailParts.push(`^FO${logoX},${logoY}${logoZpl}`);
  } else {
    const wmFont = 20;
    tailParts.push(`^FO${logoX},${topMargin + 6}^A0N,${wmFont},${wmFont}^FDE CHABOT^FS`);
  }
  const tail = tailParts.join('');

  const darkness = opts.darkness != null ? `^MD${opts.darkness}` : '';

  return [
    '^XA',
    `^PW${labelW}`, // print width = full label, incl. rat tail (was bug: only body before)
    `^LL${feed}`,   // label length = feed repeat
    '^MNM',         // mark sensing (black sensor mark on the die)
    '^MTT',         // thermal transfer (ribbon)
    '^PON',         // print orientation normal
    '^LH0,0',
    darkness,
    left.join(''),
    right,
    tail,
    '^XZ',
  ]
    .filter(Boolean)
    .join('');
}

/** Convenience: build a tag straight from an export-view row. */
export function buildTagFromSample(row, opts = {}) {
  return buildSampleTagZPL(mapSampleToTagFields(row), opts);
}

/** Build one ZPL stream for many rows (single send to the printer). */
export function buildBatchZPL(rows, opts = {}) {
  return rows.map((r) => buildTagFromSample(r, opts)).join('\n');
}

export const TAG_GEOMETRY = {
  LABEL_W_IN,
  BODY_W_IN,
  FLAG_H_IN,
  FEED_IN,
  FACE_IN,
  TAIL_W_IN,
  inToDots,
};
