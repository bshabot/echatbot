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
  plating: 4,
  plating_label: '14k Gold Plated .5mic',
};

const fields = mapSampleToTagFields(row);
ok(fields.weight === 2.75, 'weight maps from salesWeight');
ok(fields.plating === '14k Gold Plated .5mic', 'plating uses plating_label');

const zpl = buildTagFromSample(row);
ok(zpl.startsWith('^XA') && zpl.endsWith('^XZ'), 'wrapped in ^XA..^XZ');
ok(zpl.includes('^BQN,2,'), 'uses native ZPL QR (^BQ)');
ok(zpl.includes('^FDMA,GPFB154-10KYG^FS'), 'QR payload is the bare style number');
ok(!/https?:\/\//i.test(zpl) && !zpl.toLowerCase().includes('echabot.com'), 'QR contains NO url/domain (vendor rule)');
ok(zpl.includes('^MNM'), 'black-mark sensing set');
ok(zpl.includes('^MTT'), 'thermal transfer set');
ok(zpl.includes('14k Gold Plated .5mic'), 'plating label printed');
ok(zpl.includes('2.75 g'), 'weight printed with unit');
ok(zpl.includes('Silver 925'), 'metal + karat printed');
ok(zpl.includes('EST. 1993'), 'EST. 1993 printed as type');

// none/omit plating
const noPlate = buildTagFromSample({ ...row, plating_label: null, plating: 1 });
ok(!noPlate.includes('14k Gold'), 'null plating_label omits plating');

// long plating shrinks but still appears
const longPlate = buildTagFromSample({ ...row, plating_label: 'IP Silver Plated XL' });
ok(longPlate.includes('IP Silver Plated XL'), 'long plating still rendered (shrunk)');

// dpi parametrization: 203 dpi changes geometry
const z203 = buildSampleTagZPL(fields, { dpi: 203 });
const z300 = buildSampleTagZPL(fields, { dpi: 300 });
ok(z203 !== z300 && z203.includes('^PW178'), 'dpi parametrizes geometry (203 -> ^PW178)');

// back rotation flag toggles orientation
const rot = buildSampleTagZPL(fields, { backRotation: true });
ok(rot.includes('^A0I,'), 'backRotation uses inverted (180) orientation');

// batch
const batch = buildBatchZPL([row, { ...row, styleNumber: 'N2397R' }]);
ok((batch.match(/\^XA/g) || []).length === 2, 'batch produces one label per row');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
