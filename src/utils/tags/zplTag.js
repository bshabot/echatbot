// src/utils/tags/zplTag.js
// ---------------------------------------------------------------------------
// ZPL emitter for the E. Chabot TJT-306 fold sample tag (Zebra GX430T, 300dpi,
// thermal transfer / black resin).
//
// This file NO LONGER lays out geometry. It consumes the single source of
// truth in tagLayout.js (positions/sizes in printer dots) and turns each
// primitive into ZPL. The on-screen preview (tagPreview.js) consumes the exact
// same layout, so preview == flat print.
//
// backRotation: the BACK face folds over the center line, so for the physical
// tag its elements are rotated 180 in place (^A0I) so they read right-side-up
// once folded. This is applied HERE, not in the flat layout; confirm the
// direction on the first GX430T test print. The FLAT ZPL (backRotation off)
// matches the flat preview and the flat target image.
//
// SECURITY: the QR payload is the sanitized style number as a plain string -
// no URL, no domain. Enforced in tagLayout.js. Do not change.
// ---------------------------------------------------------------------------

import { computeTagLayout, mapSampleToTagFields, estimateWidth } from './tagLayout.js';

/** Strip ZPL control characters from field data. */
function zplEscape(s) {
  return String(s == null ? '' : s).replace(/[\^~]/g, ' ').trim();
}

/** Emit one text primitive as ZPL, applying backRotation to the back face. */
function textZPL(el, g, backRotation) {
  const text = zplEscape(el.text);
  if (!text) return '';
  if (backRotation && el.face === 'back') {
    // Rotate the whole face 180: each line's box maps to its point-reflection
    // about the face center. Zebra anchors ^A0I at the rendered box's TOP-LEFT
    // (same as ^A0N; verified against the Labelary ZPL engine), so reflect the
    // box, not the origin: newTopLeft = 2*center - (topLeft + size).
    const cx = g.foldX + g.faceW / 2;
    const cy = g.topMargin + g.flagH / 2;
    const gw = Math.round(el.h * (el.stretch || 1));
    const w = estimateWidth(el.text, el.h) * (el.stretch || 1);
    const ax = Math.round(2 * cx - el.x - w);
    const ay = Math.round(2 * cy - el.y - el.h);
    return `^FO${Math.max(g.foldX, ax)},${Math.max(0, ay)}^A0I,${el.h},${gw}^FD${text}^FS`;
  }
  const gw = Math.round(el.h * (el.stretch || 1));
  return `^FO${el.x},${Math.max(0, el.y)}^A0N,${el.h},${gw}^FD${text}^FS`;
}

/**
 * Build the ZPL for one sample tag from already-mapped fields.
 * @param {object} f  tag fields (see mapSampleToTagFields)
 * @param {object} [opts] { dpi=300, backRotation=false, labelShift=0, darkness }
 */
export function buildSampleTagZPL(f, opts = {}) {
  const dpi = opts.dpi || 300;
  const backRotation = !!opts.backRotation;
  const layout = computeTagLayout(f, { dpi, labelShift: opts.labelShift || 0 });
  const g = layout; // same object = same geometry, including any labelShift

  const body = layout.elements
    .map((el) => {
      if (el.kind === 'qr') {
        return `^FO${el.x},${Math.max(0, el.y)}^BQN,2,${el.mag},M^FDMA,${zplEscape(el.payload)}^FS`;
      }
      if (el.kind === 'text') return textZPL(el, g, backRotation);
      return ''; // 'fold' is a preview-only guide
    })
    .filter(Boolean)
    .join('');

  const darkness = opts.darkness != null ? `^MD${opts.darkness}` : '';

  return [
    '~JSB',                   // backfeed BEFORE printing: fixes the shifted
                              // first label(s) after a job boundary (tear-off
                              // retracts media between jobs; 7/1 batch photo)
    '^XA',
    `^PW${layout.widthDots}`, // 3.5" full label (flag + tail)
    `^LL${layout.feedDots}`,  // 0.625" feed repeat
    '^PR2,2,2',               // 2 ips print/slew/backfeed: sharpest resin
                              // transfer on poly + gentlest media handling
    '^MNM',                   // black-mark sensing (die sensor mark)
    '^MTT',                   // thermal transfer (ribbon)
    '^PON',                   // print orientation normal
    '^LH0,0',
    darkness,
    body,
    '^XZ',
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Pre-print sync (Brian 7/1: "always calibrate pre print"): ~PH = feed to the
 * next label home. The printer advances one label to the black mark before the
 * real tags, re-locking registration on every job - without the 4-5 tag cost
 * of a full ~JC calibration. (An empty ^XA^XZ label didn't feed - some
 * firmwares skip fieldless formats - so use the direct feed command.)
 */
export function buildSyncBlank() {
  return '~PH';
}

/** Convenience: build a tag straight from an export-view row. */
export function buildTagFromSample(row, opts = {}) {
  return buildSampleTagZPL(mapSampleToTagFields(row, opts), opts);
}

/** Build one ZPL stream for many rows (single send to the printer). */
export function buildBatchZPL(rows, opts = {}) {
  return rows.map((r) => buildTagFromSample(r, opts)).join('\n');
}

// Re-exported so existing importers (tagPreview, browserPrint) keep working.
export { mapSampleToTagFields };
