// src/utils/sspCreate.js
//
// Sample -> SSP item creation (the Samples page's "Create in SSP" actions).
//
// BEST-EFFORT V1: a sample row (sample_with_stones_export shape) carries the
// header/item basics, enough metal data for a first-pass material row, its
// own stones array (id/type/color/shape/size/quantity/cost), and its R2
// image(s). Findings and labor are still NOT sent — this module creates
// the header + item + material + stones + images and stops there; the
// rest is finished by hand in SKU Manager, where the new product sits in
// the hold queue as "Pending Vendor Submission".
//
// Everything adjustable lives at the top of this file (category map,
// defaults) or in Settings (buyer, country, userName) — the intended
// workflow is to refine these together as real samples go through.
//
// Payload field names mirror the recorded HAR exactly — see
// tools/ssp-item-creator/docs/API-NOTES.md.

import {
  isSspEnabled,
  getSspConfig,
  ensureFreshSspToken,
  sspSaveHeader,
  sspSetCostingMethod,
  sspSetTethers,
  sspCreateItem,
  sspUpdateItem,
  sspAddMaterial,
  sspUpdateMaterial,
  sspGetItemMaterials,
  sspAddStone,
  sspStageImagesForSample,
} from "./sspClient";

// ---------------------------------------------------------------------------
// Tunables — v1 guesses, refine together as real samples go through.
// ---------------------------------------------------------------------------

// PLM category name -> SSP { productType, productCategories }.
//
// The PLM's category rows were renamed to SSP's own wording on 2026-09-02
// (Ring -> rings, Hoops -> hoop, Nose Ring -> nose, Hoop Charms ->
// "earring charm", ...), so the keys here are the renamed values. The rows
// that had no clean SSP equivalent kept their original names: Flatbacks,
// Silver Flatbacks, Clasp, Pendant, Kids Earring, Charm, Hoopd.
//
// Several `productCategories` values below are NOT real SSP categories —
// "stud earrings", "hoop earrings", "necklace", "ring", "bracelet" and
// "pendant" do not appear in /item/get-filters, and neither does the
// product type "body jewelry". They are left as-is deliberately: the
// second level is still being settled with Brian, and every use of this
// map raises a warning in the preflight. The real fix is giving the type row
// an SSP product type + category (category.ssp_product_type /
// ssp_category), which takes priority over this map.
export const CATEGORY_TO_SSP = {
  charms: { productType: "charms", productCategories: ["earring charm"] },
  charm: { productType: "charms", productCategories: ["earring charm"] },
  "earring charm": { productType: "charms", productCategories: ["earring charm"] },
  earrings: { productType: "earrings", productCategories: ["stud earrings"] },
  "fashion studs": { productType: "earrings", productCategories: ["fashion studs"] },
  hoop: { productType: "earrings", productCategories: ["hoop"] },
  hoopd: { productType: "earrings", productCategories: ["stud earrings"] },
  flatbacks: { productType: "earrings", productCategories: ["stud earrings"] },
  "silver flatbacks": { productType: "earrings", productCategories: ["stud earrings"] },
  "kids earring": { productType: "earrings", productCategories: ["stud earrings"] },
  necklaces: { productType: "necklaces", productCategories: ["necklace"] },
  tennis: { productType: "necklaces", productCategories: ["tennis"] },
  pendant: { productType: "necklaces", productCategories: ["pendant"] },
  rings: { productType: "rings", productCategories: ["ring"] },
  bracelets: { productType: "bracelets", productCategories: ["bracelet"] },
  bangle: { productType: "bracelets", productCategories: ["bangle"] },
  nose: { productType: "body piercings", productCategories: ["nose"] },
};
const DEFAULT_TYPE = { productType: "charms", productCategories: ["earring charm"] };

// Metal purity per karat tag as SSP stores it (925 silver / 417 10k / 585 14k).
const KARAT_TO_PURITY = { "925": 925, "10k": 417, "14k": 585, "18k": 750 };

// Signet's per-gram conversion uses 31.1 g/troy-oz (their convention).
const GRAMS_PER_TROY_OZ = 31.1;

export const SSP_CREATE_DEFAULTS = {
  costingMethod: "fixed with metal lock",
  countryOfOrigin: "VIETNAM",
  buyer: "",
  minOrdQty: 50,
  suppLeadTime: 30,
  polyBagSize: "2X3 BAG",
  brand: 150, // Banter
  viDutyRate: 5,
  diDutyRate: 0,
};

