// src/utils/sspPayloads.js
//
// Pure payload builder for Signet SSP items (sample row -> header / item /
// material / finding / stones / labor / vendorCost). Split out of sspCreate.js
// so the same code runs in the browser (Create in SSP) AND in the Netlify
// function /api/ssp-fill that feeds the SSP Chrome extension. No browser,
// network or Supabase-client dependencies here (fetchMetalPrices takes the
// client as an argument).

function getSspConfig(settings) {
  const ssp = settings?.options?.sspIntegration || {};
  return { defaults: ssp.defaults || {} };
}

// All items are nickel free (not "nickel safe") -- Kevin, 2026-10-12.
export const NICKEL_CONTENT = "nickel free";

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
export const DEFAULT_TYPE = { productType: "charms", productCategories: ["earring charm"] };

// Banter buyer by department (Kevin, 2026-09-15) -- charm dept 563 (Jenna
// Wilde) and chain dept 553 (Jamie Prock) own their category regardless of
// metal; everything else splits by metal between gold dept 552 (Nicole
// Banks) and silver dept 554 (Cassidy Davis). Falls back to Settings'
// single buyer field when none of these match (e.g. brass with no chain/
// charm category), so that field is still worth setting.
export function buyerForSample(sample, fallback) {
  const category = s(sample.type_ssp_product_type || sample.type_name).toLowerCase();
  const metal = s(sample.metalType).toLowerCase();
  if (/charm/.test(category)) return "Jenna Wilde";
  if (/chain/.test(category)) return "Jamie Prock";
  if (metal === "gold") return "Nicole Banks";
  if (metal === "silver") return "Cassidy Davis";
  return fallback || "";
}

// Metal purity per karat tag as SSP stores it (925 silver / 417 10k / 585 14k).
// Kevin, 2026-09-16: brass items (T2/T3/T7/T9-test) were hitting "not
// enough metal data" even with metalType/karat/weight all set, because
// "brass" had no entry here -- purityFor() returned null purity and the
// material branch in buildSspPayloadsForSample requires a non-null
// purity to build a material row at all. Brass isn't a karat alloy, it's
// effectively 100% base metal (matches MetalTypeUtil's own purity table:
// Brass: 1.00), and 1000 is a real SSP metalPurity value (confirmed in
// the live ssp_vocabulary pull alongside 925/417/585/750/916/999).
export const KARAT_TO_PURITY = { "925": 925, "10k": 417, "14k": 585, "18k": 750, brass: 1000 };

// Signet's per-gram conversion uses 31.1 g/troy-oz (their convention).
export const GRAMS_PER_TROY_OZ = 31.1;

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

// Stone cost default -- Kevin, 2026-10-07: a stone with no cost (or 0) gets a
// default by size: 5mm and up 3 cents, 4mm 2 cents, anything smaller 1 cent.
// A stone cost is never 0. Two different sizes on one item are always at least
// a cent apart (bigger stone costs more). `cost` and `settingChargePerStone`
// stay equal to each other (matches the recorded add-stone HAR). These can be
// moved up or down automatically to meet a sales price, but never below the
// floors from stoneFloorMap().
export function stoneDefaultCostForSize(mm) {
  const size = Number(mm);
  if (!Number.isFinite(size) || size <= 0) return 0.01;
  if (size >= 5) return 0.03;
  if (size >= 4) return 0.02;
  return 0.01;
}

// Lowest allowed cost per size on ONE item: smallest size 0.01, each larger
// distinct size one more cent. Key is the numeric size (0 = unknown size).
export function stoneFloorMap(sizes) {
  const distinct = [...new Set(sizes.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)))].sort((p, q) => p - q);
  const map = new Map();
  distinct.forEach((sz, i) => map.set(sz, Math.round((i + 1) * 1) / 100));
  return map;
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
export const PLM_COLOR_TO_SSP = {
  silver: "white",
  white: "white",
  yellow: "yellow",
  rose: "rose",
  pink: "rose",
  black: "black",
};

