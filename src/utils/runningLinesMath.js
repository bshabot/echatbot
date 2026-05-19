// runningLinesMath.js
//
// Pure functions for /running-lines, /purchase-orders, /back-engineering.
// No React. No Supabase. Easy to unit-test.
//
// =====================================================================
// SIGNET FORMULA — direct recompute from user-input lock (no VPC anchor)
// =====================================================================
// Per Brian (verified against SSP training PDF, 2026-05-19):
//
//   Metal Price per gram (ppg) = ((lock + acquisition_cost) × purity) / 31.1
//   Finish Loss $              = (weight / ((100 − L) / 100)) × (L/100) × ppg
//                              = weight × L/(100−L) × ppg
//                              = base_metal × L/(100−L)
//   Total Metal Cost           = (ppg × weight) + Finish Loss $
//
//   Vendor Unit Cost = Total Metal Cost + Labor + Stone + Findings
//                      + Bag&Tag + Duty
//
// BRIAN'S DUTY RULE (different from Signet's stored data):
//   - Duty applies to base metal + labor + stone + findings + bag&tag
//   - Duty does NOT apply to finish loss $
//
// IMPLEMENTATION STRATEGY:
//   - Use sku.piece_cost_subtotal (or discount_piece_cost_subtotal) as the
//     authoritative "everything-non-metal" baseline by SUBTRACTING Signet's
//     own metal-at-matrix-lock from it. Whatever remains is the labor /
//     stone / findings / bag-tag / overcost stack — preserved exactly.
//   - Then ADD our own metal at the user's input lock with Brian's duty rule.
//
//   piece = piece_cost_subtotal                         // signet's piece
//         − (signet_base + signet_loss) × (1 + duty)    // strip signet's metal w/ full duty
//         + our_base × (1 + duty)                       // add base back, w/ duty
//         + our_loss                                    // add loss back, NO duty
//
// At user_lock == matrix_lock, our piece = signet's piece − signet_loss × duty
// (small reduction reflecting Brian's no-duty-on-loss rule). Expected.
// =====================================================================

const GRAMS_PER_TROY_OUNCE = 31.1; // Signet's convention — NOT 31.1035

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function purityFactorFromMaterial(m) {
  // metal_purity is parts per thousand (925, 585, 417, 750, 1000).
  const raw = safeNum(m?.metal_purity);
  if (raw > 1) return raw / 1000;
  if (raw > 0) return raw;
  const karat = String(m?.metal_karat || "").toUpperCase().replace(/\s+/g, "");
  const map = {
    "10K": 0.417,
    "14K": 0.585,
    "18K": 0.75,
    "22K": 0.916,
    "24K": 1.0,
    SILVER: 0.925,
    STERLING: 0.925,
    "925": 0.925,
    BRASS: 1.0,
    BRONZE: 1.0,
  };
  return map[karat] ?? 0.925;
}

// Determine which spot rate ($/oz) applies for a component row. Brass /
// bronze / base metal returns 0 — no metal-price exposure.
function rateForMaterial(m, inputs) {
  const blob = `${m?.material_type || ""} ${m?.metal_karat || ""} ${m?.metal_color || ""}`.toLowerCase();
  if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) return 0;
  if (blob.includes("gold") || /\b\d+k\b/i.test(blob)) return safeNum(inputs.gold);
  if (blob.includes("silver") || blob.includes("sterling")) return safeNum(inputs.silver);

  // Fallback: metal_purity
  const rawPurity = safeNum(m?.metal_purity);
  if (rawPurity > 0) {
    if (rawPurity === 925 || rawPurity === 0.925) return safeNum(inputs.silver);
    if (
      rawPurity === 417 ||
      rawPurity === 585 ||
      rawPurity === 750 ||
      rawPurity === 916 ||
      rawPurity === 1000 ||
      (rawPurity >= 0.4 && rawPurity <= 1.0 && rawPurity !== 0.925)
    ) {
      return safeNum(inputs.gold);
    }
  }
  return safeNum(inputs.silver);
}

// Returns the per-component weight from any of the supported field names.
function componentWeight(c) {
  return safeNum(c.material_net_weight ?? c.finding_net_weight ?? c.chain_net_weight);
}

