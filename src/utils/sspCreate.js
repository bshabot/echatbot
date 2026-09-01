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
  sspAddStone,
  sspStageImagesForSample,
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

// Plating -> SSP material.platings[] entry. Matched against the PLM's own
// plating.tag_label (surfaced as sample.plating_label on the export view --
// same field src/utils/tags/plating.js uses for tags, "the plating function
// in the plm" per Chaim, 2026-08-31). IMPORTANT: sample.plating itself is
// just the numeric FK into the `plating` table, not text -- matching
// against IT (as this code used to, via a "14k"/"vermeil"/"0.5" substring
// check) can never succeed, which is why platings[] was silently empty on
// EVERY item regardless of actual plating, vermeil included, until this was
// fixed. Micron values are read off each type's own DB name (the names
// literally embed the spec, e.g. "14k Gold Plated .5 micron") except
// rhodium, whose micron comes from company convention (0.75) since "RHD"
// doesn't encode it. platingCost still falls back to a placeholder when the
// sample has no platingCharge -- that number was already flagged as a weak
// spot before this change and remains one; only the material/color/method/
// micron half of this is newly solid.
const PLATING_RULES = [
  { test: /rhodium(?!.*black)|^rhd$/i, material: "rhodium", color: "white", micron: 0.75 },
  { test: /black.*rhodium|^bpt$/i, material: "rhodium", color: "black", micron: 0.75 },
  { test: /14k.*gold|vermeil/i, material: "gold 14k", color: "yellow", micron: 0.5 },
  { test: /10k.*gold/i, material: "gold 10k", color: "yellow", micron: 0.5 },
  { test: /silver plated/i, material: "silver", color: "white", micron: 1.0 },
  { test: /ip\s*gold/i, material: "gold", color: "yellow", micron: 0.5 },
  { test: /ip\s*silver/i, material: "silver", color: "white", micron: 1.0 },
  { test: /^none$/i, material: null },
];

/** sample.plating_label (preferred) or sample.plating_name -> a platings[]
 * entry, or null when there's genuinely no plating (or nothing recognized). */
function platingForSample(sample) {
  const label = s(sample.plating_label) || s(sample.plating_name);
  if (!label) return null;
  const rule = PLATING_RULES.find((r) => r.test.test(label));
  if (!rule || !rule.material) return null;
  return {
    platingMaterial: rule.material,
    platingColor: rule.color,
    platingMethod: "galvanic / electroplating",
    platingMicron: rule.micron,
    platingCost: n(sample.platingCharge) ?? 0.2,
    platingCoverageClassification: "Full",
    componentTab: "material",
  };
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
  if (!weight) warnings.push("no weight on the sample — totalNetGramWeight sent as 0.01");
  if (!n(sample.length) || !n(sample.height) || !n(sample.width))
    warnings.push(
      "missing or zero length/height/width on the sample — SSP rejects a 0 dimension as a missing mandatory field, so itemSize/itemHeight/itemWidth were sent as 1"
    );

  const sellsAs = s(sample.selling_pair).toLowerCase(); // single | pair | set

  // Stones — from the PLM's own stones array (sample_with_stones_export
  // shape: id/type/customType/color/shape/size/quantity/cost/notes).
  const stoneRows = Array.isArray(sample.stones) ? sample.stones : [];
  const stones = stoneRows.map((st) => {
    const mm = n(st.size);
    const cost = n(st.cost) ?? stoneCostForSize(mm);
    const quantity = n(st.quantity) ?? 1;
    return {
      isPrimaryStone: false,
      category: "cubic zirconia",
      type: "NA",
      stoneMillimeter: mm != null ? String(mm) : "",
      shape: s(st.shape).toLowerCase() || "round",
      cut: "NA",
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
      certificateType: [],
      certificationLab: [],
      settingLocation: s(d.countryOfOrigin).toUpperCase(),
      settingType: "prong",
      settingMethod: "hand_wax",
      settingChargePerStone: cost,
      totalBillWeightCaratStone: 0,
      totalSettingCost: round2(cost * quantity),
      countryOfOrigin: s(d.countryOfOrigin).toUpperCase(),
      treatment: "NA",
      additionalCharges: null,
    };
  });
  if (stoneRows.length && !stones.every((st) => st.stoneMillimeter))
    warnings.push("some stones have no size — cost/setting charge used the base bucket");

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
    quantityType: sellsAs === "pair" ? "pair" : sellsAs === "set" ? "set" : "each",
    setPiece: null,
    certificateType: [],
    certificationLab: [],
    // Per Chaim (2026-08-26): supplierPack is 2 for earrings (they sell as
    // a pair) and 1 for everything else -- keyed on the product's actual
    // category, not the selling_pair field (which is specific to how one
    // earring SKU is packed/sold and isn't populated for non-earring rows).
    supplierPack: type.productType === "earrings" ? 2 : 1,
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
    const platingEntry = platingForSample(sample);
    if (!platingEntry && s(sample.plating_label) && !/^none$/i.test(s(sample.plating_label)))
      warnings.push(`plating "${sample.plating_label}" not recognized — sent with no plating row; add it to PLATING_RULES`);
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
      platings: platingEntry ? [platingEntry] : [],
      isTetheredToMetalLossMatrix: false,
      isFixedNoMetalLock: false,
    };
  } else {
    warnings.push("not enough metal data (metalType/karat/weight) — no material row; add it in SKU Manager");
  }

  return { payloads: { header, item, material, stones, imageSourceUrls }, warnings };
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

      // Material — resend every time, targeting the existing row by id
      // once we have one. CONFIRMED 2026-09-01 via a real HAR
      // (S189443/item 1/material 1): same shape as item — PUT
      // .../item/{itemId}/material/{materialId}, id in the URL.
      if (payloads.material) {
        if (!materialId) {
          const addedMaterial = await sspAddMaterial(settings, sspCode, itemId, payloads.material);
          materialId = addedMaterial.materialId ?? materialId;
        } else {
          const updatedMaterial = await sspUpdateMaterial(settings, sspCode, itemId, materialId, payloads.material);
          if (updatedMaterial.materialId && updatedMaterial.materialId !== materialId) {
            warnings.push(
              `SSP returned materialId ${updatedMaterial.materialId}, not the expected ${materialId} on item ${itemId} (${sspCode}) — double check SKU Manager for a duplicate.`
            );
            materialId = updatedMaterial.materialId;
          }
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
