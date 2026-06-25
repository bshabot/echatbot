// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// PDF / print preview fallback for the sample tag.
//
// Renders the tag(s) as HTML at true physical size, with a REAL QR (the ZPL
// path lets the printer draw the QR; a PDF/screen needs one rendered in JS),
// opens them in a new tab, and triggers the browser print dialog -> "Save as
// PDF" or print to any normal printer. Use this for testing before Zebra
// Browser Print is installed. Toggle via printConfig.previewMode.
// ---------------------------------------------------------------------------

import { mapSampleToTagFields } from './zplTag.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function qrDataUrl(text) {
  // Dynamic import so it only loads in preview mode.
  const QRCode = (await import('qrcode')).default;
  return QRCode.toDataURL(String(text), { margin: 0, errorCorrectionLevel: 'M', scale: 8 });
}

function faceFront(fields, qr) {
  return `
    <div class="face">
      <img class="qr" src="${qr}" alt="qr"/>
      <div class="style">${esc(fields.styleNumber)}</div>
    </div>`;
}

function faceBack(fields) {
  const weight = fields.weight != null && fields.weight !== '' ? `${esc(fields.weight)} g` : '';
  const metal = [esc(fields.metalType), esc(fields.karat)].filter(Boolean).join(' ');
  const plating = esc(fields.plating);
  return `
    <div class="face back">
      <div class="wordmark">E CHABOT</div>
      <div class="est">EST. 1993</div>
      ${weight ? `<div class="row big">${weight}</div>` : ''}
      ${metal ? `<div class="row big">${metal}</div>` : ''}
      ${plating ? `<div class="row">${plating}</div>` : ''}
    </div>`;
}

/**
 * Open a printable preview (savable as PDF) for one or many sample rows.
 * @param {object[]} rows  export-view rows
 * @param {object} [opts]  { autoPrint = true }
 */
export async function openTagPreview(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const autoPrint = opts.autoPrint !== false;

  const cards = [];
  for (const row of list) {
    const fields = mapSampleToTagFields(row);
    const qr = await qrDataUrl(fields.styleNumber);
    cards.push(`
      <div class="tag">
        <div class="cap">${esc(fields.styleNumber)} — flat print, folds at the dashed line</div>
        <div class="flag">
          ${faceFront(fields, qr)}
          <div class="fold"></div>
          ${faceBack(fields)}
        </div>
      </div>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Sample tags (${list.length})</title>
  <style>
    :root { --face: 0.4375in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 16px; background:#f4f4f5; color:#111; }
    .tag { margin: 0 0 22px; }
    .cap { font-size: 11px; color:#777; margin-bottom: 4px; }
    .flag { display:flex; align-items:stretch; width: 0.875in; height: 0.4375in;
            border:1px solid #ccc; background:#fff; transform: scale(3); transform-origin: top left;
            margin-bottom: 0.95in; }
    .face { position:relative; width: var(--face); height: var(--face); padding: 2px 3px; overflow:hidden; }
    .face .qr { position:absolute; left:3px; top:2px; width: 0.30in; height:0.30in; image-rendering: pixelated; }
    .face .style { position:absolute; left:3px; bottom:1px; font-size:6px; font-weight:700; }
    .fold { width:0; border-left:1px dashed #e0a0a0; }
    .back { display:flex; flex-direction:column; justify-content:flex-start; line-height:1.05; }
    .back .wordmark { font-weight:800; font-size:7px; letter-spacing:.3px; }
    .back .est { font-size:5px; margin-bottom:1px; }
    .back .row { font-size:6px; }
    .back .row.big { font-weight:700; font-size:6.5px; }
    @media print {
      body { background:#fff; margin:0.3in; }
      .cap { display:none; }
      .flag { transform: none; border:1px dashed #bbb; margin: 0 0 0.18in; page-break-inside: avoid; }
    }
  </style></head>
  <body>
    <div class="hint" style="font-size:12px;color:#555;margin-bottom:10px">
      Preview only (not the Zebra path). Use your browser's Print dialog → "Save as PDF" or print.
      Shown 3× on screen; prints at true 0.875"×0.4375".
    </div>
    ${cards.join('\n')}
    <script>${autoPrint ? 'window.onload=()=>setTimeout(()=>window.print(),350);' : ''}</script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to preview tags.');
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
