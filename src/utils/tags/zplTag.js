// src/utils/tags/zplTag.js
// ---------------------------------------------------------------------------
// ZPL generator for the E. Chabot two-sided fold sample tag.
//
// Stock: ZT Labels TJT-306 "rat-tail" jewelry tag (polypropylene, thermal
// transfer, black sensor mark) + black resin ribbon. Single color (black).
//
// Geometry (from the ZT die spec, in inches so any dpi works):
//   - Printable flag: 0.875" x 0.4375"  -> split by a center fold line into
//     two 0.4375" squares (the two faces of the folded tag).
//   - Feed / vertical repeat: 0.625".
//   - One flat print pass -> folds at the center line into the two faces.
//
// FRONT face: QR (opaque style number) + style # in text.
// BACK  face: E CHABOT wordmark + "EST. 1993" + weight + metal/karat + plating.
//
// SECURITY (handoff Section 3): the QR payload is the style number as a PLAIN
// STRING. No URL, no domain, nothing. Do not change this.
// ---------------------------------------------------------------------------

import { LOGO_ZPL, LOGO_DIMS } from '../../assets/logoZpl.js';
import { resolvePlatingLabel } from './plating.js';

const FLAG_W_IN = 0.875;   // printable flag width (across the web)
const FLAG_H_IN = 0.4375;  // printable flag height
const FEED_IN = 0.625;     // feed / vertical repeat (label length)
const FACE_IN = 0.4375;    // each folded face is a square of this side

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
 * @param {boolean} [opts.backRotation=false]  rotate back face 180 (confirm via test print)
 * @param {'left'|'right'} [opts.frontFace='left']
 * @param {string} [opts.logoZpl=LOGO_ZPL]
 * @param {number} [opts.darkness]  optional ^MD darkness (resin on PP)
 * @returns {string} ZPL for one ^XA..^XZ label
 */
export function buildSampleTagZPL(f, opts = {}) {
  const dpi = opts.dpi || 300;
  const frontFace = opts.frontFace || 'left';
  const backRotation = !!opts.backRotation;
  const logoZpl = opts.logoZpl != null ? opts.logoZpl : LOGO_ZPL;

  const flagW = inToDots(FLAG_W_IN, dpi);
  const feed = inToDots(FEED_IN, dpi);
  const face = inToDots(FACE_IN, dpi);
  const topMargin = Math.max(0, Math.round((feed - inToDots(FLAG_H_IN, dpi)) / 2));
  const innerW = face - 12; // usable width inside a face with small margins

  const leftX = 0;
  const rightX = face;
  const frontX = frontFace === 'left' ? leftX : rightX;
  const backX = frontFace === 'left' ? rightX : leftX;

  const style = zplEscape(f.styleNumber);
  const weightTxt = f.weight != null && f.weight !== '' ? `${f.weight} g` : '';
  const metalLine = [zplEscape(f.metalType), zplEscape(f.karat)].filter(Boolean).join(' ');
  const plating = zplEscape(f.plating);

  // ---- FRONT face: QR + style number ----
  const mag = qrMagnification(style, face);
  const qrX = frontX + Math.round(face * 0.08);
  const qrY = topMargin + Math.round(face * 0.05);
  const styleFont = fitFont(style, innerW, 20, 12);
  const front =
    `^FO${qrX},${qrY}^BQN,2,${mag},M^FDMA,${style}^FS` +
    `^FO${frontX + 6},${topMargin + face - styleFont - 2}^A0N,${styleFont},${styleFont}^FD${style}^FS`;

  // ---- BACK face: wordmark + EST + weight + metal + plating ----
  const lines = [];
  let ly = 6;
  if (logoZpl) {
    const lh = (LOGO_DIMS && LOGO_DIMS.height) || 18;
    lines.push({ x: 8, y: ly, raw: logoZpl });
    ly += lh + 6;
  } else {
    lines.push({ x: 8, y: ly, font: 22, text: 'E CHABOT' });
    ly += 26;
  }
  lines.push({ x: 10, y: ly, font: 13, text: 'EST. 1993' });
  ly += 19;
  if (weightTxt) { lines.push({ x: 10, y: ly, font: fitFont(weightTxt, innerW, 17, 12), text: weightTxt }); ly += 20; }
  if (metalLine) { lines.push({ x: 10, y: ly, font: fitFont(metalLine, innerW, 17, 12), text: metalLine }); ly += 20; }
  if (plating) {
    // Plating labels can be long (e.g. "14k Gold Plated .5mic"); allow a smaller
    // floor so they fit one line. Still legible at 300 dpi on the tag face.
    const pf = fitFont(plating, innerW, 16, 9);
    lines.push({ x: 10, y: ly, font: pf, text: plating });
  }

  const back = lines
    .map((l) => {
      if (backRotation) {
        // 180 deg: orientation 'I', mirror within the face box.
        const ax = backX + (face - l.x);
        const ay = topMargin + (face - l.y);
        if (l.raw) return `^FO${Math.max(0, ax - 120)},${Math.max(0, ay - 24)}${l.raw}`;
        return `^FO${ax},${ay}^A0I,${l.font},${l.font}^FD${l.text}^FS`;
      }
      const ax = backX + l.x;
      const ay = topMargin + l.y;
      if (l.raw) return `^FO${ax},${ay}${l.raw}`;
      return `^FO${ax},${ay}^A0N,${l.font},${l.font}^FD${l.text}^FS`;
    })
    .join('');

  const darkness = opts.darkness != null ? `^MD${opts.darkness}` : '';

  return [
    '^XA',
    `^PW${flagW}`, // print width across the web
    `^LL${feed}`,  // label length = feed repeat
    '^MNM',        // mark sensing (black sensor mark on the die)
    '^MTT',        // thermal transfer (ribbon)
    '^PON',        // print orientation normal
    '^LH0,0',
    darkness,
    front,
    back,
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

export const TAG_GEOMETRY = { FLAG_W_IN, FLAG_H_IN, FEED_IN, FACE_IN, inToDots };
