// src/utils/sspCreate.js
//
// Sample -> SSP item creation (the Samples page's "Create in SSP" actions).
//
// BEST-EFFORT V1: a sample row (sample_with_stones_export shape) carries the
// header/item basics and enough metal data for a first-pass material row,
// but NOT the full SSP costing detail (findings, labor, stones costing).
// This module creates the product header + item + one material row and
// stops there — the rest is finished by hand in SKU Manager, where the new
// product sits in the hold queue as "Pending Vendor Submission".
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
  sspSaveHeader,
  sspSetCostingMethod,
  sspSetTethers,
  sspCreateItem,
  sspAddMaterial,
} from "./sspClient";

// ---------------------------------------------------------------------------
// Tunables — v1 guesses, refine together as real samples go through.
// ---------------------------------------------------------------------------

// PLM sample_category -> SSP { productType, productCategories }.
// SSP's vocabulary comes from /item/get-filters; these are the values seen
// in the recorded setup plus reasonable guesses. Unmapped categories fall
// back to DEFAULT_TYPE and get flagged in the preflight so nothing slips
// through silently.
export const CATEGORY_TO_SSP = {
  charms: { productType: "charms", productCategories: ["earring charm"] },
  charm: { productType: "charms", productCategories: ["earring charm"] },
  "hoop charms": { productType: "charms", productCategories: ["earring charm"] },
  earring: { productType: "earrings", productCategories: ["stud earrings"] },
  studs: { productType: "earrings", productCategories: ["stud earrings"] },
  hoops: { productType: "earrings", productCategories: ["hoop earrings"] },
  flatbacks: { productType: "earrings", productCategories: ["stud earrings"] },
  "silver flatbacks": { productType: "earrings", productCategories: ["stud earrings"] },
  "kids earring": { productType: "earrings", productCategories: ["stud earrings"] },
  necklace: { productType: "necklaces", productCategories: ["necklace"] },
  "tennis necklace": { productType: "necklaces", productCategories: ["necklace"] },
  pendant: { productType: "necklaces", productCategories: ["pendant"] },
  ring: { productType: "rings", productCategories: ["ring"] },
  bracelet: { productType: "bracelets", productCategories: ["bracelet"] },
  bangle: { productType: "bracelets", productCategories: ["bangle"] },
  "nose ring": { productType: "body jewelry", productCategories: ["nose"] },
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

// ---------------------------------------------------------------------------

const s = (v) => (v == null ? "" : String(v).trim());
const n = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function categoryFor(sample) {
  const key = s(sample.sample_category || sample.starting_category).toLowerCase();
  return { mapped: CATEGORY_TO_SSP[key] || null, key };
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
  const { mapped, key } = categoryFor(sample);
  if (!mapped) warnings.push(`category "${key || "(none)"}" not in CATEGORY_TO_SSP — using ${DEFAULT_TYPE.productType}`);
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

  const weight = n(sample.weight) ?? n(sample.salesWeight);
  if (weight == null) warnings.push("no weight on the sample — totalNetGramWeight sent as 0.01");

  const sellsAs = s(sample.selling_pair).toLowerCase(); // single | pair | set
  const item = {
    productType: type.productType,
    productCategories: type.productCategories,
    itemDescription: s(sample.starting_description) || s(sample.name) || styleNumber,
    totalNetGramWeight: weight ?? 0.01,
    totalGrossGramWeight: null,
    costingMethod: d.costingMethod,
    manufacturedCountryOfOrgin: s(d.countryOfOrigin).toUpperCase(), // (sic) — API misspells "Origin"
    productComponent: ["Material"],
    unitOfMeasure: "mandrel size",
    itemSize: s(sample.length) || "1",
    itemHeight: n(sample.height) ?? 1,
    itemWidth: n(sample.width) ?? 1,
    sizeableIncrement: null,
    ringSizeMinimum: "1",
    ringSizeMaximum: "1",
    quantityType: sellsAs === "pair" ? "pair" : sellsAs === "set" ? "set" : "each",
    setPiece: null,
    certificateType: [],
    certificationLab: [],
    supplierPack: sellsAs === "pair" ? 2 : 1,
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
    const plating = s(sample.plating).toLowerCase();
    const isVermeil = plating.includes("14k") || plating.includes("vermeil") || plating.includes("0.5");
    material = {
      materialType: metalType,
      metalPurity: purity,
      metalKarat: karat === "925" ? "925 silver" : karat,
      metalAlloyColorNickelContents: [
        { key: s(sample.color).toLowerCase() || (metalType === "silver" ? "white" : "yellow"), value: "nickel safe" },
      ],
      materialNetWeight: weight,
      metalBasePrice: basePrice,
      metalFixingAllowPercent: 0,
      metalFixingAllowAmt: null,
      metalLossPercent: 0,
      metalLossAmt: null,
      metalCost: ppg != null ? round2(ppg * weight) : null,
      metalCostPerGram: ppg != null ? round2(ppg) : null,
      platings: isVermeil
        ? [
            {
              platingMaterial: "gold 14k",
              platingColor: "yellow",
              platingMethod: "galvanic / electroplating",
              platingMicron: 0.5,
              platingCost: n(sample.platingCharge) ?? 0.2,
              platingCoverageClassification: "Full",
              componentTab: "material",
            },
          ]
        : [],
      isTetheredToMetalLossMatrix: false,
      isFixedNoMetalLock: false,
    };
  } else {
    warnings.push("not enough metal data (metalType/karat/weight) — no material row; add it in SKU Manager");
  }

  return { payloads: { header, item, material }, warnings };
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
export async function sendPreparedSspCreates(prepared, { settings, onProgress } = {}) {
  if (!isSspEnabled(settings)) return { enabled: false, created: [], failed: [], total: 0 };
  const created = [];
  const failed = [];
  const list = prepared || [];
  for (let i = 0; i < list.length; i++) {
    const { label, payloads, warnings } = list[i];
    let sspCode = null;
    try {
      const head = await sspSaveHeader(settings, payloads.header);
      sspCode = head.sspCode;
      await sspSetCostingMethod(settings, sspCode, payloads.item.costingMethod);
      await sspSetTethers(settings, sspCode, {});
      const { itemId } = await sspCreateItem(settings, sspCode, payloads.item);
      if (payloads.material) await sspAddMaterial(settings, sspCode, itemId, payloads.material);
      created.push({ sample: label, sspCode, itemId, warnings });
    } catch (e) {
      failed.push({
        sample: label,
        sspCode, // non-null = partially created; finish it in SKU Manager
        error: e?.message || String(e),
      });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }
  return { enabled: true, created, failed, total: list.length };
}
