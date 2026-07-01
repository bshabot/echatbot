// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// Print-ready fallback for the sample tag. It draws the tag(s) as a 1:1 SVG of
// the exact dot coordinates from tagLayout.js - the SAME layout the ZPL emitter
// consumes, so what prints here equals the flat ZPL. Used when Zebra Browser
// Print isn't reachable.
//
// It opens a minimal document sized to the label (@page 3.5" x 0.625") and
// fires the print dialog automatically - no toolbar, no preview chrome, just
// the label ready to print. The QR is drawn from the sanitized style number,
// matching the ZPL QR payload exactly.
// ---------------------------------------------------------------------------

import { computeTagLayout, mapSampleToTagFields } from './tagLayout.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function qrDataUrl(text) {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(String(text || ' '), { margin: 1, errorCorrectionLevel: 'M', scale: 10 });
}

/** One primitive -> SVG (coords are printer dots = SVG user units). */
function elSVG(el, qr) {
  if (el.kind === 'qr') {
    return `<image x="${el.x}" y="${el.y}" width="${el.size}" height="${el.size}" href="${qr}" style="image-rendering:pixelated"/>`;
  }
  if (el.kind === 'text') {
    const fill = el.muted ? '#888' : '#000';
    const weight = el.bold ? '700' : '400';
    const yb = el.y + el.h * 0.8;
    return `<text x="${el.x}" y="${yb}" font-family="Arial, Helvetica, sans-serif" font-size="${el.h}" font-weight="${weight}" fill="${fill}">${esc(el.text)}</text>`;
  }
  return ''; // 'fold' guide is not printed
}

/** Flat, true-size SVG of the whole label (flag + tail). */
function flatSVG(layout, qr) {
  const body = layout.elements.map((el) => elSVG(el, qr)).join('');
  return `<svg class="tag" viewBox="0 0 ${layout.widthDots} ${layout.feedDots}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/**
 * Open a print-ready document for one or many export rows and fire the print
 * dialog. Each tag prints at true 3.5" x 0.625".
 * @param {object[]} rows
 * @param {object} [opts] { dpi=300, vendorsById, autoPrint=true }
 */
export async function openTagPreview(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const dpi = opts.dpi || 300;
  const autoPrint = opts.autoPrint !== false;

  const cards = [];
  for (const row of list) {
    const fields = mapSampleToTagFields(row, opts);
    const layout = computeTagLayout(fields, { dpi });
    const qr = await qrDataUrl(fields.styleNumber);
    cards.push(flatSVG(layout, qr));
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Sample tags (${list.length})</title>
  <style>
    @page{ size:3.5in 0.625in; margin:0; }
    html,body{ margin:0; padding:0; background:#fff; }
    svg.tag{ display:block; width:3.5in; height:0.625in; page-break-after:always; }
    svg.tag:last-child{ page-break-after:auto; }
  </style></head>
  <body>
    ${cards.join('\n')}
    <script>${autoPrint ? 'window.onload=function(){setTimeout(function(){window.print();},150);};' : ''}</script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to print tags.');
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
