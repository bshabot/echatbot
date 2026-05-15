// runningLinesMath.js
//
// Pure functions for the /running-lines, /purchase-orders, /back-engineering pages.
// No React. No Supabase. Easy to unit-test by passing plain objects.

const GRAMS_PER_TROY_OUNCE = 31.1035;

// Map metal/karat string -> purity factor (fraction of pure metal in the alloy).
// Mirror of src/utils/MetalTypeUtil.js purity table; kept inline to avoid coupling.
const PURITY = {
  Silver: 0.925,
  Sterling: 0.925,
  "925": 0.925,
  "10K": 0.417,
  "14K": 0.585,
  "18K": 0.75,
  "22K": 0.916,
  "24K": 1.0,
  Brass: 1.0,
  Bronze: 1.0,
  Gold: 0.585, // fallback if karat unknown
};

function purityFromString(str) {
  if (!str) return 0.925; // default to sterling
  const s = String(str);
  // exact match first
  if (PURITY[s] != null) return PURITY[s];
  // try cleaned key
  const cleaned = s.replace(/\s+/g, "").toUpperCase();
  if (PURITY[cleaned] != null) return PURITY[cleaned];
  // numeric purity like "925" or "0.925"
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (n > 1) return n / 1000; // 925 -> 0.925
    return n;
  }
  return 0.925;
}

