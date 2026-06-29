// test/zplTag.test.mjs
// Run: node test/zplTag.test.mjs
// Lightweight assertions for the ZPL tag generator (no test framework needed).

import {
  buildSampleTagZPL,
  buildTagFromSample,
  buildBatchZPL,
  mapSampleToTagFields,
} from '../src/utils/tags/zplTag.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); }
}

// A representative export-view row.
const row = {
  styleNumber: 'GPFB154-10KYG',
  salesWeight: 2.75,
  metalType: 'Silver',
  karat: '925',
  manufacturerCode: 'E12345',
  plating: 4,
  plating_label: '14k Gold Plated .5mic',
};

const fields = mapSampleToTagFields(row);
ok(fields.weight === 2.75, 'weight maps from salesWeight');
ok(fields.plating === '14k Gold Plated .5mic', 'plating uses plating_label');
ok(fields.manufacturerCode === 'E12345', 'manufacturerCode maps through');

const zpl = buildTagFromSample(row);
ok(zpl.startsWith('^XA') && zpl.endsWith('^XZ'), 'wrapped in ^XA..^XZ');
ok(zpl.includes('^BQN,2,'), 'uses native ZPL QR (^BQ)');
ok(zpl.includes('^FDMA,GPFB154-10KYG^FS'), 'QR payload is the bare style number');
ok(!/https?:\/\//i.test(zpl) && !zpl.toLowerCase().includes('echabot.com'), 'QR contains NO url/domain (vendor rule)');
ok(zpl.includes('^MNM'), 'black-mark sensing set');
ok(zpl.includes('^MTT'), 'thermal transfer set');
ok(zpl.includes('14k Gold Plated .5mic'), 'plating label printed (right square)');
ok(zpl.includes('2.75 g'), 'weight printed with unit (left square)');
ok(zpl.includes('Silver 925'), 'metal + karat printed (right square)');
ok(zpl.includes('Mfr# E12345'), 'manufacturer # printed on the rat tail');
ok(zpl.includes('E CHABOT') || zpl.includes('^GFA'), 'E CHABOT wordmark printed on the rat tail (text or logo graphic)');
ok(!zpl.includes('EST. 1993'), 'EST. 1993 dropped per approved layout');

// Print width must span the FULL label (body + rat tail), not just the body -
// otherwise the mfr#/wordmark on the tail would be clipped by the printer.
ok(zpl.includes('^PW1050'), 'print width covers the full 3.5in label at 300dpi (^PW1050)');

// none/omit plating
const noPlate = buildTagFromSample({ ...row, plating_label: null, plating: 1 });
ok(!noPlate.includes('14k Gold'), 'null plating_label omits plating');

// no manufacturer code -> no Mfr# line, but wordmark still prints
const noMfr = buildTagFromSample({ ...row, manufacturerCode: null });
ok(!noMfr.includes('Mfr#'), 'missing manufacturerCode omits the Mfr# line');
ok(noMfr.includes('E CHABOT') || noMfr.includes('^GFA'), 'wordmark still prints without a manufacturer code');

// long plating shrinks but still appears
const longPlate = buildTagFromSample({ ...row, plating_label: 'IP Silver Plated XL' });
ok(longPlate.includes('IP Silver Plated XL'), 'long plating still rendered (shrunk)');

// dpi parametrization: 203 dpi changes geometry (full-label print width)
const z203 = buildSampleTagZPL(fields, { dpi: 203 });
const z300 = buildSampleTagZPL(fields, { dpi: 300 });
ok(z203 !== z300 && z203.includes('^PW711'), 'dpi parametrizes geometry (203dpi -> ^PW711, full 3.5in label)');

// back rotation flag toggles orientation on the right square (style/metal/plating)
const rot = buildSampleTagZPL(fields, { backRotation: true });
ok(rot.includes('^A0I,'), 'backRotation uses inverted (180) orientation on the right square');
ok(rot.includes('Mfr# E12345'), 'rat tail content is unaffected by backRotation (never folded)');

// batch
const batch = buildBatchZPL([row, { ...row, styleNumber: 'N2397R' }]);
ok((batch.match(/\^XA/g) || []).length === 2, 'batch produces one label per row');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