// Stone cost — v1 bucketed-by-size placeholder (same spirit as
// CATEGORY_TO_SSP): the PLM's stones table has a size + a stored cost, but
// not a stone-vs-setting split, so `cost` and `settingChargePerStone` are
// derived from `size` and kept equal to each other (matches the recorded
// add-stone HAR, where both were the same number on one row). Refine
// together once real invoices come back through reconciliation.
const STONE_BASE_COST = 0.15; // cost at STONE_BASE_SIZE_MM
const STONE_BASE_SIZE_MM = 2;
const STONE_COST_PER_MM_STEP = 0.02; // "a cent or two" per mm above base

function stoneCostForSize(mm) {
  const size = Number(mm) || STONE_BASE_SIZE_MM;
  const cost = STONE_BASE_COST + Math.max(0, size - STONE_BASE_SIZE_MM) * STONE_COST_PER_MM_STEP;
  return Math.round(cost * 100) / 100;
}

// Plating -> SSP material.platings[] entries.
//
// Read straight from the `plating_layers` table now (surfaced on the export
// view as sample.plating_layers), not from regexes over the plating's name.
// SSP takes an ARRAY: "BPT + GPT" is genuinely two coats -- black rhodium
// plus a gold plate -- and the old single-entry rule could only ever send
// one of them.
//
// History worth keeping: this used to match against `sample.plating`, which
// is the numeric FK, so no rule ever fired and platings[] was silently empty
// on EVERY item, vermeil included. Then it matched the tag label by regex,
// which worked but encoded the spec in code. The spec now lives in the
// database where it can be edited in Settings.
//
// Colour comes from the item's own colour -- "plating is just plating"
// (Chaim, 2026-09-02). The per-layer colour is only a fallback, for the case
// the item has no colour set and for black rhodium, which is the one plating
// whose colour cannot be inferred from anything else (RHD and BPT are both
// "rhodium" and differ only by white vs black).
// SSP has no "silver" in its colour vocabularies, so the PLM's Silver maps
// to white.
const PLM_COLOR_TO_SSP = {
  silver: "white",
  white: "white",
  yellow: "yellow",
  rose: "rose",
  pink: "rose",
  black: "black",
};

function platingsForSample(sample) {
  const layers = Array.isArray(sample.plating_layers) ? sample.plating_layers : [];
  const itemColor = PLM_COLOR_TO_SSP[s(sample.color).toLowerCase()] || null;
  return layers
    .filter((l) => l && l.material)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map((l) => ({
      platingMaterial: l.material,
      platingColor: itemColor || l.color || null,
      platingMethod: l.method || "galvanic / electroplating",
      platingMicron: l.micron == null ? null : Number(l.micron),
      // Still a placeholder: plating cost is one of the four numbers waiting
      // on the pricing decision, and vermeil's moves with the gold lock.
      platingCost: n(l.cost) ?? n(sample.platingCharge) ?? 0.2,
      platingCoverageClassification: l.coverage || "Full",
      componentTab: "material",
    }));
}

// ---------------------------------------------------------------------------

