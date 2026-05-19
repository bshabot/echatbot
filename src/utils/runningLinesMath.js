// runningLinesMath.js
//
// Pure functions for /running-lines, /purchase-orders, /back-engineering.
// No React. No Supabase. Easy to unit-test.
//
// CANONICAL RECOMPUTE MODEL — uses piece_cost_subtotal as baseline
// =================================================================
// signet stores `piece_cost_subtotal` already containing every cost bucket:
// material, labor, stone, tag, plating, duty, overcost, stone cert, screening,
// etc. All of those reconcile to piece_cost_subtotal exactly. When we change
// the metal price we only need to apply the DELTA on the metal portion (and
// the duty riding on top of it).
//
//   For each material row:
//     baseRate    = m.metal_base_price ($/oz, what SSP used)
//     userRate    = inputs.silver or .gold (depending on the material)
//     deltaCost   = m.material_net_weight × (1 + m.metal_loss_percent/100)
//                    × m.purityFactor × (userRate - baseRate) / 31.1035
//   materialDelta = sum of deltaCost across all material rows
//
//   newPiece      = piece_cost_subtotal + materialDelta × (1 + duty_rate)
//                   (duty scales with material — adding $1 to material
//                    adds $1 + $dutyRate to piece)
//
// This guarantees: when userRate == baseRate, newPiece == piece_cost_subtotal
// exactly. No drift. Every bucket SSP captured is preserved.

const GRAMS_PER_TROY_OUNCE = 31.1035;

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

// Determine which spot rate ($/oz) applies for a single material row.
// Brass / bronze have no metal-price component.
function rateForMaterial(m, inputs) {
  const blob = `${m?.material_type || ""} ${m?.metal_karat || ""} ${m?.metal_color || ""}`.toLowerCase();
  if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) return 0;
  if (blob.includes("gold") || /\b\d+k\b/i.test(blob)) return safeNum(inputs.gold);
  return safeNum(inputs.silver);
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
// computeMaterialDelta(components, inputs)
//
// Sum across ALL metal-bearing components (materials + findings + chains)
// of: weight × loss × purity × (newRate - baseRate) / 31.1035
//
// Each component has its own weight + base price + loss% + purity, so when
// metal moves, EACH bucket's material cost moves. Failing to include findings
// or chains undercounts the delta on multi-component SKUs.
//
// `components` is an array of objects with these field names (works for
// running_line_materials, running_line_findings (after schema migration), and
// running_line_chains rows alike):
//   { material_type, metal_karat, metal_color, metal_purity,
//     material_net_weight | finding_net_weight | chain_net_weight,
//     metal_base_price, metal_loss_percent }
// ============================================================
function computeMaterialDelta(components, inputs) {
  if (!Array.isArray(components) || components.length === 0) return 0;
  let delta = 0;
  for (const c of components) {
    // Accept any of the weight field names
    const weight = safeNum(
      c.material_net_weight ?? c.finding_net_weight ?? c.chain_net_weight
    );
    if (weight === 0) continue;
    const lossFactor = 1 + safeNum(c.metal_loss_percent) / 100;
    const purity = purityFactorFromMaterial(c);
    const baseRateOz = safeNum(c.metal_base_price);
    const userRateOz = rateForMaterial(c, inputs);
    delta += (weight * lossFactor * purity * (userRateOz - baseRateOz)) / GRAMS_PER_TROY_OUNCE;
  }
  return delta;
}

// ============================================================
// recomputeSignetBill(sku, materials, inputs)
//
// piece_cost_subtotal-as-baseline approach. When inputs match SSP's stored
// metal_base_price, returns piece_cost_subtotal exactly.
// ============================================================
export function recomputeSignetBill(sku, materials, inputs) {
  if (!sku) return 0;

  const dutyRate = safeNum(sku.duty_rate) / 100;

  // Metal price delta (zero when user rate matches SSP's base rate per material)
  const materialDelta = computeMaterialDelta(materials, inputs);

  // weight_delta: extra weight Brian bills for, costed at dominant material's rate
  let weightDeltaCost = 0;
  const wd = safeNum(sku.weight_delta);
  if (wd !== 0 && Array.isArray(materials) && materials.length > 0) {
    const dominant = [...materials].sort(
      (a, b) => safeNum(b.material_net_weight) - safeNum(a.material_net_weight)
    )[0];
    const purity = purityFactorFromMaterial(dominant);
    const rate = rateForMaterial(dominant, inputs);
    const lossFactor = 1 + safeNum(dominant.metal_loss_percent) / 100;
    weightDeltaCost = (wd * lossFactor * purity * rate) / GRAMS_PER_TROY_OUNCE;
  }

  // labor_delta: extra labor Brian bills for. Duty scales with labor too.
  const laborDelta = safeNum(sku.labor_delta);

  // The "every $1 added to material/labor → $1 + $dutyRate to piece" identity
  const materialAdj = materialDelta + weightDeltaCost;
  const newPiece =
    safeNum(sku.piece_cost_subtotal) +
    materialAdj * (1 + dutyRate) +
    laborDelta * (1 + dutyRate);

  const tariff = safeNum(inputs.tariffPct) / 100;
  const upcharge = safeNum(inputs.upchargePct) / 100;
  return newPiece * (1 + tariff) * (1 + upcharge);
}

