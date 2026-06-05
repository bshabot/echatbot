// runningLinesMath.js
//
// Pure functions for /running-lines and /purchase-orders.
// No React. No Supabase. Easy to unit-test.
//
// =====================================================================
// SIGNET FORMULA — direct recompute from user-input lock (no VPC anchor)
// =====================================================================
// Verified against 660 SSP SKUs 2026-05-19. The PDF formula said acquisition
// cost is added to the lock, but the stored data doesn't work that way:
// metalFixingAllowAmt is a separate fee in piece_cost_subtotal, NOT a $/oz
// markup. Dropping it gets 77% penny-perfect / 88% within $0.01 on the metal
// portion; the remaining gap is per-component cents-rounding.
//
//   Metal Price per gram (ppg) = (lock × purity) / 31.1
//   Finish Loss $              = weight × L/(100−L) × ppg
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
//   - Signet's piece_cost_subtotal is built using the SAME rule (no duty on
//     loss, per Brian 2026-05-19). So strip Signet's metal using that rule,
//     then add ours back using the same rule.
//
//   piece = piece_cost_subtotal                         // signet's piece
//         − (signet_base × (1 + duty) + signet_loss)    // strip signet's metal
//         + our_base × (1 + duty) + our_loss            // add ours back
//
// At user_lock == matrix_lock, signet metal == our metal, so
// piece == piece_cost_subtotal exactly. Penny-perfect baseline.
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
// IMPORTANT: scan ALL text fields (material_type, finding_type, chain_type,
// metal_karat, metal_color) because findings store the type in finding_type,
// not material_type. Brass findings with no metal_purity would otherwise
// default to silver and trigger a phantom metal cost. Bug found 2026-05-21.
// Also treat stored metal_base_price = 0 as a hard "no metal exposure" signal.
function rateForMaterial(m, inputs) {
  if (safeNum(m?.metal_base_price) === 0 && m?.metal_base_price !== undefined && m?.metal_base_price !== null) {
    // Stored matrix base is explicitly 0 (e.g. brass material). Hard skip.
    return 0;
  }
  const blob = `${m?.material_type || ""} ${m?.finding_type || ""} ${m?.chain_type || ""} ${m?.metal_karat || ""} ${m?.metal_color || ""}`.toLowerCase();
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
  // metal_purity is 0/null/empty AND text didn't match — treat as no metal.
  // (Safer than defaulting to silver, which caused brass findings to attract
  // phantom silver lock costs.)
  return 0;
}

// Returns the per-component weight from any of the supported field names.
function componentWeight(c) {
  return safeNum(c.material_net_weight ?? c.finding_net_weight ?? c.chain_net_weight);
}