const s = (v) => (v == null ? "" : String(v).trim());
const n = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
// Like n(), but SSP treats a literal 0 as "not provided" on mandatory
// physical fields (dims/weight) -- confirmed 2026-08-27: a sample with
// height/width/length stored as 0 in the PLM sent itemSize/Height/Width
// as "0"/0/0 and item-create came back "Mandatory Fields are missing",
// even though every field NAME was present. Falls back to `fallback`
// whenever the value is missing OR zero.
const nPositive = (v, fallback) => {
  const num = n(v);
  return num == null || num === 0 ? fallback : num;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function categoryFor(sample) {
  // Vocabulary note: our "type" is what SSP calls product type (earrings,
  // rings, charms) and our "category" is what SSP calls category (fashion,
  // hoop, cartilage). starting_info.type is the FK into the type list;
  // starting_info.category holds the SSP category as text.
  const productType = s(sample.type_ssp_product_type).toLowerCase();

  // 1. The category set on the record wins -- it is the per-item override.
  const ownCategory = s(sample.starting_category).toLowerCase();
  if (productType && ownCategory) {
    return {
      mapped: { productType, productCategories: [ownCategory] },
      key: `${productType} / ${ownCategory}`,
      source: "record",
    };
  }

  // 2. Otherwise the type row's default category.
  const defaultCategory = s(sample.type_default_category).toLowerCase();
  if (productType && defaultCategory) {
    return {
      mapped: { productType, productCategories: [defaultCategory] },
      key: `${productType} / ${defaultCategory}`,
      source: "type",
    };
  }

  // 3. Legacy name map, for type rows with no SSP pair yet (Clasp has no SSP
  // equivalent at all).
  //
  // This used to read `sample_category` / `starting_category` when those were
  // the bigint category IDs -- so the key was always "10", "23" and the map
  // NEVER matched. Every send silently used DEFAULT_TYPE, which is how stud
  // earrings reached SSP as charms / earring charm (confirmed 2026-09-02 on
  // S189748). It is keyed on the resolved type name now.
  const key = s(sample.type_name).toLowerCase();
  const mapped = CATEGORY_TO_SSP[key] || null;
  if (mapped) return { mapped, key, source: "map" };

  return { mapped: null, key, source: "none" };
}

function purityFor(sample) {
  const karat = s(sample.karat).toLowerCase();
  return { karat, purity: KARAT_TO_PURITY[karat] ?? null };
}

/** Current gold/silver lock from the metal_prices table, for the material row. */
async function fetchMetalPrices(supabase) {
  if (!supabase) return {};
  const { data } = await supabase.from("metal_prices").select("*").limit(10);
  const out = {};
  for (const row of data || []) {
    const metal = s(row.metal || row.metal_type || row.name).toLowerCase();
    const price = n(row.price ?? row.price_per_oz ?? row.value);
    if (metal && price != null) out[metal] = price;
  }
  return out;
}

/**
 * Build the header / item / material payload drafts for one sample. Pure.
 * Returns { payloads, warnings } — warnings list every guess/gap so the
 * confirm dialog can show them before anything is sent.
 */
export function buildSspPayloadsForSample(sample, { settings, metalPrices = {} } = {}) {
  const cfg = getSspConfig(settings);
  const d = { ...SSP_CREATE_DEFAULTS, ...cfg.defaults };
  const warnings = [];

  const styleNumber = s(sample.styleNumber);
  const { mapped, key, source } = categoryFor(sample);
  if (source === "none") {
    warnings.push(
      `type "${key || "(none)"}" has no SSP mapping — falling back to ${DEFAULT_TYPE.productType} / ${DEFAULT_TYPE.productCategories.join(", ")}, which is almost certainly wrong. Set an SSP product type + category on this type row.`
    );
  } else if (source === "map") {
    warnings.push(
      `type "${key}" has no SSP pair yet and fell back to the legacy map (${mapped.productType} / ${mapped.productCategories.join(", ")}), whose values are not all real SSP categories. Set an SSP product type + category on this type row.`
    );
  }
  const type = mapped || DEFAULT_TYPE;

  if (!d.buyer) warnings.push("no buyer set (Settings → SSP integration)");

  const header = {
    vendorSubsidiaryName: "E CHABOT LTD",
    vendorNumber: "30374",
    vendorSubsidiaryNumber: "30374",
    vendorCurrency: "USD",
    vendorStyleNumber: styleNumber,
    buyer: d.buyer,
    brand: d.brand,
    exclusiveBrand: false,
    exclusiveSignet: false,
    additionalBrands: [],
    ownership: "A",
    itemProductionMethod: "Complete",
    gender: "Female",
    childJewelry: false,
    countryOfOrigin: s(d.countryOfOrigin).toUpperCase(),
    shippedFromCountry: s(d.countryOfOrigin).toUpperCase(),
    shippedToCountry: "UNITED STATES MINOR OUTLYING ISLANDS",
    repairable: false,
    procurementMethod: "Vendor Import",
    tariffTreatment: "",
    tariffPercentage: "",
    tariffCode: "",
    tariffCodeDescription: "",
    diDutyRate: d.diDutyRate,
    viDutyRate: d.viDutyRate,
    closeoutItem: false,
    ecomExclusive: false,
    dropShip: false,
    setCode: "",
    minOrdQty: d.minOrdQty,
    suppLeadTime: d.suppLeadTime,
    polyBagSize: d.polyBagSize,
  };

  // Per Chaim (2026-09-02): send the item's SALES weight, not starting_info's
  // weight. salesWeight is what actually ships; starting_info.weight is the
  // design/quote weight and is only the fallback now. This one value feeds
  // totalNetGramWeight, totalGrossGramWeight, materialNetWeight and the metal
  // cost calc, so they stay consistent with each other.
  const weight = n(sample.salesWeight) ?? n(sample.weight);
  if (!weight) warnings.push("no sales weight or weight on the sample — totalNetGramWeight sent as 0.01");
  if (!n(sample.length) || !n(sample.height) || !n(sample.width))
    warnings.push(
      "missing or zero length/height/width on the sample — SSP rejects a 0 dimension as a missing mandatory field, so itemSize/itemHeight/itemWidth were sent as 1"
    );

  // How the item sells, resolved once and reused everywhere the piece count
  // matters: quantityType, supplierPack, and (when labor cost is wired up)
  // noOfCastings / noOfAssembly, which must agree with it.
  //
  // The stored selling_pair wins. Only when it is absent do we fall back to
  // the type: earrings sell as a pair, everything else as a single. That
  // ordering matters -- flatbacks map to the earrings product type but sell
  // as singles (30 of 32 records), so the fallback would get them wrong.
  //
  // selling_pair is free text and carries casing variants ("Pair", "pairs",
  // "Set"), so normalise before comparing.
  // selling_pair now stores SSP's own words (pairs | piece | set), adopted
  // 2026-09-02. The startsWith checks still accept the PLM's older values
  // (pair / single) so nothing breaks on stale data.
  const sellsAsRaw = s(sample.selling_pair).toLowerCase();
  const sellsAs = sellsAsRaw.startsWith("pair")
    ? "pairs"
    : sellsAsRaw.startsWith("set")
      ? "set"
      : sellsAsRaw.startsWith("single") || sellsAsRaw.startsWith("piece")
        ? "piece"
        : null;

  const effectiveSellsAs =
    sellsAs || (type.productType === "earrings" ? "pairs" : "piece");
  if (!sellsAs) {
    warnings.push(
      `no selling type on this sample — defaulting to ${effectiveSellsAs} from the ${type.productType} product type`
    );
  }

  // Already SSP's vocabulary (item/get-filters -> quantityType is exactly
  // ["pairs", "piece", "set"]), so this passes straight through. The values
  // we used to send -- "pair" and "each" -- are not valid SSP values.
  const quantityType = effectiveSellsAs;

  // Pieces per sellable unit — a pair is 2, a set is 2 (E. Chabot's sets are
  // 2-piece), a single is 1. Castings and assembly counts follow this same
  // number so the labor tab agrees with what the item says it is.
  const piecesPerUnit = effectiveSellsAs === "piece" ? 1 : 2;

  // Stones — from the PLM's own stones array (sample_with_stones_export
  // shape: id/type/customType/color/shape/size/quantity/cost/notes).
  const stoneRows = Array.isArray(sample.stones) ? sample.stones : [];
  const stones = stoneRows.map((st) => {
    const mm = n(st.size);
    const cost = n(st.cost) ?? stoneCostForSize(mm);
    const quantity = n(st.quantity) ?? 1;
    return {
      // Field conventions matched to a real captured stone record
      // (S177067/item 1/stone 1, 2026-09-02): SSP stores "" -- not "NA" --
      // for type/cut/treatment, null for the certificate fields, and an
      // empty array for additionalCharges. We had the last one inverted.
      isPrimaryStone: false,
      category: "cubic zirconia",
      type: "",
      stoneMillimeter: mm != null ? String(mm) : "",
      shape: s(st.shape).toLowerCase() || "round",
      cut: "",
      color: s(st.color).toLowerCase() || "white",
      clarity: "AA",
      stonePricingMethod: "Per Piece",
      quantity,
      pricePerCarat: 0,
      cost,
      minimumCaratWeightPerStone: 0,
      minimumTotalCaratWeight: 0,
      billWeightCaratPerStone: 0,
      totalStoneCost: round2(cost * quantity),
      certificateType: null,
      certificationLab: null,
      settingLocation: s(d.countryOfOrigin).toUpperCase(),
      // "prong" IS a valid SSP settingType (confirmed against
      // stone/get-filters: bar, bead, bezel, channel, double prong, drilled,
      // flush, glued, half bezel, invisible, nick, pave, pin, pressure,
      // prong, shared prong, split prong, string / thread, talon prong,
      // v tip prong). It is a blanket default though -- the real value
      // describes the actual setting and should be read off the photo.
      settingType: "prong",
      settingMethod: "hand_wax",
      // PLACEHOLDER: the stone's own cost stands in for the setting charge,
      // so totalStoneCost and totalSettingCost come out identical from one
      // number. In the real record they are independent (cost 0, setting
      // 0.01 x 120 stones). Awaiting a real per-stone setting rate --
      // Chaim 2026-09-02: stone cost and setting cost are set from the
      // final price decision, same as labor and vendor cost.
      settingChargePerStone: cost,
      settingChargePerStoneCeiling: null,
      totalBillWeightCaratStone: 0,
      totalSettingCost: round2(cost * quantity),
      countryOfOrigin: s(d.countryOfOrigin).toUpperCase(),
      treatment: "",
      additionalCharges: [],
    };
  });
  if (stoneRows.length && !stones.every((st) => st.stoneMillimeter))
    warnings.push("some stones have no size — cost/setting charge used the base bucket");
  if (stoneRows.length)
    warnings.push(
      `${stoneRows.length} stone row${stoneRows.length === 1 ? "" : "s"}: setting charge is a placeholder (the stone's own cost) until a real per-stone setting rate is set`
    );

  // Images — from the PLM's own R2-relative paths (sample.images), same
  // base URL the app already uses to display them (SampleCard.jsx).
  const dbHost = s(process.env.VITE_DB_HOST_URL);
  const imageSourceUrls = (Array.isArray(sample.images) ? sample.images : [])
    .filter(Boolean)
    .map((p) => `${dbHost}${p}`);
  if (!imageSourceUrls.length) warnings.push("no images on this sample — item will be created with no photos");
  else if (imageSourceUrls.length === 1) warnings.push("only 1 image on this sample — sending it twice under two filenames (SSP wants >=2)");

  const item = {
    productType: type.productType,
    productCategories: type.productCategories,
    itemDescription: s(sample.starting_description) || s(sample.name) || styleNumber,
    totalNetGramWeight: weight || 0.01,
    // SSP's item-create rejects this as a missing mandatory field when
    // null (confirmed 2026-08-26, product S188254: "Mandatory Fields are
    // missing" until this was populated) -- the PLM has no separate gross
    // weight, so default it to net weight (matches a real captured
    // payload where the two were equal) until stones/findings give it a
    // reason to diverge.
    totalGrossGramWeight: weight || 0.01,
    costingMethod: d.costingMethod,
    manufacturedCountryOfOrgin: s(d.countryOfOrigin).toUpperCase(), // (sic) — API misspells "Origin"
    productComponent: stones.length ? ["Material", "Stone"] : ["Material"],
    unitOfMeasure: "mandrel size",
    itemSize: String(nPositive(sample.length, 1)),
    itemHeight: nPositive(sample.height, 1),
    itemWidth: nPositive(sample.width, 1),
    sizeableIncrement: null,
    ringSizeMinimum: "1",
    ringSizeMaximum: "1",
    quantityType,
    setPiece: null,
    certificateType: [],
    certificationLab: [],
    // Same piece count as quantityType, so the two can never disagree.
    supplierPack: piecesPerUnit,
    isTetheredToMetalLossMatrix: false,
    isTetheredToDiamondPricingMatrix: false,
    isTetheredToOvercostMatrix: false,
  };

  // Material row — first pass from the sample's metal fields + live locks.
  const { karat, purity } = purityFor(sample);
  const metalType = s(sample.metalType).toLowerCase(); // Silver | Gold | Brass
  let material = null;
  if (metalType && purity != null && weight != null) {
    const basePrice = metalType === "gold" ? n(metalPrices.gold) : metalType === "silver" ? n(metalPrices.silver) : null;
    if (basePrice == null) warnings.push(`no live ${metalType || "metal"} price found — metal cost fields left null for SSP to fill`);
    const ppg = basePrice != null ? (basePrice * (purity / 1000)) / GRAMS_PER_TROY_OZ : null;
    // loss = base × L/(100−L), L ≈ 5% — the company's own documented metal
    // loss formula (see costing notes). CONFIRMED 2026-09-01 against a
    // real material row (S189443/item 1/material 1): metalCost there is
    // base+loss, not bare base (3.19 base + 0.17 loss = 3.36 metalCost),
    // and metalLossPercent/Amt are real nonzero values, not the 0/null
    // this code used to hardcode — which is the likely cause of the
    // "Exception occured during Update Product Material" 500 Chaim hit
    // (base cost with no matching loss fields looks like it failed SSP's
    // own recalculation on update).
    const METAL_LOSS_PCT = 5;
    const base = ppg != null ? weight * ppg : null;
    const lossAmt = base != null ? round2(base * (METAL_LOSS_PCT / (100 - METAL_LOSS_PCT))) : null;
    const platingEntries = platingsForSample(sample);
    const platingName = s(sample.plating_name) || s(sample.plating_label);
    if (!platingEntries.length && platingName && !/^none$/i.test(platingName))
      warnings.push(
        `plating "${platingName}" has no layers set — sent with no plating row. Add its material and micron in Settings → Signet SSP.`
      );
    if (platingEntries.some((p) => p.platingMicron == null))
      warnings.push(`plating "${platingName}" is missing a micron on at least one layer`);
    if (platingEntries.some((p) => !p.platingColor))
      warnings.push(`plating "${platingName}" is missing a colour on at least one layer`);
    material = {
      materialType: metalType,
      metalPurity: purity,
      // CONFIRMED 2026-09-01 (same real row): metalKarat is null for a
      // 925 silver item, not the "925 silver" string this used to send —
      // that's the other likely cause of the update 500. Gold's real
      // metalKarat shape is still unconfirmed; leave the raw karat string
      // for gold until we have a real gold-item HAR to check against.
      metalKarat: metalType === "silver" ? null : karat || null,
      metalAlloyColorNickelContents: [
        { key: s(sample.color).toLowerCase() || (metalType === "silver" ? "white" : "yellow"), value: "nickel safe" },
      ],
      materialNetWeight: weight,
      metalBasePrice: basePrice,
      metalFixingAllowPercent: 0,
      metalFixingAllowAmt: null,
      metalLossPercent: base != null ? METAL_LOSS_PCT : null,
      metalLossAmt: lossAmt,
      metalCost: base != null ? round2(base + (lossAmt || 0)) : null,
      metalCostPerGram: ppg != null ? round2(ppg) : null,
      platings: platingEntries,
      isTetheredToMetalLossMatrix: false,
      isFixedNoMetalLock: false,
    };
  } else {
    warnings.push("not enough metal data (metalType/karat/weight) — no material row; add it in SKU Manager");
  }

  // piecesPerUnit rides along for the labor tab: noOfCastings and
  // noOfAssembly have to match the item's own piece count (a pair is 2
  // castings and 2 assemblies), and the real captured update-laborcost
  // payload confirms that shape.
  return {
    payloads: { header, item, material, stones, imageSourceUrls, piecesPerUnit },
    warnings,
  };
}

/**
 * PREPARE — build every payload up front (no SSP calls except reading the
 * live metal locks from the PLM's own DB) so the batch can be confirmed
 * before anything is sent. NOTE: SSP has no overwrite — every send mints a
 * NEW SSP number, so don't re-run a batch that already succeeded.
 *
 * Returns { enabled, prepared[], failed[], total } where each prepared
 * entry is { sample, label, payloads, warnings }.
 */
export async function prepareSspCreatesForSamples(rows, { supabase, settings } = {}) {
  if (!isSspEnabled(settings)) return { enabled: false, prepared: [], failed: [], total: 0 };
  const metalPrices = await fetchMetalPrices(supabase);
  const prepared = [];
  const failed = [];
  for (const sample of rows || []) {
    const label = s(sample.styleNumber) || String(sample.sample_id || "?");
    try {
      if (!s(sample.styleNumber)) throw new Error("sample has no style number");
      const { payloads, warnings } = buildSspPayloadsForSample(sample, { settings, metalPrices });
      prepared.push({ sample, label, payloads, warnings });
    } catch (e) {
      failed.push({ sample: label, error: e?.message || String(e) });
    }
  }
  return { enabled: true, prepared, failed, total: (rows || []).length };
}

/**
 * SEND — create each prepared sample in SSP: header -> costing method ->
 * tethers -> item -> material. One sample failing never stops the rest;
 * a partial failure reports the minted SSP number so it can be finished by
 * hand in SKU Manager.
 *
 * Returns { enabled, created[], failed[], total } — created entries are
 * { sample, sspCode, itemId, warnings }.
 */
// ── Resume progress (survives a retry after a partial failure) ──────────
// header/save always mints a brand-new SSP number — there's no overwrite —
// so retrying a sample that already got as far as, say, item-create would
// otherwise mint a SECOND orphaned product every time. Remember how far
// each sample got (keyed by its style number/label) in localStorage so a
// retry picks up from the first step that actually failed instead of
// starting over — costing-method/tethers are cheap + idempotent so they
// just always re-run once sspCode exists; header/save, item-create,
// material, and each stone are the steps actually guarded.
const SSP_PROGRESS_VERSION = 1;

function sspProgressKey(label) {
  return `ssp-create-progress:v${SSP_PROGRESS_VERSION}:${label}`;
}

function loadSspProgress(label) {
  try {
    const raw = localStorage.getItem(sspProgressKey(label));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSspProgress(label, patch) {
  try {
    const current = loadSspProgress(label);
    localStorage.setItem(
      sspProgressKey(label),
      JSON.stringify({ ...current, ...patch, updatedAt: Date.now() })
    );
  } catch {
    /* best-effort — resuming is a convenience, not a requirement */
  }
}

function clearSspProgress(label) {
  try {
    localStorage.removeItem(sspProgressKey(label));
  } catch {
    /* no-op */
  }
}

/** Manually clear one sample's (or, with no arg, every sample's) resume
 * progress — e.g. to force a genuinely new product instead of continuing
 * a previous partial one. */
export function clearSspCreateProgress(label) {
  if (label) return clearSspProgress(label);
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("ssp-create-progress:"));
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

// Writes the SSP link straight to the sample's own row (samples.ssp_code /
// ssp_item_id, surfaced back through sample_with_stones_export as
// sample.ssp_code/ssp_item_id) so it survives forever — not just within one
// browser's localStorage. Without this, a sample that was already fully
// created went right back to "no memory of it" the moment sspProgress got
// cleared on success, so the NEXT "Create in SSP" click had nothing to
// resume from and minted a brand new SSP product every single time
// (2026-08-31: reported as "added a new item" / "not updating the current
// item" on a sample that had already been created earlier).
async function persistSspLink(supabase, sample, link) {
  if (!supabase || sample?.sample_id == null) return;
  try {
    const patch = {};
    if ("sspCode" in link) patch.ssp_code = link.sspCode ?? null;
    if ("itemId" in link) patch.ssp_item_id = link.itemId ?? null;
    if ("materialId" in link) patch.ssp_material_id = link.materialId ?? null;
    if ("stoneIds" in link) patch.ssp_stone_ids = link.stoneIds ?? null;
    const { error } = await supabase.from("samples").update(patch).eq("id", sample.sample_id);
    if (error) throw error;
  } catch (e) {
    console.error("Failed to persist SSP link to sample row:", e);
  }
}

export async function sendPreparedSspCreates(prepared, { settings, supabase, onProgress } = {}) {
  if (!isSspEnabled(settings)) return { enabled: false, created: [], failed: [], total: 0 };
  // Renew the SSP token up front (if a refresh token is on file and it's
  // expiring soon) instead of letting it die partway through a batch —
  // every call below uses this returned settings object, not the one
  // passed in, so the fresh token reaches every step.
  try {
    settings = await ensureFreshSspToken(settings, supabase);
  } catch (e) {
    console.error("SSP token refresh failed, continuing with existing token:", e);
  }
  const created = [];
  const failed = [];
  const list = prepared || [];
  for (let i = 0; i < list.length; i++) {
    const { label, payloads, warnings, sample } = list[i];
    const progress = loadSspProgress(label);
    // The DB link (sample.ssp_code/ssp_item_id) is the durable memory of an
    // already-created product; localStorage progress is only for resuming
    // a batch that failed partway through THIS browser session. Either can
    // supply the starting point — DB wins when both somehow disagree, since
    // it's the one every user/browser actually sees.
    let sspCode = sample?.ssp_code || progress.sspCode || null;
    let itemId = sample?.ssp_item_id || progress.itemId || null;
    let materialId = sample?.ssp_material_id || progress.materialId || null;
    // Stone ids line up with payloads.stones by INDEX (the order the
    // sample's own stones array is built in, which is stable run to run
    // unless someone adds/removes/reorders a stone row on the sample
    // itself). A new stone beyond what we have an id for just gets created;
    // one that was removed leaves its old SSP row untouched (no delete
    // endpoint here) rather than guessing which id to reuse for it.
    let stoneIds = Array.isArray(sample?.ssp_stone_ids)
      ? sample.ssp_stone_ids
      : Array.isArray(progress.stoneIds)
        ? progress.stoneIds
        : [];
    try {
      // Images first — cached by sspStageImage itself, so a retry doesn't
      // re-run the 5-request pipeline. Once we have a real sspCode (a
      // resumed sample), stage under it instead of "NEW_<ts>".
      const images = payloads.imageSourceUrls?.length
        ? await sspStageImagesForSample(settings, {
            sspCode,
            sourceUrls: payloads.imageSourceUrls,
            baseFilename: label,
          })
        : [];

      // Always call header/save, not just on the first attempt: it's the
      // ONLY call that attaches images, and a confirmed-real payload shows
      // it accepts an EXISTING sspCode to update a product rather than
      // requiring "" for create-only. Skipping this once sspCode was known
      // used to mean a sample whose first attempt got a broken image
      // reference (e.g. the tempSspImages/ path bug) stayed stuck with it
      // forever, since nothing ever re-attached the now-correctly-staged
      // photos on a retry.
      const head = await sspSaveHeader(settings, payloads.header, images, sspCode || "");
      sspCode = head.sspCode;
      saveSspProgress(label, { sspCode });
      await persistSspLink(supabase, sample, { sspCode });
      await sspSetCostingMethod(settings, sspCode, payloads.item.costingMethod);
      await sspSetTethers(settings, sspCode, {});
      if (!itemId) {
        const createdItem = await sspCreateItem(settings, sspCode, payloads.item);
        itemId = createdItem.itemId;
      } else {
        // Update the existing item in place — CONFIRMED 2026-08-31 via a
        // real HAR (S189443/item 1): the update call is `PUT
        // /item/{itemId}` (id in the URL), not the create POST with an
        // itemId in the body — that just makes a duplicate item, which is
        // exactly what happened before this fix. See sspUpdateItem.
        const updatedItem = await sspUpdateItem(settings, sspCode, itemId, payloads.item);
        if (updatedItem.itemId && updatedItem.itemId !== itemId) {
          warnings.push(
            `SSP returned itemId ${updatedItem.itemId}, not the expected ${itemId} on ${sspCode} — double check SKU Manager for a duplicate.`
          );
          itemId = updatedItem.itemId;
        }
      }
      saveSspProgress(label, { sspCode, itemId });
      await persistSspLink(supabase, sample, { sspCode, itemId });

      // Material — ask SSP what is actually there before choosing
      // create-vs-update, then confirm the write landed.
      //
      // Never branch on the stored materialId alone. SSP's
      // `PUT .../material/{id}` against an id that does not exist answers
      // HTTP 200 `success: true` and echoes the payload back while
      // persisting nothing (CONFIRMED 2026-09-01 on S189748/item 1). A
      // stored id that has gone stale therefore traps us in a loop: every
      // resend "succeeds", writes the phantom id back to Supabase, and the
      // item stays materially empty — SSP's own validator kept reporting
      // "Item indicates it should have 1 or more Material components, but
      // none were found" while our sends all came back green.
      if (payloads.material) {
        let liveMaterials = [];
        try {
          liveMaterials = await sspGetItemMaterials(settings, sspCode, itemId);
        } catch (e) {
          warnings.push(
            `Could not read existing materials on item ${itemId} (${sspCode}): ${e.message} — falling back to the stored id.`
          );
          liveMaterials = materialId ? [{ materialId }] : [];
        }

        const liveMaterialId = liveMaterials[0]?.materialId ?? null;
        if (materialId && !liveMaterialId) {
          warnings.push(
            `Stored materialId ${materialId} does not exist on item ${itemId} (${sspCode}) — creating a fresh material instead of updating a phantom row.`
          );
        }

        if (!liveMaterialId) {
          const addedMaterial = await sspAddMaterial(settings, sspCode, itemId, payloads.material);
          materialId = addedMaterial.materialId ?? null;
        } else {
          const updatedMaterial = await sspUpdateMaterial(
            settings,
            sspCode,
            itemId,
            liveMaterialId,
            payloads.material
          );
          materialId = updatedMaterial.materialId ?? liveMaterialId;
        }

        // Confirm it actually landed — a green response is not proof.
        let confirmedMaterialId = materialId;
        try {
          const afterMaterials = await sspGetItemMaterials(settings, sspCode, itemId);
          confirmedMaterialId = afterMaterials[0]?.materialId ?? null;
          if (!confirmedMaterialId) {
            throw new Error(
              `SSP reported success but item ${itemId} (${sspCode}) still has no material — nothing was saved.`
            );
          }
          if (materialId && confirmedMaterialId !== materialId) {
            warnings.push(
              `SSP returned materialId ${materialId} but item ${itemId} (${sspCode}) actually holds ${confirmedMaterialId} — using the live id.`
            );
          }
          materialId = confirmedMaterialId;
        } catch (e) {
          // Do not persist an id we could not verify: a phantom pointer is
          // what causes the silent-no-op loop in the first place.
          materialId = null;
          saveSspProgress(label, { sspCode, itemId, materialId });
          await persistSspLink(supabase, sample, { sspCode, itemId, materialId });
          throw e;
        }

        saveSspProgress(label, { sspCode, itemId, materialId });
        await persistSspLink(supabase, sample, { sspCode, itemId, materialId });
      }

      // Stones — same caution: only create stones we don't already have an
      // id for; skip resending ones we do until update is confirmed.
      const stones = payloads.stones || [];
      const nextStoneIds = stoneIds.slice(0, stones.length);
      for (let si = 0; si < stones.length; si++) {
        const existingStoneId = nextStoneIds[si] || 0;
        if (existingStoneId) {
          warnings.push(
            `Stone ${existingStoneId} on item ${itemId} (${sspCode}) already exists — stone fields were NOT resent (same unconfirmed-update-endpoint risk as item; see above).`
          );
          continue;
        }
        const addedStone = await sspAddStone(settings, sspCode, itemId, stones[si], 0);
        nextStoneIds[si] = addedStone.stoneId ?? existingStoneId;
        saveSspProgress(label, { sspCode, itemId, materialId, stoneIds: nextStoneIds });
        await persistSspLink(supabase, sample, { sspCode, itemId, materialId, stoneIds: nextStoneIds });
      }
      stoneIds = nextStoneIds;

      clearSspProgress(label); // fully created/updated — nothing left to resume
      created.push({ sample: label, sspCode, itemId, warnings });
    } catch (e) {
      failed.push({
        sample: label,
        sspCode, // non-null = partially created; a retry resumes from here
        error: e?.message || String(e),
      });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }
  return { enabled: true, created, failed, total: list.length };
}