// ============================================================
// recomputeFactoryCost(sample, inputs)
//
// Mirrors src/components/Samples/CalculatePrice.jsx for parity with /samples.
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
// backEngineerMetalRate(line, sku, materials, opts)
//
// Inverse of recomputeSignetBill. Given the unit price signet paid, solve
// for the implied $/oz they used.
//
//   piece    = unit_price / ((1 + tariff)(1 + upcharge))
//   delta    = (piece - piece_cost_subtotal) / (1 + duty_rate)
//   newRate  = baseRate + delta × 31.1035 / (weight × loss × purity)
//              (assuming single dominant material — multi-metal SKUs are an
//              under-determined system; we return the implied rate as if the
//              dominant material absorbed the full delta)
// ============================================================
// ============================================================
// rebillFromActualPrice(line, sku, materials, opts)
//
// For reverse-direction (signet) POs: signet's actual unit_price IS the ground
// truth. Use it as the baseline, shift only for the metal-price change from
// signet's locked rate to the new user-chosen rate, then re-apply tariff +
// upcharge. This sidesteps any drift between our SSP data and signet's reality.
//
//   piece_from_signet = line.unit_price / ((1+oldTariff)(1+oldUpcharge))
//   delta             = dominantWeight × loss × purity × (newRate - oldLockRate) / 31.1035
//   newPiece          = piece_from_signet + delta × (1 + duty_rate)
//   newUnitPrice      = newPiece × (1+newTariff)(1+newUpcharge)
//
// opts: { oldTariffPct, oldUpchargePct, oldLockRate, newSilver, newGold,
//         newTariffPct, newUpchargePct }
// ============================================================
export function rebillFromActualPrice(line, sku, materials, opts) {
  if (!line || !sku || !Array.isArray(materials) || materials.length === 0) return null;
  const oldPrice = safeNum(line.unit_price);
  if (!oldPrice) return null;

  const oldTariff = safeNum(opts.oldTariffPct) / 100;
  const oldUpcharge = safeNum(opts.oldUpchargePct) / 100;
  const newTariff = safeNum(opts.newTariffPct) / 100;
  const newUpcharge = safeNum(opts.newUpchargePct) / 100;
  const dutyRate = safeNum(sku.duty_rate) / 100;
  const oldLockRate = safeNum(opts.oldLockRate);

  const oldPiece = oldPrice / ((1 + oldTariff) * (1 + oldUpcharge));

  // Use dominant material for the rate shift (banter is usually single-metal anyway)
  const dominant = [...materials].sort(
    (a, b) => safeNum(b.material_net_weight) - safeNum(a.material_net_weight)
  )[0];
  const weight = safeNum(dominant.material_net_weight);
  if (weight === 0 || oldLockRate === 0) return null;

  const blob = `${dominant.material_type || ""} ${dominant.metal_karat || ""}`.toLowerCase();
  if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) {
    // Brass: no metal-price component, just apply tariff/upcharge swap
    return oldPiece * (1 + newTariff) * (1 + newUpcharge);
  }

  const lossFactor = 1 + safeNum(dominant.metal_loss_percent) / 100;
  const purity = purityFactorFromMaterial(dominant);
  const newRate = rateForMaterial(dominant, { silver: opts.newSilver, gold: opts.newGold });

  const delta = (weight * lossFactor * purity * (newRate - oldLockRate)) / GRAMS_PER_TROY_OUNCE;
  const newPiece = oldPiece + delta * (1 + dutyRate);
  return newPiece * (1 + newTariff) * (1 + newUpcharge);
}

export function backEngineerMetalRate(line, sku, materials, opts = {}) {
  if (!line || !sku) return null;
  const price = safeNum(line.unit_price);
  if (!price) return null;

  const tariff = safeNum(opts.tariffPct) / 100;
  const upcharge = safeNum(opts.upchargePct) / 100;
  const dutyRate = safeNum(sku.duty_rate) / 100;

  const piece = price / ((1 + tariff) * (1 + upcharge));
  const materialDelta = (piece - safeNum(sku.piece_cost_subtotal)) / (1 + dutyRate);

  if (!Array.isArray(materials) || materials.length === 0) return null;
  const dominant = [...materials].sort(
    (a, b) => safeNum(b.material_net_weight) - safeNum(a.material_net_weight)
  )[0];
  const weight = safeNum(dominant.material_net_weight);
  if (weight <= 0) return null;
  const purity = purityFactorFromMaterial(dominant);
  const lossFactor = 1 + safeNum(dominant.metal_loss_percent) / 100;
  const baseRateOz = safeNum(dominant.metal_base_price);

  const blob = `${dominant.material_type || ""} ${dominant.metal_karat || ""}`.toLowerCase();
  if (blob.includes("brass") || blob.includes("bronze") || blob.includes("base")) return null;

  return baseRateOz + (materialDelta * GRAMS_PER_TROY_OUNCE) / (weight * lossFactor * purity);
}
