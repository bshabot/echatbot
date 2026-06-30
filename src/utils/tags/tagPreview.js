// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// PDF preview / print fallback for the sample tag.
//
// Renders the tag(s) as a REAL PDF, sized to the exact physical media frame,
// and opens it in the browser's PDF viewer. Ctrl/Cmd+P prints it 1:1 - the
// label, not an 8.5x11 sheet, and not scaled. No toolbar, no instructions,
// no on-screen chrome: just the rendered label.
//
// Geometry from the ZT TJT-306 die spec sheet (inches):
//   - Label: 3.50 wide x 0.4375 high (page is built at this exact size).
//   - Body (the "7/8" flag): 0.875 wide -> folds at center into TWO 0.4375
//     squares, the front and back faces.
//   - Rat tail: the long remaining 2.625 (0.875 -> 3.50), discarded after fold.
//
//   LEFT square  (front) : QR on top, weight underneath.
//   RIGHT square (back)  : style # / metal / plating, right-aligned to the body
//                          edge so it lands right when folded over.
//   RAT TAIL (discard)   : Mfr# + E CHABOT, out on the tail.
// ---------------------------------------------------------------------------

import { mapSampleToTagFields } from './zplTag.js';

// Geometry (inches) - from the ZT TJT-306 die spec sheet.
//   Label 3.50 x 0.4375; media pitch 0.625.
//   Body (the "7/8" flag) = 0.875 wide -> folds at center into two 0.4375
//     squares: LEFT (QR + weight) and RIGHT (the 3 lines).
//   Rat tail = the long remaining 2.625 (0.875 -> 3.50), discarded after
//     folding -> Mfr# + E CHABOT live out here.
const LABEL_W = 3.5;     // full label width (body + rat tail)
const LABEL_H = 0.4375;  // printable label height -> PDF page height
const BODY_W = 0.875;    // folding body (two 0.4375 squares)
const FACE_W = 0.4375;   // each fold square (front / back face)
const PT = 1 / 72;       // 1 point in inches (for fitting text)

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

  const inset = 0.02;        // text inset from a face edge

  // ---- LEFT square (0..0.4375): QR on top, weight underneath. The square is
  //      only 0.4375in wide, so the weight goes BELOW the QR (not beside). ----
  const qrSize = FACE_W * 0.62;            // ~0.27in, leaves a weight band below
  const qrX = (FACE_W - qrSize) / 2;
  const qrY = 0.025;
  doc.addImage(fields._qr, 'PNG', qrX, qrY, qrSize, qrSize);
  if (weight) {
    doc.setFont('helvetica', 'bold');
    const pt = fitPt(doc, weight, FACE_W - inset * 2, 6, 3.5);
    doc.setFontSize(pt);
    doc.text(weight, FACE_W / 2, qrY + qrSize + 0.07, { baseline: 'alphabetic', align: 'center' });
  }

  // ---- RIGHT square (0.4375..0.875): style # / metal / plating, each on ONE
  //      line (fit-to-width), right-aligned to the END of the body so it lands
  //      right when the body folds over at the center. Small square -> small,
  //      tidy type that all fits inside it (never bleeding over the QR). ----
  const maxRight = FACE_W - inset;
  const edgeX = BODY_W - inset; // right edge of the body -> right-align here
  let y = 0.03;
  doc.setFont('helvetica', 'bold');
  const sPt = fitPt(doc, style, maxRight, 7, 3.5);
  doc.setFontSize(sPt);
  doc.text(style, edgeX, y, { baseline: 'top', align: 'right' });
  y += sPt * PT + 0.012;
  if (metal) {
    const mPt = fitPt(doc, metal, maxRight, 6, 3.5);
    doc.setFontSize(mPt);
    doc.text(metal, edgeX, y, { baseline: 'top', align: 'right' });
    y += mPt * PT + 0.012;
  }
  if (plating) {
    doc.setFont('helvetica', 'normal');
    const pPt = fitPt(doc, plating, maxRight, 5.5, 3.5);
    doc.setFontSize(pPt);
    doc.text(plating, edgeX, y, { baseline: 'top', align: 'right' });
  }

  // ---- RAT TAIL (0.875..3.5, the long 2.625in discard section): Mfr# on top,
  //      E CHABOT below, set well out onto the tail. ----
  const tailX = BODY_W + 0.4; // out onto the tail, clear of the body fold line
  const tailRoom = LABEL_W - tailX - 0.06;
  if (mfr) {
    doc.setFont('helvetica', 'normal');
    const fPt = fitPt(doc, mfr, tailRoom, 7, 4);
    doc.setFontSize(fPt);
    doc.text(mfr, tailX, 0.06, { baseline: 'top' });
  }
  doc.setFont('helvetica', 'bold');
  const wPt = fitPt(doc, 'E CHABOT', tailRoom, 6, 4);
  doc.setFontSize(wPt);
  doc.text('E CHABOT', tailX, 0.24, { baseline: 'top' });
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

  // Page = the actual label face: 3.5 wide x 0.4375 tall. landscape is required
  // so jsPDF keeps width > height (portrait would swap to 0.4375 wide x 3.5
  // tall and clip everything).
  const doc = new jsPDF({ unit: 'in', format: [LABEL_W, LABEL_H], orientation: 'landscape' });

  for (let i = 0; i < list.length; i++) {
    const fields = mapSampleToTagFields(list[i]);
    fields._qr = await qrDataUrl(fields.styleNumber);
    if (i > 0) doc.addPage([LABEL_W, LABEL_H], 'landscape');
    drawTag(doc, fields);
  }

  const url = doc.output('bloburl');
  const w = window.open(url, '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to preview tags.');
  return true;
}