// ============================================================
// resolveMetal(materials) — for UI labeling only
// ============================================================
export function resolveMetal(materials) {
  if (!Array.isArray(materials) || materials.length === 0) {
    return { metalType: "Silver", karat: "Sterling", purity: 0.925 };
  }
  const sorted = [...materials].sort(
    (a, b) => safeNum(b.material_net_weight) - safeNum(a.material_net_weight)
  );
  const m = sorted[0];
  const karat = m.metal_karat || m.metal_purity || "";
  const purity = purityFactorFromMaterial(m);
  const blob =
    `${m.material_type || ""} ${m.metal_karat || ""} ${m.metal_purity || ""} ${m.metal_color || ""}`.toLowerCase();
  let metalType = "Silver";
  if (blob.includes("brass") || blob.includes("bronze")) metalType = "Brass";
  else if (blob.includes("gold") || /\b(10k|14k|18k|22k|24k)\b/.test(blob)) metalType = "Gold";
  return { metalType, karat, purity };
}

// ============================================================
// computeMetalStack(components, lockOverrides)
//
// Brian's formula applied across all metal-bearing components.
// `lockOverrides` is { silver, gold } in $/oz. If a component has its
// own metal_base_price ($/oz), that's used for the matrix calculation
// instead of the input lock.
//
// Returns { baseTotal, lossTotal } in $.
// ============================================================
function computeMetalStack(components, ratesByMetal) {
  let baseTotal = 0;
  let lossTotal = 0;
  if (!Array.isArray(components)) return { baseTotal, lossTotal };

  for (const c of components) {
    const w = componentWeight(c);
    if (w === 0) continue;
    const rate = rateForMaterial(c, ratesByMetal);
    if (rate === 0) continue; // brass / no-metal
    const purity = purityFactorFromMaterial(c);
    const acq = safeNum(c.acquisition_cost); // metalFixingAllowAmt; 0 if not scraped
    const L = safeNum(c.metal_loss_percent);
    const ppg = ((rate + acq) * purity) / GRAMS_PER_TROY_OUNCE;
    const base = w * ppg;
    // L/(100-L) form. If L >= 100 (shouldn't happen) clamp to avoid div-by-zero.
    const lossFactor = L < 100 ? L / (100 - L) : 0;
    const loss = base * lossFactor;
    baseTotal += base;
    lossTotal += loss;
  }

  return { baseTotal, lossTotal };
}

// Use each component's stored metal_base_price as the rate (Signet's matrix).
function computeSignetMatrixMetal(components) {
  let baseTotal = 0;
  let lossTotal = 0;
  if (!Array.isArray(components)) return { baseTotal, lossTotal };

  for (const c of components) {
    const w = componentWeight(c);
    if (w === 0) continue;
    const matrixRate = safeNum(c.metal_base_price);
    if (matrixRate === 0) continue; // brass
    const purity = purityFactorFromMaterial(c);
    const acq = safeNum(c.acquisition_cost);
    const L = safeNum(c.metal_loss_percent);
    const ppg = ((matrixRate + acq) * purity) / GRAMS_PER_TROY_OUNCE;
    const base = w * ppg;
    const lossFactor = L < 100 ? L / (100 - L) : 0;
    const loss = base * lossFactor;
    baseTotal += base;
    lossTotal += loss;
  }

  return { baseTotal, lossTotal };
}

// ============================================================
// recomputeSignetBill(sku, components, inputs)
//
// FORWARD bill — what we'd bill Signet at the user's chosen metal lock.
//
// inputs:
//   silver, gold        — user-chosen $/oz
//   tariffPct           — % on top of piece (e.g. 10, 20, 0)
//   upchargePct         — % on top of piece (default 4)
//
// Steps:
//   1. signetMetal = base+loss at component matrix prices (with full duty)
//   2. ourMetal    = base+loss at user lock (with Brian's duty rule)
//   3. piece       = sku.piece_cost_subtotal − signetMetal + ourMetal
//   4. unitPrice   = piece × (1+tariff) × (1+upcharge)
//
// VPC is NOT used. Brian's call 2026-05-19.
// ============================================================
export function recomputeSignetBill(sku, components, inputs) {
  if (!sku) return 0;

  const dutyRate = safeNum(sku.duty_rate) / 100;
  const tariff = safeNum(inputs.tariffPct) / 100;
  const upcharge = safeNum(inputs.upchargePct) / 100;

  // Signet's metal at their matrix lock, with their full duty rule (duty on
  // base AND loss). This is what's baked into piece_cost_subtotal.
  const signet = computeSignetMatrixMetal(components);
  const signetMetalInPiece = (signet.baseTotal + signet.lossTotal) * (1 + dutyRate);

  // Our metal at user's lock, with Brian's duty rule (duty on base only).
  const ours = computeMetalStack(components, { silver: inputs.silver, gold: inputs.gold });
  const ourMetalInPiece = ours.baseTotal * (1 + dutyRate) + ours.lossTotal;

  // Optional per-SKU adjustments (additive labor delta from Brian's edits).
  const laborDelta = safeNum(sku.labor_delta);

  // Weight delta (Brian's manual adjustment to dominant material weight).
  let weightDeltaCost = 0;
  const wd = safeNum(sku.weight_delta);
  if (wd !== 0 && Array.isArray(components) && components.length > 0) {
    const dominant = [...components].sort(
      (a, b) => componentWeight(b) - componentWeight(a)
    )[0];
    const purity = purityFactorFromMaterial(dominant);
    const rate = rateForMaterial(dominant, inputs);
    const acq = safeNum(dominant.acquisition_cost);
    const L = safeNum(dominant.metal_loss_percent);
    if (rate > 0) {
      const ppg = ((rate + acq) * purity) / GRAMS_PER_TROY_OUNCE;
      const base = wd * ppg;
      const lossFactor = L < 100 ? L / (100 - L) : 0;
      weightDeltaCost = base * (1 + dutyRate) + base * lossFactor; // Brian's rule
    }
  }

  const baselinePiece =
    safeNum(sku.discount_piece_cost_subtotal) || safeNum(sku.piece_cost_subtotal);

  const piece =
    baselinePiece - signetMetalInPiece + ourMetalInPiece + weightDeltaCost + laborDelta * (1 + dutyRate);

  return piece * (1 + tariff) * (1 + upcharge);
}