// Kevin, 2026-09-17: rhodium runs $0.20/gram, silver runs $1.00/gram --
// no longer one flat rate for every plating layer.
export const RHODIUM_PLATING_COST_PER_GRAM = 0.2;
export const SILVER_PLATING_COST_PER_GRAM = 1.0;

export function platingsForSample(sample) {
  const layers = Array.isArray(sample.plating_layers) ? sample.plating_layers : [];
  const itemColor = PLM_COLOR_TO_SSP[s(sample.color).toLowerCase()] || null;
  const netWeight = n(sample.salesWeight) ?? n(sample.weight) ?? 0;
  const baseMetal = s(sample.metalType).toLowerCase();
  return layers
    .filter((l) => l && l.material)
    // Kevin, 2026-09-17: "why are you adding silver plating if the
    // material is silver, that's only for brass material" -- some
    // plating recipes (e.g. RHD 0.75mic) carry a silver flash layer
    // under the real top coat, meant to give BRASS a reflective silver
    // base before the top layer goes on. A sterling silver (925) item
    // is already silver, so that flash layer is meaningless there --
    // drop it when the item's own base metal is already silver.
    .filter((l) => !(String(l.material).toLowerCase() === "silver" && baseMetal === "silver"))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map((l) => {
      const layerMaterial = String(l.material || "").toLowerCase();
      const ratePerGram = layerMaterial === "silver" ? SILVER_PLATING_COST_PER_GRAM : RHODIUM_PLATING_COST_PER_GRAM;
      return {
        platingMaterial: l.material,
        platingColor: itemColor || l.color || null,
        platingMethod: l.method || "galvanic / electroplating",
        platingMicron: l.micron == null ? null : Number(l.micron),
        // vermeil's still moves with the gold lock -- that part remains
        // a known gap. Absent an explicit cost, this is the per-material
        // rate above times the item's net weight.
        platingCost: n(l.cost) ?? n(sample.platingCharge) ?? round2(ratePerGram * netWeight),
        platingCoverageClassification: l.coverage || "Full",
        componentTab: "material",
      };
    });
}

// ---------------------------------------------------------------------------

