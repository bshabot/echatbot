// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// PDF / print preview fallback for the sample tag.
//
// Renders the tag(s) as HTML at true physical size, with a REAL QR (the ZPL
// path lets the printer draw the QR; a PDF/screen needs one rendered in JS),
// opens them in a new tab, and triggers the browser print dialog -> "Save as
// PDF" or print to any normal printer. Use this for testing before Zebra
// Browser Print is installed. Toggle via printConfig.previewMode.
//
// Layout mirrors zplTag.js exactly: LEFT square = QR + weight (front),
// RIGHT square = style/metal/plating (becomes the back once folded), RAT
// TAIL (discard section, never folded) = manufacturer # just past the
// body/tail line, then the E CHABOT wordmark further out.
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

function squareLeft(fields, qr) {
  const weight = fields.weight != null && fields.weight !== '' ? `${esc(fields.weight)} g` : '';
  return `
    <div class="square left">
      <img class="qr" src="${qr}" alt="qr"/>
      ${weight ? `<div class="weight">${weight}</div>` : ''}
    </div>`;
}

function squareRight(fields) {
  const metal = [esc(fields.metalType), esc(fields.karat)].filter(Boolean).join(' ');
  const plating = esc(fields.plating);
  return `
    <div class="square right">
      <div class="row style">${esc(fields.styleNumber)}</div>
      ${metal ? `<div class="row">${metal}</div>` : ''}
      ${plating ? `<div class="row small">${plating}</div>` : ''}
    </div>`;
}

function ratTail(fields) {
  const mfr = esc(fields.manufacturerCode);
  return `
    <div class="tail">
      ${mfr ? `<div class="mfr">Mfr# ${mfr}</div>` : ''}
      <div class="tear"></div>
      <div class="wordmark">E CHABOT</div>
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
        <div class="cap">${esc(fields.styleNumber)} — flat print, folds at the dashed line, tear off the tail</div>
        <div class="flag">
          ${squareLeft(fields, qr)}
          <div class="fold"></div>
          ${squareRight(fields)}
          ${ratTail(fields)}
        </div>
      </div>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Sample tags (${list.length})</title>
  <style>
    :root { --sq: 0.4375in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 16px; background:#f4f4f5; color:#111; }
    .tag { margin: 0 0 22px; }
    .cap { font-size: 11px; color:#777; margin-bottom: 4px; }
    .flag { display:flex; align-items:stretch; width: 3.5in; height: 0.4375in;
            border:1px solid #ccc; background:#fff; transform: scale(3); transform-origin: top left;
            margin-bottom: 0.95in; }
    .square { position:relative; width: var(--sq); height: var(--sq); padding: 2px 3px; overflow:hidden; flex: 0 0 auto; }
    .square.left .qr { position:absolute; left:3px; top:2px; width: 0.30in; height:0.30in; image-rendering: pixelated; }
    .square.left .weight { position:absolute; left:3px; bottom:1px; font-size:6px; font-weight:700; }
    .square.right { display:flex; flex-direction:column; justify-content:flex-start; line-height:1.1; }
    .square.right .row { font-size:6.5px; font-weight:700; }
    .square.right .row.style { font-size:7px; }
    .square.right .row.small { font-size:5.5px; font-weight:400; }
    .fold { width:0; border-left:1px dashed #e0a0a0; }
    .tail { position:relative; flex: 1 1 auto; height: 100%; border-left:1px solid #ccc; }
    .tail .mfr { position:absolute; left: 0.06in; top: 2px; font-size:5.5px; white-space:nowrap; }
    .tail .tear { position:absolute; left: 1.3in; top:0; bottom:0; width:0;
                  border-left:1px dashed #bbb; }
    .tail .wordmark { position:absolute; left: 1.5in; top: 50%; transform: translateY(-50%);
                       font-weight:800; font-size:7px; letter-spacing:.3px; white-space:nowrap; }
    @media print {
      body { background:#fff; margin:0.3in; }
      .cap { display:none; }
      .flag { transform: none; border:1px dashed #bbb; margin: 0 0 0.18in; page-break-inside: avoid; }
    }
  </style></head>
  <body>
    <div class="hint" style="font-size:12px;color:#555;margin-bottom:10px">
      Preview only (not the Zebra path). Use your browser's Print dialog → "Save as PDF" or print.
      Shown 3× on screen; prints at true 3.5"×0.4375" (the rat tail tears off after folding).
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