// Pick the spot rate to use for a given metal type.
// Brass and bronze have no metal-price component (rate = 0).
function pickRate(metalType, inputs) {
  if (!metalType) return safeNum(inputs.silver);
  const s = String(metalType).toLowerCase();
  if (s.includes("brass") || s.includes("bronze") || s.includes("base")) return 0;
  if (s.includes("gold")) return safeNum(inputs.gold);
  return safeNum(inputs.silver);
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

// ============================================================
// resolveMetal(materials)
//
// Given the running_line_materials rows for ONE sku, pick the dominant
// material (heaviest by net weight) and return { metalType, purity, karat }.
// Falls back to silver/925 if no materials.
// ============================================================
export function resolveMetal(materials) {
  if (!Array.isArray(materials) || materials.length === 0) {
    return { metalType: "Silver", karat: "Sterling", purity: 0.925 };
  }
  const sorted = [...materials].sort(
    (a, b) => safeNum(b.material_net_weight) - safeNum(a.material_net_weight)
  );
  const m = sorted[0];

  // Karat string — try the explicit karat first, then purity
  const karat = m.metal_karat || m.metal_purity || "";
  const purity = purityFromString(karat);

  // Detect metal type from the various text fields
  const blob =
    `${m.material_type || ""} ${m.metal_karat || ""} ${m.metal_purity || ""} ${m.metal_color || ""}`.toLowerCase();

  let metalType = "Silver";
  if (blob.includes("brass") || blob.includes("bronze")) metalType = "Brass";
  else if (blob.includes("gold") || /\b(10k|14k|18k|22k|24k)\b/.test(blob))
    metalType = "Gold";

  return { metalType, karat, purity };
}

// ============================================================
// recomputeSignetBill(sku, inputs)
//
// Given a running_line_skus row and global inputs (silver/gold/tariff/upcharge),
// return what Brian should be billing Signet at the current rate.
//
// SSP cost formula:
//   metal_cost   = weight × purity × rate / 31.1035 × (1 + loss%)
//   spc          = metal_cost + labor + stone + plating + tag
//   final        = spc + spc × duty% + tariff% + upcharge%
//
// labor_delta and weight_delta on the sku row layer on top of SSP values.
// ============================================================
export function recomputeSignetBill(sku, inputs) {
  if (!sku) return 0;

  // Pull resolved metal (set by the caller via `sku.metal`); fall back to silver/925
  const metal = sku.metal || { metalType: "Silver", purity: 0.925 };
  const rate = pickRate(metal.metalType, inputs);
  const purity = safeNum(metal.purity) || 0.925;

  // Use the stored signet weight + delta
  const weight = safeNum(sku.total_net_weight) + safeNum(sku.weight_delta);

  const lossPct = 0; // SSP bakes loss into materialCost; placeholder
  const lossFactor = 1 + lossPct / 100;

  const metalCost = (weight * purity * rate * lossFactor) / GRAMS_PER_TROY_OUNCE;
  const labor = safeNum(sku.total_labor_cost) + safeNum(sku.labor_delta);
  const stone = safeNum(sku.total_stone_cost);
  const plating = safeNum(sku.total_plating_cost);
  const tag = safeNum(sku.tag_cost);

  const spc = metalCost + labor + stone + plating + tag;
  const dutyRate = safeNum(sku.duty_rate) / 100;
  const tariff = safeNum(inputs.tariffPct) / 100;
  const upcharge = safeNum(inputs.upchargePct) / 100;

  const withDuty = spc * (1 + dutyRate);
  const final = withDuty * (1 + tariff) * (1 + upcharge);

  return final;
}

// ============================================================
// recomputeFactoryCost(sample, inputs)
//
// Given a sample_with_stones_export row and global inputs, recompute the
// factory cost at the input metal rate. Mirrors src/components/Samples/CalculatePrice.jsx.
// ============================================================
export function recomputeFactoryCost(sample, inputs) {
  if (!sample) return null;

  const rate = pickRate(sample.metalType, inputs);
  const purity = purityFromString(sample.karat || sample.metalType);
  const weight = safeNum(sample.weight);
  // lossPercent: stored as fraction or percent — mirror the >= 1 guard used in CalculatePrice.jsx
  // (samples table doesn't expose it directly here; assume 0 for v1, revisit when needed)
  const lossPct = 0;
  const lossFactor = 1 + (lossPct >= 1 ? lossPct / 100 : lossPct);

  const metalCost = sample.metalType === "Brass"
    ? 0 // brass: no metal-price component
    : (weight * rate * purity * lossFactor) / GRAMS_PER_TROY_OUNCE;

  const labor = safeNum(sample.laborCost);
  const misc = safeNum(sample.miscCost);
  const plating = safeNum(sample.platingCharge);

  let stones = 0;
  const stonesArr = Array.isArray(sample.stones) ? sample.stones : [];
  for (const s of stonesArr) {
    stones += safeNum(s.cost) * safeNum(s.quantity || 1);
  }

  return metalCost + labor + misc + plating + stones;
}

// ============================================================
// computeMargin(signetBill, factoryCost)
//
// Returns null when factory cost is unknown (unmatched SKU); otherwise the $ delta.
// ============================================================
export function computeMargin(signetBill, factoryCost) {
  if (factoryCost == null) return null;
  return safeNum(signetBill) - safeNum(factoryCost);
}

// ============================================================
// backEngineerMetalRate(line, sku, opts)
//
// For a Signet PO line, compute the metal rate that produces the price Signet
// paid. Uses the SSP weight/labor/stone/plating as fixed inputs.
//
//   line.unit_price = (weight × purity × rate / 31.1035) + labor + stone + plating + tag + duty + tariff + upcharge
//
// Solve for rate. Returns null if the line can't be back-engineered (missing data
// or weight = 0).
// ============================================================
export function backEngineerMetalRate(line, sku, opts = {}) {
  if (!line || !sku) return null;
  const price = safeNum(line.unit_price);
  if (!price) return null;

  const tariff = safeNum(opts.tariffPct) / 100;
  const upcharge = safeNum(opts.upchargePct) / 100;
  const dutyRate = safeNum(sku.duty_rate) / 100;

  // Strip tariff + upcharge layers
  const noTariff = price / ((1 + tariff) * (1 + upcharge));
  // Strip duty
  const spc = noTariff / (1 + dutyRate);

  // SPC = metal + labor + stone + plating + tag
  const labor = safeNum(sku.total_labor_cost) + safeNum(sku.labor_delta);
  const stone = safeNum(sku.total_stone_cost);
  const plating = safeNum(sku.total_plating_cost);
  const tag = safeNum(sku.tag_cost);
  const metalCost = spc - labor - stone - plating - tag;
  if (metalCost <= 0) return null;

  const weight = safeNum(sku.total_net_weight) + safeNum(sku.weight_delta);
  if (weight <= 0) return null;

  const metalInfo = sku.metal || { metalType: "Silver", purity: 0.925 };
  const purity = safeNum(metalInfo.purity) || 0.925;

  // brass / bronze: no metal-price component, can't back-engineer a rate
  if (
    metalInfo.metalType &&
    /brass|bronze|base/i.test(metalInfo.metalType)
  ) {
    return null;
  }

  // metal = (weight × purity × rate) / 31.1035
  // rate  = metal × 31.1035 / (weight × purity)
  return (metalCost * GRAMS_PER_TROY_OUNCE) / (weight * purity);
}