// ============================================================
// recomputeFactoryCost(sample, inputs)
//
// Mirrors src/components/Samples/CalculatePrice.jsx for parity with /samples.
// (Factory side — our cost from the factory, not what we bill Signet.)
// ============================================================
export function recomputeFactoryCost(sample, inputs) {
  if (!sample) return null;
  const rate = (() => {
    const t = String(sample.metalType || "").toLowerCase();
    if (t.includes("brass") || t.includes("bronze")) return 0;
    if (t.includes("gold")) return safeNum(inputs.gold);
    return safeNum(inputs.silver);
  })();
  const purity = purityFactorFromMaterial({
    metal_purity: sample.karat,
    metal_karat: sample.karat || sample.metalType,
  });
  const weight = safeNum(sample.weight);
  const metalCost =
    sample.metalType === "Brass"
      ? 0
      : (weight * rate * purity) / GRAMS_PER_TROY_OUNCE;
  const labor = safeNum(sample.laborCost);
  const misc = safeNum(sample.miscCost);
  const plating = safeNum(sample.platingCharge);
  let stones = 0;
  for (const s of (Array.isArray(sample.stones) ? sample.stones : [])) {
    stones += safeNum(s.cost) * safeNum(s.quantity || 1);
  }
  return metalCost + labor + misc + plating + stones;
}

// ============================================================
// computeMargin(signetBill, factoryCost)
// ============================================================
export function computeMargin(signetBill, factoryCost) {
  if (factoryCost == null) return null;
  return safeNum(signetBill) - safeNum(factoryCost);
}

// ============================================================
// rebillFromActualPrice(line, sku, components, opts)
//
// For /back-engineering: Signet sent us a PO at unit_price. Compute what
// we'd bill at a NEW lock using Brian's rule, anchored on the truth that
// at oldLockRate, unit_price was correct.
//
//   piece_from_signet = unit_price / ((1+oldTariff)(1+oldUpcharge))
//   delta_metal       = our_metal_at_new_lock − our_metal_at_old_lock
//                       (where each "our_metal" uses Brian's duty rule)
//   new_piece         = piece_from_signet + delta_metal
//   new_unit_price    = new_piece × (1+newTariff)(1+newUpcharge)
//
// opts: { oldTariffPct, oldUpchargePct, oldLockRate, newSilver, newGold,
//         newTariffPct, newUpchargePct }
// ============================================================
export function rebillFromActualPrice(line, sku, components, opts) {
  if (!line || !sku || !Array.isArray(components) || components.length === 0) return null;
  const oldPrice = safeNum(line.unit_price);
  if (!oldPrice) return null;

  const oldTariff = safeNum(opts.oldTariffPct) / 100;
  const oldUpcharge = safeNum(opts.oldUpchargePct) / 100;
  const newTariff = safeNum(opts.newTariffPct) / 100;
  const newUpcharge = safeNum(opts.newUpchargePct) / 100;
  const dutyRate = safeNum(sku.duty_rate) / 100;
  const oldLockRate = safeNum(opts.oldLockRate);

  const oldPiece = oldPrice / ((1 + oldTariff) * (1 + oldUpcharge));

  // No metal exposure (all brass / bronze) — just swap tariff & upcharge.
  const hasMetal = components.some((c) => componentWeight(c) > 0 && rateForMaterial(c, { silver: 1, gold: 1 }) > 0);
  if (!hasMetal || oldLockRate === 0) {
    return oldPiece * (1 + newTariff) * (1 + newUpcharge);
  }

  // Detect metal type from dominant component.
  const dominant = [...components].sort(
    (a, b) => componentWeight(b) - componentWeight(a)
  )[0];
  const dominantIsGold = (() => {
    const blob = `${dominant.material_type || ""} ${dominant.metal_karat || ""}`.toLowerCase();
    if (blob.includes("gold") || /\b\d+k\b/i.test(blob)) return true;
    return false;
  })();

  const oldRates = dominantIsGold ? { silver: 0, gold: oldLockRate } : { silver: oldLockRate, gold: 0 };
  const newRates = { silver: safeNum(opts.newSilver), gold: safeNum(opts.newGold) };

  // Metal stacks at old and new lock, Brian's duty rule (duty on base only).
  const oldMetal = computeMetalStack(components, oldRates);
  const newMetal = computeMetalStack(components, newRates);
  const oldMetalInPiece = oldMetal.baseTotal * (1 + dutyRate) + oldMetal.lossTotal;
  const newMetalInPiece = newMetal.baseTotal * (1 + dutyRate) + newMetal.lossTotal;

  const newPiece = oldPiece + (newMetalInPiece - oldMetalInPiece);
  return newPiece * (1 + newTariff) * (1 + newUpcharge);
}

