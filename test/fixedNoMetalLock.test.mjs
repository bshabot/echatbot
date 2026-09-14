// test/fixedNoMetalLock.test.mjs
// Run: node test/landedCost.test.mjs
//
// "Fixed no metal lock" SKUs (the brass / 7117 program) are billed off Signet's
// frozen merchant unit cost x the PO tariff, not the cost sheet. Fixtures are
// the real rows as of 2026-09-14 — the bug this guards against predicted 7.99
// on a 10.01 PO line and showed brass lines as false mismatches.
//
// Verified against all 89 brass PO lines in the DB: unitCost x (1 + tariff)
// matches every one to the cent. piece_cost_subtotal x (1 + tariff) matched 82.

import {
  recomputeSignetBill,
  rebillFromActualPrice,
  backEngineerMetalRate,
  isFixedNoMetalLock,
  fixedBaseCost,
} from '../src/utils/runningLinesMath.js';
import {
  reconcilePO,
  buildSkuMap,
  groupComponents,
  detectTariff,
} from '../src/utils/reconcilePOLines.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL:', msg);
  }
}
const near = (a, b, eps = 0.005) => a != null && Math.abs(a - b) <= eps;

const brass = (over) => ({
  duty_rate: 11,
  total_net_weight: 0,
  item_count: 1,
  costing_method: 'fixed no metal lock',
  ...over,
});
const brassMat = (ssp) => ({
  ssp_number: ssp,
  material_type: 'brass',
  metal_purity: 0,
  metal_base_price: 0,
  metal_loss_percent: 0,
  material_net_weight: 0,
  material_cost: 0.1,
});

const skus = [
  brass({ ssp_number: 'S166397', sku_number: '20630565', vendor_style_number: 'B1462R-BLK-GM/10',
          piece_cost_subtotal: 7.99, discount_piece_cost_subtotal: 7.99,
          landed_cost: 10.01, merchant_unit_cost: 9.1, tax_percent: 10 }),
  brass({ ssp_number: 'S166405', sku_number: '20630485', vendor_style_number: 'BHSP-100',
          piece_cost_subtotal: 6.64, discount_piece_cost_subtotal: 6.64,
          landed_cost: 7.304, merchant_unit_cost: 6.64, tax_percent: 10 }),
  // control — a normal metal-locked silver SKU must be completely unaffected
  { ssp_number: 'SCTRL', sku_number: '20608774', vendor_style_number: 'ZS809E-6-new',
    piece_cost_subtotal: 4.86, discount_piece_cost_subtotal: 4.86, duty_rate: 16.25,
    total_net_weight: 1.2, item_count: 1, costing_method: 'labor per gram',
    landed_cost: 5.51, merchant_unit_cost: 5.01, tax_percent: 10 },
];
const comps = [
  brassMat('S166397'),
  brassMat('S166405'),
  { ssp_number: 'SCTRL', material_type: 'silver', metal_purity: '925', metal_karat: 'sterling',
    metal_base_price: 66.84, metal_loss_percent: 3, material_net_weight: 1.2, material_cost: 2.61 },
];
const lines = [
  { sku_number: '20630565', vendor_style_number: 'B1462R-BLK-GM/10', quantity: 100, unit_price: 10.01, total_price: 1001 },
  { sku_number: '20630485', vendor_style_number: 'BHSP-100', quantity: 99, unit_price: 7.3, total_price: 722.7 },
  { sku_number: '20608774', vendor_style_number: 'ZS809E-6-new', quantity: 100, unit_price: 5.35, total_price: 535 },
];

// --- detection -------------------------------------------------------------
ok(isFixedNoMetalLock(skus[0]), 'brass SKU detected as fixed-no-metal-lock');
ok(!isFixedNoMetalLock(skus[2]), 'silver SKU NOT detected as fixed-no-metal-lock');
ok(!isFixedNoMetalLock(null), 'null SKU is not fixed-no-metal-lock');
ok(isFixedNoMetalLock({ costing_method: ' Fixed No Metal Lock ' }), 'match is case/space tolerant');

// --- prediction: unitCost x (1 + tariff) ----------------------------------
const at = (sku, cs, o = {}) =>
  recomputeSignetBill(sku, cs, { silver: 66.84, gold: 4084.2, tariffPct: 0, upchargePct: 0, ...o });

ok(near(fixedBaseCost(skus[0]), 9.1), 'base cost is the frozen merchant unit cost, not the sheet');
ok(fixedBaseCost(skus[2]) === null, 'silver SKU has no fixed base cost');

// PO 169585 / 162618 — the case that started this.
ok(near(at(skus[0], [comps[0]], { tariffPct: 10 }), 10.01), '20630565 @10% predicts 10.01 (was 7.99 off the sheet)');
ok(near(at(skus[1], [comps[1]], { tariffPct: 10 }), 7.304), '20630485 @10% predicts 7.304 (PO paid 7.30)');
ok(near(at(skus[0], [comps[0]], { tariffPct: 0 }), 9.1), 'tariff still applies — 0% gives the bare unit cost');
ok(near(at(skus[0], [comps[0]], { tariffPct: 20 }), 10.92), '20% adder applies too (the Feb POs)');
ok(near(at(skus[2], [comps[2]]), 4.86), 'silver control still predicts 4.86 off the cost sheet');

// The metal lock must not move a fixed price; Brian's upcharge still does.
ok(near(at(skus[0], [comps[0]], { tariffPct: 10, silver: 120, gold: 6000 }), 10.01),
   'fixed price ignores the metal lock');
ok(near(at(skus[0], [comps[0]], { tariffPct: 10, upchargePct: 4 }), 10.4104),
   "Brian's upcharge rides on top");
ok(near(at(skus[0], [], { tariffPct: 10 }), 10.01), 'fixed price needs no component rows');

// Rows scraped before merchant_unit_cost was mapped keep the old behaviour.
ok(near(at({ ...skus[0], merchant_unit_cost: null }, [comps[0]], { tariffPct: 10 }), 8.789),
   'no merchant_unit_cost -> falls back to the cost sheet x tariff');

// --- these lines must never vote on a metal lock ---------------------------
ok(backEngineerMetalRate(lines[0], skus[0], [comps[0]], { tariffPct: 0, upchargePct: 0 }) === null,
   'brass line implies no metal rate');

// --- ...but they ARE the best tariff signal on the PO ----------------------
// paid / unitCost is a pure tariff ratio with no metal noise, so a brass-only
// PO detects its own adder. PO 169585 is stored at 0% and is really 10%.
const brassOnly = [lines[0]];
ok(detectTariff({ tariff_percent: 0 }, brassOnly, buildSkuMap(skus), groupComponents(comps), null) === 10,
   'a brass-only PO detects its 10% adder (169585 was stored as 0%)');

// --- rebill ----------------------------------------------------------------
ok(near(rebillFromActualPrice(lines[0], skus[0], [comps[0]], {
  oldTariffPct: 10, oldUpchargePct: 0, oldLockRate: 0,
  newSilver: 80, newGold: 4200, newTariffPct: 10, newUpchargePct: 0,
}), 10.01), 'rebill at the same tariff returns the same price');

// --- full reconcile --------------------------------------------------------
const r = reconcilePO(
  { po_number: 'TEST', tariff_percent: 10 },
  lines,
  buildSkuMap(skus),
  groupComponents(comps),
  10,
  { silver_lock: 66.84, gold_lock: 4084.2 }
);
ok(r.rows.every((x) => x.reconcile === true), 'every line reconciles at the PO tariff');

console.log(`fixedNoMetalLock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
