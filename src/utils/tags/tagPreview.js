// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// PDF preview / print fallback for the sample tag.
//
// Renders the tag(s) as a REAL PDF, sized to the exact physical label
// (3.5in x 0.4375in, one page per tag), and opens it in the browser's PDF
// viewer. The user just hits Ctrl/Cmd+P to print -> the PDF is already the
// right size, so it prints the label, not an 8.5x11 sheet. No toolbar, no
// instructions, no on-screen chrome: just the rendered label.
//
// This is the testing path before Zebra Browser Print is installed; the ZPL
// path (zplTag.js) is what drives the actual Zebra. Coordinates here mirror
// zplTag.js's geometry exactly (in inches), so the PDF matches the die spec.
//
//   LEFT square  (front)  : QR on top, weight underneath.
//   RIGHT square (back)   : style # / metal+karat / plating, stacked.
//   RAT TAIL (discard)    : Mfr# just past the body/tail line, E CHABOT further out.
// ---------------------------------------------------------------------------

import { mapSampleToTagFields } from './zplTag.js';

// Geometry (inches) - matches zplTag.js / the ZT TJT-306 die spec.
const LABEL_W = 3.5;     // full label width (body + rat tail)
const FLAG_H = 0.4375;   // label height
const BODY_W = 0.875;    // folded body (two squares)
const FACE = 0.4375;     // each square's side
const PT = 1 / 72;       // 1 point in inches (for fitting text to a square)

async function qrDataUrl(text) {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(String(text), { margin: 0, errorCorrectionLevel: 'M', scale: 8 });
}

// Shrink a font (points) until the string fits within maxW inches.
function fitPt(doc, text, maxW, basePt, minPt) {
  let pt = basePt;
  while (pt > minPt) {
    doc.setFontSize(pt);
    if (doc.getTextWidth(String(text)) <= maxW) break;
    pt -= 0.5;
  }
  return pt;
}

function drawTag(doc, fields) {
  const style = String(fields.styleNumber ?? '');
  const weight = fields.weight != null && fields.weight !== '' ? `${fields.weight} g` : '';
  const metal = [fields.metalType, fields.karat].filter(Boolean).join(' ');
  const plating = fields.plating ? String(fields.plating) : '';
  const mfr = fields.manufacturerCode ? `Mfr# ${fields.manufacturerCode}` : '';

  const leftX = 0;
  const rightX = FACE;
  const inset = 0.03; // 0.03in text inset, mirrors the ZPL ~6dot margin

  // ---- LEFT square: QR on top, weight underneath (QR sized to leave a
  //      weight band at the bottom so they never overlap) ----
  const qrSize = FACE * 0.66;
  const qrX = leftX + (FACE - qrSize) / 2;
  const qrY = 0.015;
  doc.addImage(fields._qr, 'PNG', qrX, qrY, qrSize, qrSize);
  if (weight) {
    doc.setFont('helvetica', 'bold');
    const pt = fitPt(doc, weight, FACE - inset * 2, 5.5, 4);
    doc.setFontSize(pt);
    doc.text(weight, leftX + inset, FLAG_H - 0.02, { baseline: 'alphabetic' });
  }

  // ---- RIGHT square: style # / metal+karat / plating, stacked ----
  const maxRight = FACE - inset;
  let y = 0.08;
  doc.setFont('helvetica', 'bold');
  const sPt = fitPt(doc, style, maxRight, 7.5, 4);
  doc.setFontSize(sPt);
  doc.text(style, rightX + inset, y, { baseline: 'top' });
  y += sPt * PT + 0.025;
  if (metal) {
    const mPt = fitPt(doc, metal, maxRight, 6.5, 4);
    doc.setFontSize(mPt);
    doc.text(metal, rightX + inset, y, { baseline: 'top' });
    y += mPt * PT + 0.022;
  }
  if (plating) {
    doc.setFont('helvetica', 'normal');
    const pPt = fitPt(doc, plating, maxRight, 5.5, 4);
    doc.setFontSize(pPt);
    doc.text(plating, rightX + inset, y, { baseline: 'top' });
  }

  // ---- RAT TAIL: Mfr# just past the body line, E CHABOT right under it ----
  const tailX = BODY_W + 0.06;
  if (mfr) {
    doc.setFont('helvetica', 'normal');
    const fPt = fitPt(doc, mfr, 1.2, 6, 4);
    doc.setFontSize(fPt);
    doc.text(mfr, tailX, 0.09, { baseline: 'top' });
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('E CHABOT', tailX, 0.27, { baseline: 'top' });
}

/**
 * Build a real PDF of one or many sample tags and open it in the PDF viewer.
 * Each tag is its own page sized to the exact label, so Ctrl/Cmd+P prints the
 * label at true size (no toolbar, no instructions - just the rendered label).
 * @param {object[]} rows  export-view rows
 * @param {object} [opts]  unused (kept for call-site compatibility)
 */
export async function openTagPreview(rows /*, opts = {} */) {
  const list = Array.isArray(rows) ? rows : [rows];
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'in', format: [LABEL_W, FLAG_H], orientation: 'landscape' });

  for (let i = 0; i < list.length; i++) {
    const fields = mapSampleToTagFields(list[i]);
    fields._qr = await qrDataUrl(fields.styleNumber);
    if (i > 0) doc.addPage([LABEL_W, FLAG_H], 'landscape');
    drawTag(doc, fields);
  }

  const url = doc.output('bloburl');
  const w = window.open(url, '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to preview tags.');
  return true;
}
