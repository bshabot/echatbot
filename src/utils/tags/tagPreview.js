// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// Print-ready fallback for the sample tag: builds a REAL PDF, sized to the
// label (3.5" x 0.625", one page per tag), and opens it in the browser's PDF
// viewer - ready to print (Ctrl/Cmd+P), no Letter page, no headers/footers.
// Used when Zebra Browser Print isn't reachable.
//
// It draws from the SAME layout as the ZPL emitter (tagLayout.js, coordinates
// in printer dots), so the PDF matches the flat ZPL exactly. The QR is drawn
// from the sanitized style number, matching the ZPL QR payload.
// ---------------------------------------------------------------------------

import { computeTagLayout, mapSampleToTagFields } from './tagLayout.js';

const LABEL_W_IN = 3.5;
const LABEL_LEN_IN = 0.625; // media repeat (label + gap) = the PDF page height

async function qrDataUrl(text) {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(String(text || ' '), { margin: 1, errorCorrectionLevel: 'M', scale: 10 });
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
      doc.setFont('helvetica', el.bold ? 'bold' : 'normal');
      doc.setFontSize(pt(el.h));
      doc.setTextColor(el.muted ? 136 : 0, el.muted ? 136 : 0, el.muted ? 136 : 0);
      doc.text(String(el.text), inch(el.x), inch(el.y), { baseline: 'top' });
    }
  }
  doc.setTextColor(0, 0, 0);
}

/**
 * Build a real PDF of one or many tags and open it in the PDF viewer.
 * @param {object[]} rows
 * @param {object} [opts] { dpi=300, vendorsById }
 */
export async function openTagPreview(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const dpi = opts.dpi || 300;
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'in', format: [LABEL_W_IN, LABEL_LEN_IN], orientation: 'landscape' });
  for (let i = 0; i < list.length; i++) {
    const fields = mapSampleToTagFields(list[i], opts);
    const layout = computeTagLayout(fields, { dpi });
    const qr = await qrDataUrl(fields.styleNumber);
    if (i > 0) doc.addPage([LABEL_W_IN, LABEL_LEN_IN], 'landscape');
    drawTag(doc, layout, qr);
  }

  const url = doc.output('bloburl');
  const w = window.open(url, '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to print tags.');
  return true;
}
