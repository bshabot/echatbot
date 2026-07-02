// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// Print-ready fallback for the sample tag: builds a REAL PDF, sized to the
// label (3.5" x 0.4375", one page per tag), and opens it in the browser's PDF
// viewer - ready to print (Ctrl/Cmd+P), no Letter page, no headers/footers.
// Used when Zebra Browser Print isn't reachable.
//
// It draws from the SAME layout as the ZPL emitter (tagLayout.js, coordinates
// in printer dots), so the PDF matches the flat ZPL exactly. The QR is drawn
// from the sanitized style number, matching the ZPL QR payload.
// ---------------------------------------------------------------------------

import { computeTagLayout, mapSampleToTagFields } from './tagLayout.js';

const LABEL_W_IN = 3.5;
const LABEL_LEN_IN = 0.4375; // PDF page = the LABEL = the driver's stock size.
// NOT the 0.625" feed: the driver owns the gap. A 0.625" page printed onto
// 0.4375" stock pushed everything ~0.1" down and clipped the bottom (7/1).

async function qrDataUrl(text) {
  const QRCode = (await import('qrcode')).default;
  // margin 0: the layout reserves the quiet zone around the symbol, exactly
  // like the ZPL ^BQ (which draws the bare symbol). Keeps PDF QR == print QR.
  return QRCode.toDataURL(String(text || ' '), { margin: 0, errorCorrectionLevel: 'M', scale: 10 });
}

/** Draw one tag's shared-layout elements onto the jsPDF page (unit: inches). */
function drawTag(doc, layout, qr) {
  const dpi = layout.dpi;
  const inch = (v) => v / dpi;      // printer dots -> inches
  const pt = (v) => (v * 72) / dpi; // dot height -> points
  for (const el of layout.elements) {
    if (el.kind === 'qr') {
      doc.addImage(qr, 'PNG', inch(el.x), inch(el.y), inch(el.size), inch(el.size));
    } else if (el.kind === 'text') {
      // Always bold + pure black: thermal transfer prints thin strokes and
      // dithered grey badly (Brian 7/1). 'muted' stays on the element for
      // screen previews, but the print file is solid black.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(pt(el.h));
      doc.setTextColor(0, 0, 0);
      const opts2 = { baseline: 'top' };
      if (el.stretch && el.stretch !== 1) opts2.charSpace = ((el.stretch - 1) * el.h * 0.5) / dpi;
      doc.text(String(el.text), inch(el.x), Math.max(0, inch(el.y)), opts2);
    }
  }
  doc.setTextColor(0, 0, 0);
}

/**
 * Build a real PDF of one or many tags and open it in the PDF viewer.
 * @param {object[]} rows
 * @param {object} [opts] { dpi=300, labelShift=0, vendorsById }
 */
export async function openTagPreview(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const dpi = opts.dpi || 300;
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'in', format: [LABEL_W_IN, LABEL_LEN_IN], orientation: 'landscape' });
  for (let i = 0; i < list.length; i++) {
    const fields = mapSampleToTagFields(list[i], opts);
    const layout = computeTagLayout(fields, { dpi, labelShift: opts.labelShift || 0 });
    const qr = await qrDataUrl(fields.styleNumber);
    if (i > 0) doc.addPage([LABEL_W_IN, LABEL_LEN_IN], 'landscape');
    drawTag(doc, layout, qr);
  }

  const url = doc.output('bloburl');
  const w = window.open(url, '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to print tags.');
  return true;
}