// ============================================================
// backEngineerMetalRate(line, sku, components, opts)
//
// Inverse of recomputeSignetBill. Given unit_price Signet billed, solve for
// the lock $/oz they used. Assumes a single-metal SKU (dominant material).
//
// Brian's duty rule applied:
//   piece     = unit_price / ((1+tariff)(1+upcharge))
//   nonMetal  = piece_cost_subtotal − signet_matrix_metal_with_full_duty
//   metalContribution = piece − nonMetal
//   metalContribution = base × (1+duty) + loss
//                     = w × ppg × (1+duty)(1) + w × ppg × L/(100-L)
//                     = ppg × w × [(1+duty) + L/(100-L)]
//   ppg = metalContribution / [w × ((1+duty) + L/(100-L))]
//   lock = ppg × 31.1 / purity − acquisition_cost
//
// (Sums weight/purity/loss across all metal-bearing components.)
// ============================================================
export function backEngineerMetalRate(line, sku, components, opts = {}) {
  if (!line || !sku) return null;
  const price = safeNum(line.unit_price);
  if (!price) return null;
  if (!Array.isArray(components) || components.length === 0) return null;

  const tariff = safeNum(opts.tariffPct) / 100;
  const upcharge = safeNum(opts.upchargePct) / 100;
  const dutyRate = safeNum(sku.duty_rate) / 100;

  const piece = price / ((1 + tariff) * (1 + upcharge));
  const baselinePiece =
    safeNum(sku.discount_piece_cost_subtotal) || safeNum(sku.piece_cost_subtotal);

  const signet = computeSignetMatrixMetal(components);
  const signetMetalInPiece = (signet.baseTotal + signet.lossTotal) * (1 + dutyRate);
  const nonMetal = baselinePiece - signetMetalInPiece;
  const metalContribution = piece - nonMetal; // what we paid for the metal in the new piece

  // Sum the per-component factor: w × purity × [(1+duty) + L/(100-L)] / 31.1
  // We solve for "lock + acq" jointly. If acquisition_cost is on the
  // component, subtract its contribution from metalContribution first.
  let factorSum = 0;
  let acqContribution = 0;
  for (const c of components) {
    const w = componentWeight(c);
    if (w === 0) continue;
    const purity = purityFactorFromMaterial(c);
    const L = safeNum(c.metal_loss_percent);
    const acq = safeNum(c.acquisition_cost);
    const lossFactor = L < 100 ? L / (100 - L) : 0;
    const dutyMultiplier = (1 + dutyRate) + lossFactor;
    // Skip brass: no metal price (purity wouldn't matter, but rateForMaterial
    // identifies it via text, so just check the text here too).
    const blob = `${c.material_type || ""} ${c.metal_karat || ""}`.toLowerCase();
    if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) continue;
    const perComp = (w * purity * dutyMultiplier) / GRAMS_PER_TROY_OUNCE;
    factorSum += perComp;
    acqContribution += perComp * acq;
  }

  if (factorSum === 0) return null;
  // metalContribution = lock × factorSum + acqContribution
  // => lock = (metalContribution − acqContribution) / factorSum
  return (metalContribution - acqContribution) / factorSum;
}
