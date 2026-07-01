// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// PDF preview / print fallback for the sample tag.
//
// Renders the tag(s) as a REAL PDF, sized to the exact physical media frame,
// and opens it in the browser's PDF viewer. Ctrl/Cmd+P prints it 1:1 - the
// label, not an 8.5x11 sheet, and not scaled. No toolbar, no instructions,
// no on-screen chrome: just the rendered label.
//
// Layout (TJT-306, 3.50 x 0.4375 in; page built at this exact size). Element
// positions were placed on the interactive template and confirmed by Kevin -
// each text line is left/top-anchored at fixed inch coords and auto-shrinks to
// fit its width:
//   QR (0.09,0.09,0.28) + weight (0.62,0.18) -> QR with weight to its right
//   style (0.99,0.03) / metal (1.04,0.16) / plating (0.96,0.29) -> body right
//   Mfr# (1.95,0.03) + E CHABOT (1.97,0.24) -> out on the rat tail
// ---------------------------------------------------------------------------

import { mapSampleToTagFields } from './zplTag.js';

// Geometry (inches) - from the ZT TJT-306 die spec sheet. Label 3.50 x 0.4375.
// Element positions below are fixed X/Y (inches from the top-left of the label),
// dialed in on the interactive template and confirmed by Kevin. Each text line
// is left-anchored at its X, top-anchored at its Y, and shrinks to fit its width
// so nothing ever runs off the label.
const LABEL_W = 3.5;     // full label width (body + rat tail)
const LABEL_H = 0.4375;  // printable label height -> PDF page height

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

  // Draw one left-anchored, top-anchored line at (x,y) inches, at basePt but
  // shrunk to fit maxW so it can never run off the label.
  const line = (text, x, yTop, maxW, basePt, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const pt = fitPt(doc, text, maxW, basePt, 3.5);
    doc.setFontSize(pt);
    doc.text(String(text), x, yTop, { baseline: 'top' });
  };
  const RIGHT = LABEL_W - 0.04; // safe right edge

  // ---- QR + weight (weight sits to the right of the QR) ----
  doc.addImage(fields._qr, 'PNG', 0.09, 0.09, 0.28, 0.28);
  if (weight) line(weight, 0.62, 0.18, 0.30, 6, true);

  // ---- Style / metal / plating (right half of the body). Held left of the
  //      rat-tail text (~1.80) so the two blocks never collide. ----
  const bodyRight = 1.80;
  line(style, 0.99, 0.03, bodyRight - 0.99, 6.5, true);
  if (metal) line(metal, 1.04, 0.16, bodyRight - 1.04, 6, true);
  if (plating) line(plating, 0.96, 0.29, bodyRight - 0.96, 6, false);

  // ---- Mfr# + E CHABOT (out on the rat tail) ----
  if (mfr) line(mfr, 1.95, 0.03, RIGHT - 1.95, 6, false);
  line('E CHABOT', 1.97, 0.24, RIGHT - 1.97, 4, true);
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
