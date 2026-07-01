// test/zplTag.test.mjs
// Run: node test/zplTag.test.mjs
// Assertions for the shared tag layout (tagLayout.js) + ZPL emitter (zplTag.js).

import {
  buildTagFromSample,
  buildBatchZPL,
} from '../src/utils/tags/zplTag.js';
import {
  computeTagLayout,
  mapSampleToTagFields,
  sanitizeStyleNumber,
  formatWeight,
  estimateWidth,
} from '../src/utils/tags/tagLayout.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  FAIL:', msg); }
}

const vendorsById = { 7: 'Aoxin' };

const row = {
  styleNumber: 'N3053NK-GP',
  salesWeight: 2.44,
  metalType: 'Silver',
  karat: '925',
  plating_label: '14k Gold Plated .5mic',
  manufacturerCode: 'N29568',
  vendor: 7,
};
// Dirty multi-line style number (the 73-char case).
const dirty = {
  ...row,
  styleNumber: 'G941HE-10Y\nSmaller 20% size of the original design per buyer request, keep stones',
};

// ---- data mapping / sanitize ----
ok(sanitizeStyleNumber(dirty.styleNumber) === 'G941HE-10Y', 'style number sanitized to first token');
ok(sanitizeStyleNumber('  N3053NK-GP  ') === 'N3053NK-GP', 'sanitize trims whitespace');
ok(formatWeight(2.44) === '2.4 gr', 'weight rounds to 1 decimal + gr');
ok(formatWeight(1.05) === '1.1 gr', 'weight rounds correctly');
ok(formatWeight(null) === '', 'null weight -> empty');

const f = mapSampleToTagFields(row, { vendorsById });
ok(f.styleNumber === 'N3053NK-GP', 'mapped style is sanitized');
ok(f.weight === '2.4 gr', 'mapped weight formatted');
ok(f.metal === 'Silver 925', 'metal = metalType + karat');
ok(f.plating === '14k Gold Plated .5mic', 'plating from plating_label');
ok(f.vendorName === 'AOXIN', 'vendor id resolved to uppercase name');

const f2 = mapSampleToTagFields({ ...row, vendor_name: 'amtai' }, { vendorsById });
ok(f2.vendorName === 'AMTAI', 'vendor_name column preferred, uppercased');

// ---- layout: single source of truth ----
const L = computeTagLayout(f, { dpi: 300 });
ok(L.widthDots === 1050, 'frame width 1050 dots (3.5in @300)');
ok(L.feedDots === 188, 'feed 188 dots (0.625in @300)');
const qr = L.elements.find((e) => e.kind === 'qr');
ok(qr && qr.payload === 'N3053NK-GP', 'QR payload = bare sanitized style number');
ok(qr.face === 'front', 'QR on the front face');

// No text element overflows its face box (auto-fit guarantee).
let overflow = 0;
for (const e of L.elements.filter((el) => el.kind === 'text')) {
  const boxRight = e.face === 'front' ? L.foldX : e.face === 'back' ? L.flagRight : L.widthDots;
  if (estimateWidth(e.text, e.h) > boxRight - e.x + 1) overflow++;
}
ok(overflow === 0, 'no text element overflows its box');

const texts = L.elements.filter((e) => e.kind === 'text');
ok(texts.some((e) => e.face === 'front' && e.text === '2.4'), 'weight number on front');
ok(texts.some((e) => e.face === 'back' && e.text === 'N3053NK-GP'), 'full style on back (not truncated)');
ok(texts.some((e) => e.face === 'back' && e.text === '14k Gold Plated .5mic'), 'full plating on back (not truncated)');
ok(texts.some((e) => e.face === 'above' && /MFG# N29568\s+AOXIN/.test(e.text)), 'MFG# + vendor above the tail');
ok(texts.some((e) => e.face === 'above' && e.muted), 'MFG# line is muted (grey reference)');
ok(texts.some((e) => e.face === 'tail' && e.text === 'E CHABOT'), 'E CHABOT on the tail');
ok(!texts.some((e) => e.face === 'tail' && e.text !== 'E CHABOT'), 'nothing else on the tail');

// dirty style shrinks to the sanitized token everywhere
const Ld = computeTagLayout(mapSampleToTagFields(dirty, { vendorsById }), { dpi: 300 });
ok(Ld.elements.find((e) => e.kind === 'qr').payload === 'G941HE-10Y', 'dirty style QR payload sanitized');
ok(Ld.elements.some((e) => e.face === 'back' && e.text === 'G941HE-10Y'), 'dirty style back text sanitized');

// ---- ZPL ----
const zpl = buildTagFromSample(row, { dpi: 300, backRotation: true, vendorsById });
ok(zpl.startsWith('^XA') && zpl.endsWith('^XZ'), 'wrapped ^XA..^XZ');
ok(zpl.includes('^PW1050'), 'print width full label (1050)');
ok(zpl.includes('^LL188'), 'label length 188');
ok(zpl.includes('^MNM') && zpl.includes('^MTT'), 'mark sensing + thermal transfer');
ok(zpl.includes('^FDMA,N3053NK-GP^FS'), 'QR payload = bare style number');
ok(!/https?:\/\//i.test(zpl) && !zpl.toLowerCase().includes('echabot.com'), 'QR has NO url/domain');
ok(zpl.includes('MFG# N29568') && zpl.includes('AOXIN'), 'MFG# + vendor printed');
ok(!zpl.includes('Mfr#'), 'old "Mfr#" label gone');
ok(zpl.includes('E CHABOT'), 'E CHABOT printed');
ok(!zpl.includes('^GFA'), 'no logo graphic on the tail (tail = E CHABOT text only)');
ok(!zpl.includes(' g^FS'), 'weight uses gr, not " g"');

// backRotation only affects the back face
ok(zpl.includes('^A0I,'), 'backRotation on -> back face uses inverted orientation');
const flat = buildTagFromSample(row, { dpi: 300, backRotation: false, vendorsById });
ok(!flat.includes('^A0I,'), 'backRotation off -> no inverted orientation (flat)');
ok(flat.includes('^FDMA,N3053NK-GP^FS'), 'flat still has bare-style QR');

// dirty style never leaks descriptive text into ZPL
const zd = buildTagFromSample(dirty, { dpi: 300, vendorsById });
ok(!zd.includes('Smaller'), 'dirty descriptive text never reaches ZPL');
ok(zd.includes('^FDMA,G941HE-10Y^FS'), 'dirty QR payload sanitized');

// batch
const batch = buildBatchZPL([row, { ...row, styleNumber: 'N2397R' }], { vendorsById });
ok((batch.match(/\^XA/g) || []).length === 2, 'batch = one label per row');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
