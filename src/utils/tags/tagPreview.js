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
//   - Label: 3.50 wide x 0.4375 high.
//   - Vertical repeat (media pitch): 0.625  -> this is the PDF PAGE HEIGHT, so
//     the printer driver doesn't rescale a short page up to the gap pitch
//     (that rescale was the "wrong scale / prints two labels" bug).
//   - Body (the folding flag): 1.75 wide -> folds at center into TWO 0.875
//     faces. (Earlier this was wrongly set to 0.875 total / 0.4375 faces,
//     which cramped the text and overlapped the QR.)
//   - Rat tail: the remaining 1.75 (discarded after folding).
//
//   LEFT face  (front) : QR + weight.
//   RIGHT face (back)  : style # / metal+karat / plating, right-aligned to the
//                        body edge so it lands right when folded over.
//   RAT TAIL (discard) : Mfr# + E CHABOT, just into the tail.
// ---------------------------------------------------------------------------

import { mapSampleToTagFields } from './zplTag.js';

// Geometry (inches) - from the ZT TJT-306 die spec sheet.
// (Label 3.50 x 0.4375; media pitch 0.625; body 1.75 = two 0.875 fold faces.)
const LABEL_W = 3.5;     // full label width (body + rat tail)
const LABEL_H = 0.4375;  // printable label height -> PDF page height
const BODY_W = 1.75;     // folding flag (two faces)
const FACE_W = 0.875;    // each fold face width
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

  const inset = 0.03;        // text inset from a face edge

  // ---- LEFT face (0..0.875): QR on the left, weight beside it ----
  const qrSize = LABEL_H * 0.84;
  const qrX = 0.04;
  const qrY = (LABEL_H - qrSize) / 2;
  doc.addImage(fields._qr, 'PNG', qrX, qrY, qrSize, qrSize);
  if (weight) {
    doc.setFont('helvetica', 'bold');
    const wMaxW = FACE_W - (qrX + qrSize) - inset - 0.02;
    const pt = fitPt(doc, weight, wMaxW, 9, 5);
    doc.setFontSize(pt);
    doc.text(weight, qrX + qrSize + 0.04, LABEL_H / 2, { baseline: 'middle' });
  }

  // ---- RIGHT face (0.875..1.75): style # / metal+karat / plating, each on
  //      ONE line (fit-to-width, no wrapping), right-aligned to the END of the
  //      body so it lands right when the body folds over at the center. The
  //      face is now a full 0.875in wide, so the type reads big. ----
  // Three lines must all fit the 0.4375in height, so the caps are kept modest
  // and the gaps tight - that keeps the (third) plating line from spilling off.
  const maxRight = FACE_W - inset;
  const edgeX = BODY_W - inset; // right edge of the body -> right-align here
  let y = 0.035;
  doc.setFont('helvetica', 'bold');
  const sPt = fitPt(doc, style, maxRight, 9, 5);
  doc.setFontSize(sPt);
  doc.text(style, edgeX, y, { baseline: 'top', align: 'right' });
  y += sPt * PT + 0.016;
  if (metal) {
    const mPt = fitPt(doc, metal, maxRight, 8, 5);
    doc.setFontSize(mPt);
    doc.text(metal, edgeX, y, { baseline: 'top', align: 'right' });
    y += mPt * PT + 0.016;
  }
  if (plating) {
    doc.setFont('helvetica', 'normal');
    const pPt = fitPt(doc, plating, maxRight, 7, 5);
    doc.setFontSize(pPt);
    doc.text(plating, edgeX, y, { baseline: 'top', align: 'right' });
  }

  // ---- RAT TAIL (1.75..3.5): Mfr# on top, E CHABOT below, set clearly onto
  //      the tail (past the body fold line at 1.75). ----
  const tailX = BODY_W + 0.22; // ~0.22in onto the tail, clearly off the body
  const tailRoom = LABEL_W - tailX - 0.06;
  if (mfr) {
    doc.setFont('helvetica', 'normal');
    const fPt = fitPt(doc, mfr, tailRoom, 9, 5);
    doc.setFontSize(fPt);
    doc.text(mfr, tailX, 0.05, { baseline: 'top' });
  }
  doc.setFont('helvetica', 'bold');
  const wPt = fitPt(doc, 'E CHABOT', tailRoom, 8, 5);
  doc.setFontSize(wPt);
  doc.text('E CHABOT', tailX, 0.23, { baseline: 'top' });
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
