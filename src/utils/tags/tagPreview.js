// src/utils/tags/tagPreview.js
// ---------------------------------------------------------------------------
// On-screen preview for the sample tag. It is a 1:1 SVG DRAWING of the exact
// dot coordinates from tagLayout.js - the SAME layout the ZPL emitter consumes.
// There is no separate preview layout anymore: what you see here is the flat
// print. (The only thing the physical print adds is the optional 180 back-face
// rotation, applied in zplTag.js; the flat preview matches the flat ZPL.)
//
// Renders each tag flat at true physical size (3.5" x 0.625") plus a folded
// view (front | back, back rotated so it reads as the finished tag). Prints via
// the browser at true size (@page). The QR is drawn from the sanitized style
// number, matching the ZPL QR payload exactly.
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

/** One text/qr/fold primitive -> SVG (coords are printer dots = SVG user units). */
function elSVG(el, qr) {
  if (el.kind === 'qr') {
    return `<image x="${el.x}" y="${el.y}" width="${el.size}" height="${el.size}" href="${qr}" style="image-rendering:pixelated"/>`;
  }
  if (el.kind === 'fold') {
    return `<line x1="${el.x}" y1="${el.y0}" x2="${el.x}" y2="${el.y1}" stroke="#c39" stroke-width="2" stroke-dasharray="5 4" opacity="0.6"/>`;
  }
  if (el.kind === 'text') {
    const fill = el.muted ? '#888' : '#000';
    const weight = el.bold ? '700' : '400';
    const yb = el.y + el.h * 0.8;
    return `<text x="${el.x}" y="${yb}" font-family="Arial, Helvetica, sans-serif" font-size="${el.h}" font-weight="${weight}" fill="${fill}">${esc(el.text)}</text>`;
  }
  return '';
}

/** Flat, true-size SVG of the whole label (flag + tail). */
function flatSVG(layout, qr) {
  const body = layout.elements.map((el) => elSVG(el, qr)).join('');
  return `<svg class="flat" viewBox="0 0 ${layout.widthDots} ${layout.feedDots}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${layout.topMargin}" width="${layout.foldX * 2}" height="${layout.flagH}" fill="#fff" stroke="#ddd" stroke-width="1"/>
    ${body}
  </svg>`;
}

/** One folded face (0.4375" square). back=true rotates 180 to show finished orientation. */
function faceSVG(layout, faceName, qr, rotate180) {
  const { foldX, faceW, topMargin, flagH } = layout;
  const x0 = faceName === 'front' ? 0 : foldX;
  const cx = x0 + faceW / 2;
  const cy = topMargin + flagH / 2;
  const parts = layout.elements
    .filter((el) => el.face === faceName && el.kind !== 'fold')
    .map((el) => elSVG(el, qr))
    .join('');
  const g = rotate180 ? `<g transform="rotate(180 ${cx} ${cy})">${parts}</g>` : parts;
  return `<svg class="face" viewBox="${x0} ${topMargin} ${faceW} ${flagH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${x0}" y="${topMargin}" width="${faceW}" height="${flagH}" fill="#fff" stroke="#ccc" stroke-width="1"/>
    ${g}
  </svg>`;
}

/**
 * Open a printable preview for one or many export rows.
 * @param {object[]} rows
 * @param {object} [opts] { dpi=300, vendorsById }
 */
export async function openTagPreview(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const dpi = opts.dpi || 300;

  const cards = [];
  for (const row of list) {
    const fields = mapSampleToTagFields(row, opts);
    const layout = computeTagLayout(fields, { dpi });
    const qr = await qrDataUrl(fields.styleNumber);
    cards.push(`
      <div class="tag">
        <div class="cap">${esc(fields.styleNumber)} — flat label (folds at the pink line; tail tears off)</div>
        ${flatSVG(layout, qr)}
        <div class="folded">
          <div class="fcol"><div class="flbl">FRONT</div>${faceSVG(layout, 'front', qr, false)}</div>
          <div class="fcol"><div class="flbl">BACK (folded)</div>${faceSVG(layout, 'back', qr, true)}</div>
        </div>
      </div>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Sample tags (${list.length})</title>
  <style>
    *{ box-sizing:border-box; }
    body{ font-family:Arial,Helvetica,sans-serif; margin:16px; background:#f4f4f5; color:#111; }
    .toolbar{ display:flex; align-items:center; gap:10px; margin-bottom:14px; }
    .toolbar button{ font-size:13px; font-weight:700; padding:8px 16px; border-radius:6px; border:1px solid #1a7a4c; background:#1a7a4c; color:#fff; cursor:pointer; }
    .hint{ font-size:12px; color:#555; }
    .tag{ margin:0 0 26px; }
    .cap{ font-size:11px; color:#777; margin-bottom:4px; }
    svg.flat{ width:7in; height:1.25in; background:#fff; border:1px solid #e2e2e2; }
    .folded{ display:flex; gap:14px; margin-top:10px; }
    .fcol{ text-align:center; }
    .flbl{ font-size:10px; color:#999; margin-bottom:3px; }
    svg.face{ width:1.4in; height:1.4in; background:#fff; border:1px solid #e2e2e2; }
    @media print{
      @page{ size:3.5in 0.625in; margin:0; }
      body{ background:#fff; margin:0; }
      .toolbar,.cap,.folded{ display:none !important; }
      .tag{ margin:0; page-break-after:always; }
      svg.flat{ width:3.5in; height:0.625in; border:none; }
    }
  </style></head>
  <body>
    <div class="toolbar">
      <button type="button" onclick="window.print()">Print ${list.length > 1 ? `${list.length} tags` : 'tag'}</button>
      <div class="hint">1:1 with the printer. Driver: stock length 0.625″, gap sensing, margins None, scale 100%.</div>
    </div>
    ${cards.join('\n')}
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) throw new Error('Popup blocked — allow pop-ups for this site to preview tags.');
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