// Per-component stored cost for the row. A component with an EXPLICIT $0 cost
// (e.g. "jump ring added for closure" the factory eats — N2785NK-GP) is real
// metal that Signet never costed: their billing engine doesn't revalue it, so
// neither do we. Null/undefined cost is NOT treated as zero (missing data
// must not silently drop a component). Verified against live SSP 2026-06-04.
function isZeroCostComponent(c) {
  const v = c.material_cost ?? c.finding_material_cost ?? c.chain_material_cost;
  return v !== undefined && v !== null && safeNum(v) === 0;
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
    if (isZeroCostComponent(c)) continue; // factory-eaten metal — never revalued
    const rate = rateForMaterial(c, ratesByMetal);
    if (rate === 0) continue; // brass / no-metal
    const purity = purityFactorFromMaterial(c);
    const L = safeNum(c.metal_loss_percent);
    // ppg = base × purity / 31.1. metalFixingAllowAmt is NOT in this calc
    // (verified against 660 SSP SKUs 2026-05-19) — it's a separate fee that
    // lives in piece_cost_subtotal, not a $/oz markup on the lock.
    const ppg = (rate * purity) / GRAMS_PER_TROY_OUNCE;
    const base = w * ppg;
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
    if (isZeroCostComponent(c)) continue; // symmetric with computeMetalStack
    const matrixRate = safeNum(c.metal_base_price);
    if (matrixRate === 0) continue; // brass
    const purity = purityFactorFromMaterial(c);
    const L = safeNum(c.metal_loss_percent);
    const ppg = (matrixRate * purity) / GRAMS_PER_TROY_OUNCE;
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

  // Signet's metal at their matrix lock, using Brian's duty rule (no duty on
  // loss — Signet's piece_cost_subtotal is already built this way).
  const signet = computeSignetMatrixMetal(components);
  const signetMetalInPiece = signet.baseTotal * (1 + dutyRate) + signet.lossTotal;

  // Our metal at user's lock, same rule.
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
    const L = safeNum(dominant.metal_loss_percent);
    if (rate > 0) {
      const ppg = (rate * purity) / GRAMS_PER_TROY_OUNCE;
      const base = wd * ppg;
      const lossFactor = L < 100 ? L / (100 - L) : 0;
      weightDeltaCost = base * (1 + dutyRate) + base * lossFactor; // Brian's rule
    }
  }

  // Vendor discount (live-SSP verified 2026-06-04): Signet bills
  // billed = revalued piece × (1 − discount%) × (1 + tariff).
  // When a % discount exists, anchor on the UNdiscounted subtotal so the
  // discount isn't applied twice (discount_piece_cost_subtotal is already
  // the discounted figure on those records).
  const discPct = safeNum(sku.vendor_discount_perc) / 100;
  const discFactor = discPct > 0 && discPct < 1 ? 1 - discPct : 1;
  const baselinePiece =
    discFactor !== 1
      ? safeNum(sku.piece_cost_subtotal)
      : safeNum(sku.discount_piece_cost_subtotal) || safeNum(sku.piece_cost_subtotal);

  const piece =
    baselinePiece - signetMetalInPiece + ourMetalInPiece + weightDeltaCost + laborDelta * (1 + dutyRate);

  return piece * discFactor * (1 + tariff) * (1 + upcharge);
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
// For /purchase-orders (Signet→me direction): Signet sent us a PO at unit_price. Compute what
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

  // Mirror recomputeSignetBill's vendor-discount handling (keep inverses exact).
  const discPct = safeNum(sku.vendor_discount_perc) / 100;
  const discFactor = discPct > 0 && discPct < 1 ? 1 - discPct : 1;
  const piece = price / discFactor / ((1 + tariff) * (1 + upcharge));
  const baselinePiece =
    discFactor !== 1
      ? safeNum(sku.piece_cost_subtotal)
      : safeNum(sku.discount_piece_cost_subtotal) || safeNum(sku.piece_cost_subtotal);

  // Signet's piece is built with no duty on loss (Brian's rule).
  const signet = computeSignetMatrixMetal(components);
  const signetMetalInPiece = signet.baseTotal * (1 + dutyRate) + signet.lossTotal;
  const nonMetal = baselinePiece - signetMetalInPiece;
  const metalContribution = piece - nonMetal; // what we paid for the metal in the new piece

  // Sum the per-component factor: w × purity × [(1+duty) + L/(100-L)] / 31.1
  // Skip brass / bronze components — they have no metal-price exposure so they
  // shouldn't contribute to the implied $/oz back-engineering.
  // We check both text fields (material_type, finding_type, chain_type, metal_karat)
  // AND the stored metal_base_price (brass components have base = 0).
  let factorSum = 0;
  for (const c of components) {
    const w = componentWeight(c);
    if (w === 0) continue;
    const blob = `${c.material_type || ""} ${c.finding_type || ""} ${c.chain_type || ""} ${c.metal_karat || ""}`.toLowerCase();
    if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) continue;
    // Also skip components with no stored metal base (brass scrape often has base=0)
    if (safeNum(c.metal_base_price) === 0) continue;
    if (isZeroCostComponent(c)) continue; // factory-eaten metal — never revalued
    const purity = purityFactorFromMaterial(c);
    const L = safeNum(c.metal_loss_percent);
    const lossFactor = L < 100 ? L / (100 - L) : 0;
    const dutyMultiplier = (1 + dutyRate) + lossFactor;
    factorSum += (w * purity * dutyMultiplier) / GRAMS_PER_TROY_OUNCE;
  }

  if (factorSum === 0) return null;
  return metalContribution / factorSum;
}