export const s = (v) => (v == null ? "" : String(v).trim());
export const n = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// whenever the value is missing OR zero.
export const nPositive = (v, fallback) => {
  const num = n(v);
  return num == null || num === 0 ? fallback : num;
};
export const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export function categoryFor(sample) {
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

export function purityFor(sample) {
  const karat = s(sample.karat).toLowerCase();
  return { karat, purity: KARAT_TO_PURITY[karat] ?? null };
}

/** Current gold/silver lock from the metal_prices table, for the material row. */
export async function fetchMetalPrices(supabase) {
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

  const buyer = buyerForSample(sample, d.buyer);
  if (!buyer) warnings.push("no buyer set (Settings → SSP integration) and no category/metal rule matched");

  const header = {
    vendorSubsidiaryName: "E CHABOT LTD",
    vendorNumber: "30374",
    vendorSubsidiaryNumber: "30374",
    vendorCurrency: "USD",
    vendorStyleNumber: styleNumber,
    buyer,
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
    // Kevin, 2026-09-17: origin/ship-from is always Vietnam (d.countryOfOrigin
    // above), sold-to/ship-to is always USA -- confirmed, not a guess anymore.
    shippedToCountry: "USA",
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
  // Rings: Item Height IS the ring size (that is how SSP works for rings), so
  // the ring size is sent as both the Ring Size Min/Max and the Item Height, and
  // no separate height is needed -- Kevin, 2026-10-20. Length and width are still
  // required.
  const isRing = type.productType === "rings";
  const ringSizeNum = n(sample.ring_size);
  const ringHeightFromSize = isRing && ringSizeNum != null;
  const missingDims = ["length", "height", "width"].filter((k) => !n(sample[k]) && !(k === "height" && ringHeightFromSize));
  if (missingDims.length)
    throw new Error(
      isRing
        ? `missing ${missingDims.join(" and ")}${ringSizeNum == null ? " (a ring also needs its ring size, which is sent as the height)" : ""} — set it on the sample first`
        : "missing or zero length/height/width — item dimensions are required before Create in SSP (set them on the sample first)"
    );
  if (ringHeightFromSize) warnings.push(`ring: ring size ${ringSizeNum} sent as the item height`);

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
    const cost = n(st.cost) > 0 ? n(st.cost) : null; // null/0 -> defaulted below
    const quantity = n(st.quantity) ?? 1;
    return {
      // Field conventions corrected 2026-09-14 against a real captured
      // add-stone payload for N3065R-test5/S191762 (Kevin, straight off
      // Chrome DevTools' Payload tab): SSP stores "NA" -- not "" -- for
      // type/cut/treatment, an empty ARRAY for the certificate fields
      // (not null), and null (not []) for additionalCharges. Also drops
      // settingChargePerStoneCeiling entirely -- it isn't part of the
      // real request at all. (Superseded the 2026-09-02 S177067 capture
      // this used to cite, which had these three the other way.)
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
      // "prong" IS a valid SSP settingType (confirmed against
      // stone/get-filters: bar, bead, bezel, channel, double prong, drilled,
      // flush, glued, half bezel, invisible, nick, pave, pin, pressure,
      // prong, shared prong, split prong, string / thread, talon prong,
      // v tip prong). Kevin, 2026-09-17: added a per-stone Setting Type
      // dropdown to the Stones form (prong/bezel/shared prong/pave) --
      // use that when it's set, falling back to the old "prong" blanket
      // default when it isn't. SSP's own vocab spells it "pave", no
      // accent, so normalize the UI's "Pavé" label down to that.
      settingType: (s(st.settingType).toLowerCase() === "pavé" ? "pave" : s(st.settingType).toLowerCase()) || "prong",
      settingMethod: "hand_wax",
      // Confirmed intentional, not a placeholder -- Kevin, 2026-09-14:
      // "setting charge per stone and cost both come from the stone
      // charge." totalStoneCost and totalSettingCost both derive from the
      // same per-stone cost number by design.
      settingChargePerStone: cost,
      totalBillWeightCaratStone: 0,
      totalSettingCost: round2(cost * quantity),
      countryOfOrigin: s(d.countryOfOrigin).toUpperCase(),
      treatment: "NA",
      additionalCharges: null,
    };
  });
  // Fill defaulted costs smallest size first, keeping different sizes >= 1 cent apart.
  {
    const order = stones.map((_, i) => i).sort((i, j) => (n(stoneRows[i].size) || 0) - (n(stoneRows[j].size) || 0));
    let prevSize = null;
    let prevCost = 0;
    for (const i of order) {
      const st = stones[i];
      const sz = n(stoneRows[i].size) || 0;
      let c = st.cost;
      if (c == null) {
        c = stoneDefaultCostForSize(sz);
        if (prevSize != null && sz > prevSize && c < round2(prevCost + 0.01)) c = round2(prevCost + 0.01);
        if (prevSize != null && sz === prevSize) c = prevCost;
        st.cost = c;
        st.settingChargePerStone = c;
        st.totalStoneCost = round2(c * st.quantity);
        st.totalSettingCost = round2(c * st.quantity);
      }
      prevSize = sz;
      prevCost = c;
    }
  }
  if (stoneRows.length && !stones.every((st) => st.stoneMillimeter))
    warnings.push("some stones have no size — cost/setting charge used the base bucket");
  if (stoneRows.length)
    warnings.push(
      `${stoneRows.length} stone row${stoneRows.length === 1 ? "" : "s"}: setting charge is a placeholder (the stone's own cost) until a real per-stone setting rate is set`
    );

  // Finding — from the type row's defaults (Chaim 2026-09-03: findings are
  // practically the same across items, so they live on the type, not per
  // sample). Quantity is 2 for a pair and 1 for everything else.
  //
  // metalKarat is "" here, NOT null as on the material row -- confirmed on two
  // real captures (S177067 charm, S52236 earring). Copy each component's own
  // convention.
  const findingType = s(sample.finding_type);

  // Kevin, 2026-09-22: snap lock / hinge earring findings size relative to
  // the item's own length (mm) rather than the fixed ssp_finding_defaults
  // value -- snap lock = length - 2mm, hinge = length - 5mm. Anything else
  // keeps using the flat default from the view (finding_size).
  const findingLength = n(sample.length);
  const dynamicFindingSize =
    findingLength == null
      ? null
      : findingType.toLowerCase() === "snap lock"
        ? round2(findingLength - 2)
        : findingType.toLowerCase() === "hinge"
          ? round2(findingLength - 5)
          : null;

  // The finding's metal cost is derived from its own weight (Chaim,
  // 2026-09-08), using the same formula as the material row:
  //   ppg  = lock price x purity / 31.1
  //   loss = weight x ppg x 5/95
  // The fixing allowance runs at 1% of the lock price on every capture
  // (base 65 -> allowance 0.65).
  const { purity: findingPurity } = purityFor(sample);
  const findingMetal = s(sample.metalType).toLowerCase();
  const findingBasePrice =
    findingMetal === "gold"
      ? n(metalPrices.gold)
      : findingMetal === "silver"
        ? n(metalPrices.silver)
        : null;
  const findingPpg =
    findingBasePrice != null && findingPurity != null
      ? (findingBasePrice * (findingPurity / 1000)) / GRAMS_PER_TROY_OZ
      : null;
  const findingWeight = n(sample.finding_net_weight);
  const findingLossAmt =
    findingPpg != null && findingWeight != null
      ? round2(findingWeight * findingPpg * (5 / 95))
      : null;

  const finding = findingType
    ? {
        findingType,
        // Kevin, 2026-09-17: "the material should follow what is on the data,
        // not a different [value]" -- prefer the sample's own real metal
        // (ssp_metal_defaults.material_type) over the finding default's
        // often-generic hardcoded material_type (e.g. "silver" on a brass
        // item's lobster clasp default).
        materialType: s(sample.metal_material_type) || s(sample.finding_material_type) || null,
        metalPurity: n(sample.metal_purity),
        metalKarat: s(sample.metal_karat) || "",
        metalColor: s(sample.metal_color) || null,
        // Kevin, 2026-10-12: every item is nickel FREE (not "nickel safe").
        nickelContent: NICKEL_CONTENT,
        description: "",
        quantity: effectiveSellsAs === "pairs" ? 2 : 1,
        // CONFIRMED 2026-09-16 live (T10-BRAC-LOBSTERBOX-test/S193993/item
        // 1): size: 7 (number) 400'd with "Mandatory fields for Precious
        // Metal Finding are missing or invalid"; size: "7" (string),
        // otherwise identical, succeeded and the finding really landed
        // (checked with a re-GET). Same string-not-number quirk as
        // material's metalKarat -- SSP's finding schema wants this size
        // as a string even though it's numeric like metalPurity, which
        // stays a number.
        size:
          dynamicFindingSize != null
            ? String(dynamicFindingSize)
            : sample.finding_size == null || sample.finding_size === ""
              ? null
              : String(sample.finding_size),
        netWeight: findingWeight,
        metalCostPerGram: findingPpg != null ? round2(findingPpg) : null,
        findingMetalBasePrice: findingBasePrice,
        // Kevin, 2026-09-23: reverted the 2026-09-22 change -- finding
        // metal fixing allow is 1% across the board ("metal allow is 1
        // basically"), matching the original real-capture value.
        findingMetalFixingAllowPercent: findingBasePrice != null ? 1 : null,
        findingMetalFixingAllowAmt:
          findingBasePrice != null ? round2(findingBasePrice * 0.01) : null,
        findingMetalLossPercent: n(sample.metal_loss_percent) ?? 5,
        findingMetalLossAmt: findingLossAmt,
        // Kevin, 2026-09-17: confirmed via a real SKU Manager UI capture
        // (S193993/item 1, finding "lobster pear") -- this flag is on the
        // finding payload too, not just material's. Same costingMethod
        // source the item object uses (line ~652) -- computed here
        // independently since `item` isn't built yet at this point in
        // the function.
        isFixedNoMetalLock: (s(sample.costing_method) || d.costingMethod) === "fixed no metal lock",
        findingMaterialType: "",
        manufacturingType: "casted",
        laborCost: n(sample.finding_labor_cost),
        countryOfOrigin: s(d.countryOfOrigin).toUpperCase(),
        findingMaterialCost: n(sample.finding_material_cost),
        tetherMetalLossGrid: true,
        // The flat plating fields sit empty beside the real array, matching
        // the captured payloads.
        platingMaterial: "",
        platingColor: "",
        platingMethod: "",
        platingMicron: 0,
        platingCost: 0,
        platings: platingsForSample(sample).map((p) => ({ ...p, componentTab: "finding" })),
      }
    : null;
  if (!finding && /earring|charm/i.test(s(sample.type_ssp_product_type)))
    warnings.push(
      `no finding set for ${sample.type_ssp_product_type} — SSP reports "Missing Component" without one. Set it on the type in Settings → Signet SSP.`
    );

  // Labor — one record per item. SSP computes every total, so only inputs go
  // up. Casting is variable per item and assembly has no agreed number yet,
  // so both are left null rather than defaulted; high polish at 1 is set.
  const finishingType = s(sample.finishing_type);
  const labor = {
    noOfCastings: n(sample.casting_cost) != null ? piecesPerUnit : null,
    ttlLaborCastingCost: n(sample.casting_cost),
    noOfAssembly: n(sample.assembly_charge) != null ? piecesPerUnit : null,
    assemblyCharge: n(sample.assembly_charge),
    laborPerGram: n(sample.labor_per_gram),
    ttlLaborSettingCost: null,
    ttlLaborChainCost: null,
    ttlLaborFindingCost: null,
    ttlAllMaterialCost: null,
    ttlLaborAssemblyCost: null,
    ttlLaborFinishingCost: null,
    manufacturingProcess1: "",
    manufacturingProcessCost1: null,
    manufacturingProcess2: "",
    manufacturingProcess3: "",
    manufacturingProcessCost2: null,
    manufacturingProcessCost3: null,
    ttlLaborPgCost: null,
    ttlAllLaborCosts: null,
    finish: finishingType
      ? [
          {
            sspCode: "",
            sku: 0,
            itemId: "",
            finishId: null,
            finishType: finishingType,
            finishCost: n(sample.finishing_cost),
          },
        ]
      : [],
  };

  // Vendor cost -- sent on every item (per Kevin, 2026-09-10), but ONLY
  // overriding the fields the PLM actually has a real source for:
  // packaging desc/cost and tag qty/cost, off the category row (confirmed
  // real PUT capture, S192244), plus vendorDiscountPerc (see below --
  // SSP requires it). Everything else on that tab -- overcost, dropship
  // fee (no DS/dropship flag exists anywhere in the PLM yet -- known gap,
  // not wired), gem/cert fields, and every greyed-out toggle SSP itself
  // controls -- is intentionally left OUT of this object so
  // sendPreparedSspCreates's GET-first merge leaves SSP's own current
  // values alone instead of guessing and overwriting them.
  // Kevin, 2026-09-22: SSP now rejects the vendor-cost save outright
  // ("Vendor Reimbursement Rate % is required.") without vendorDiscountPerc
  // -- reinstated, per-metal this time (was a flat 16.25 guess on
  // 2026-09-15, then removed entirely on 2026-09-16 when that flat number
  // couldn't be confirmed against a real capture). Confirmed rates: Silver
  // 16.25%, Gold 17.05%, Brass 11%.
  const VENDOR_REIMBURSEMENT_RATE_PERCENT = { silver: 16.25, gold: 17.05, brass: 11 };
  const vendorCost = {
    overcostPerc: 0,
    vendorDiscountPerc: VENDOR_REIMBURSEMENT_RATE_PERCENT[findingMetal] ?? null,
  };
  if (s(sample.packaging_desc)) vendorCost.vdrPackagingDesc = s(sample.packaging_desc);
  if (n(sample.packaging_cost) != null) vendorCost.vdrPackagingCost = n(sample.packaging_cost);
  if (n(sample.tag_qty) != null) vendorCost.tagQty = n(sample.tag_qty);
  // Kevin, 2026-09-17: "Ticket Cost is 38 cents" -- default to it instead
  // of leaving tagCost unsent when the sample has no cost of its own.
  vendorCost.tagCost = n(sample.tag_cost) ?? 0.38;

  // Ceilings, per Chaim 2026-09-03. Warn rather than clamp -- a number over
  // the limit is a data problem to look at, not something to silently trim.
  if (n(sample.assembly_charge) != null && n(sample.assembly_charge) > 0.75)
    warnings.push(`assembly charge ${sample.assembly_charge} is over the 0.75 ceiling`);
  if (n(sample.tag_cost) != null && n(sample.tag_cost) > 0.38)
    warnings.push(`ticket cost ${sample.tag_cost} is over the 0.38 ceiling`);
  if ((n(sample.metal_loss_percent) ?? 5) > 5)
    warnings.push(`metal loss ${sample.metal_loss_percent}% is over the 5% ceiling`);

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
    // Kevin, 2026-09-17: "for charms the option is always bail and add
    // in the description of what type of finding/bail it is" -- then,
    // "for the findings use the same info" -- generalized from
    // charms-only to any finding: append the finding's own description
    // (e.g. "CASTED BAIL", or "hidden / casted hinge / fixed" for an
    // earring hinge) whenever the finding has one, not just for charms.
    itemDescription:
      (s(sample.starting_description) || s(sample.name) || styleNumber) +
      (finding && s(sample.finding_description)
        ? ` - ${s(sample.finding_description)}`
        : ""),
    totalNetGramWeight: weight || 0.01,
    // SSP's item-create rejects this as a missing mandatory field when
    // null (confirmed 2026-08-26, product S188254: "Mandatory Fields are
    // missing" until this was populated) -- the PLM has no separate gross
    // weight, so default it to net weight (matches a real captured
    // payload where the two were equal) until stones/findings give it a
    // reason to diverge.
    totalGrossGramWeight: weight || 0.01,
    // Costing method belongs to the metal, not one global default (Chaim,
    // 2026-09-08): silver and gold lock, brass does not. A real brass
    // bracelet (S181911) came back "fixed no metal lock".
    costingMethod: s(sample.costing_method) || d.costingMethod,
    manufacturedCountryOfOrgin: s(d.countryOfOrigin).toUpperCase(), // (sic) — API misspells "Origin"
    // Declares which tabs the item has. This is what SSP's "Item indicates it
    // should have N components, but none were found" check reads, so it has to
    // match what actually gets sent -- listing Finding without sending one (or
    // sending one without listing it) is what produces that error.
    productComponent: [
      "Material",
      ...(finding ? ["Finding"] : []),
      ...(stones.length ? ["Stone"] : []),
    ],
    // Per type: rings are mandrel size, bracelets and necklaces inches,
    // everything else mm. This was hardcoded to "mandrel size" on every item
    // -- a real bracelet (S181911) uses "inches" with itemSize 8.
    unitOfMeasure: s(sample.unit_of_measure) || "mandrel size",
    // Kevin, 2026-09-17: bracelets and necklaces are inches, rings are
    // mandrel size, everything else mm. unitOfMeasure above already
    // reads the right label per category (category.unit_of_measure) --
    // this was the missing half: itemSize itself still sent the raw mm
    // number no matter what unit was declared. sample.length is always
    // stored in mm, so convert it to inches when the declared unit is
    // "inches".
    // Kevin, 2026-09-17: "send ring size as item size for rings" --
    // rings use their own ring_size field, not the raw length column
    // (which the form no longer collects for rings -- see Height below).
    itemSize:
      // Rings: Item Size = the length, Item Height = the ring size (the PLM has
      // no height field for rings), Item Width = the width; the ring size also
      // rides in Ring Size Minimum/Maximum -- Kevin, 2026-10-20. With no length,
      // Item Size falls back to the ring size like before.
      type.productType === "rings"
        ? String(nPositive(sample.length, ringSizeNum ?? 1))
        : s(sample.unit_of_measure).toLowerCase() === "inches"
          ? String(round2(nPositive(sample.length, 1) / 25.4))
          : String(nPositive(sample.length, 1)),
    itemHeight: ringHeightFromSize ? ringSizeNum : nPositive(sample.height, 1),
    itemWidth: nPositive(sample.width, 1),
    // Rings only -- starting_info.ring_size feeds min/max (both the same
    // value; Kevin, 2026-09-15: "ring size minimum and maximum is the new
    // ring size field value") and the sizeable increment is fixed at 0.25.
    // Non-ring items keep the old placeholder "1"/"1"/null.
    sizeableIncrement: type.productType === "rings" ? 0.25 : null,
    ringSizeMinimum: type.productType === "rings" ? String(n(sample.ring_size) ?? "1") : "1",
    ringSizeMaximum: type.productType === "rings" ? String(n(sample.ring_size) ?? "1") : "1",
    quantityType,
    setPiece: null,
    certificateType: [],
    certificationLab: [],
    // Kevin, 2026-09-17: supplierPack is always 1, not tied to
    // quantityType/piecesPerUnit anymore.
    supplierPack: 1,
    isTetheredToMetalLossMatrix: false,
    isTetheredToDiamondPricingMatrix: false,
    isTetheredToOvercostMatrix: false,
  };
  if (type.productType === "rings" && n(sample.ring_size) == null)
    warnings.push("no ring size set on this ring — ringSizeMinimum/Maximum sent as the 1 placeholder");

  // Material row — first pass from the sample's metal fields + live locks.
  const { purity } = purityFor(sample);
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
      // 925 silver item, not the "925 silver" string this used to send.
      // Gold's shape: send the millesimal fineness code -- same numbers
      // as metalPurity, e.g. 417 for 10K, 585 for 14K, 750 for 18K -- but
      // AS A STRING, not a number. CONFIRMED 2026-09-16 against a real
      // POST (T6-HOOP-test/S193992/item 1): metalKarat: 585 (number)
      // 400'd with an empty body every time; metalKarat: "585" (string)
      // succeeded immediately with the same everything-else payload. The
      // 2026-09-14 "send it numeric" note was wrong -- SSP's schema wants
      // metalPurity numeric but metalKarat as a string of the same digits.
      metalKarat: metalType === "silver" ? null : String(purity),
      metalAlloyColorNickelContents: [
        {
          key:
            PLM_COLOR_TO_SSP[s(sample.color).toLowerCase()] ||
            (metalType === "silver" ? "white" : "yellow"),
          value: NICKEL_CONTENT,
        },
      ],
      materialNetWeight: weight,
      metalBasePrice: basePrice,
      // Kevin, 2026-10-12: material fixing allowance is 1% too (same as the
      // finding): 1% of the lock price, e.g. base 65 -> 0.65.
      metalFixingAllowPercent: basePrice != null ? 1 : 0,
      metalFixingAllowAmt: basePrice != null ? round2(basePrice * 0.01) : null,
      metalLossPercent: base != null ? METAL_LOSS_PCT : null,
      metalLossAmt: lossAmt,
      metalCost: base != null ? round2(base + (lossAmt || 0)) : null,
      metalCostPerGram: ppg != null ? round2(ppg) : null,
      platings: platingEntries,
      isTetheredToMetalLossMatrix: false,
      isFixedNoMetalLock: item.costingMethod === "fixed no metal lock",
    };
  } else {
    warnings.push("not enough metal data (metalType/karat/weight) — no material row; add it in SKU Manager");
  }

  // piecesPerUnit rides along for the labor tab: noOfCastings and
  // noOfAssembly have to match the item's own piece count (a pair is 2
  // castings and 2 assemblies), and the real captured update-laborcost
  // payload confirms that shape.
  return {
    payloads: { header, item, material, finding, labor, vendorCost, stones, imageSourceUrls, piecesPerUnit },
    warnings,
  };
}

