// src/utils/qbItems.js
//
// Orchestrates the Samples page's QuickBooks buttons on top of qbClient.
// Each sample (styleNumber = the catalog's unique key) maps to a QB Item:
//   name (FullName) = styleNumber, always — QB's hard 31-char limit; a style
//     number that doesn't fit is reported as a failure rather than silently
//     truncated. This one is NOT configurable: styleNumber is the exact
//     value every find/update/exists-check uses to locate the item in QB, so
//     letting it come from a different field would break the "does this
//     already exist" lookup everywhere else in this file.
//   description / cost / price / manufacturer_part_number = configurable —
//     see ITEM FIELD MAPPING below.
//
// ── ITEM FIELD MAPPING ─────────────────────────────────────────────────────
// Which PLM data field feeds each of those four QB Item fields is a setting,
// not a hardcode: settings.options.qbIntegration.itemFieldMapping, e.g.
//   { description: "starting_description", cost: "totalCost",
//     price: "", manufacturer_part_number: "manufacturerCode" }
// — edited on the Settings page (QuickBooks section). getItemFieldMapping()
// merges whatever's configured over DEFAULT_ITEM_FIELD_MAPPING, so a blank/
// missing setting just falls back to the original hardcoded behavior.
// MAPPABLE_SAMPLE_FIELDS is the curated list of source fields the Settings
// UI offers — it's exported so that dropdown reads from the same list this
// file actually understands, instead of drifting out of sync.
//
// ── ITEM DEFAULTS (create-time only) ───────────────────────────────────────
// item_type + the four QB accounts (account/expense_account/cogs_account/
// asset_account) aren't sourced from PLM data at all — there's nothing on a
// sample to map an account name from — so they're a flat, global setting:
// settings.options.qbIntegration.itemDefaults, merged over
// DEFAULT_ITEM_DEFAULTS by getItemDefaults(). These only ever apply on
// CREATE: QuickBooks' ItemUpdate has no item_type/account fields, so once an
// item exists its type/accounts aren't touched again from here.
//
// Two different shapes of "a sample" reach this file: the flat
// sample_with_stones_export row the Samples list's batch buttons fetch, and
// the live { formData, starting_info } edit state the single-sample modal
// already has in memory. normalizeSampleForQb() reconciles both into one
// consistent record (matching the flat shape's key names) before mapping
// or the styleNumber/31-char check ever runs, so the same field name in
// the Settings dropdown resolves correctly no matter which button fired.
//
//   - createItemsForSamples: the Samples list's multi-select "Create in QB"
//     button — creates an item per selected sample, skipping (and reporting)
//     any that already exist.
//   - updateItemsForSamples: the Samples list's multi-select "Update in QB"
//     button — pushes current PLM data onto each selected sample's QB Item,
//     creating it first if it isn't there yet (never just reports a miss).
//   - syncItemForSample: the single-sample detail modal's one button —
//     creates the item if it's missing, updates it if it's already there.
//   - updateItemPricesForRows: the Factory Costs page's "Update prices in QB"
//     button — pushes that page's computed per-unit factory charge onto each
//     item's `price` field (matched by style number), creating a bare-bones
//     item first if none exists yet under that style number.
//
// Item flows (this file) create-when-missing throughout — unlike the Sales
// Order flows in qbSalesOrders.js, which stay strictly update-only by design
// (a missing SO is reported, never auto-created).
//
// Everything here is GATED through qbClient — no QuickBooks calls happen
// unless the integration is turned ON in Settings.

import {
  ensureItemExists,
  ensureItemSynced,
  isQbEnabled,
  toQbAmount,
} from "./qbClient";
import {
  buildItemPayloadFromMapping,
  getItemCreateMappingText,
  getItemUpdateMappingText,
} from "./qbMapping";

const QB_NAME_MAX = 31;

function toStr(v) {
  return v == null || v === "" ? undefined : String(v);
}

// The QB Item fields that are actually configurable (name/FullName stays
// fixed to styleNumber — see the file header). A blank/unset entry means
// "don't send this field" (matches the old hardcoded-off behavior for price).
export const DEFAULT_ITEM_FIELD_MAPPING = {
  description: "starting_description",
  cost: "totalCost",
  price: "",
  manufacturer_part_number: "manufacturerCode",
};

// Curated source fields the Settings page's mapping dropdowns offer — kept
// here (not duplicated in the UI) so the options always match what
// normalizeSampleForQb() actually populates. Excludes ids, timestamps, and
// array/jsonb columns (images, cad, stones) that can't sensibly become a
// single QB text/number field.
export const MAPPABLE_SAMPLE_FIELDS = [
  { value: "starting_description", label: "Description (house style)" },
  { value: "name", label: "Sample name" },
  { value: "notes", label: "Notes" },
  { value: "manufacturerCode", label: "Manufacturer code" },
  { value: "vendorName", label: "Vendor name (for preferred vendor)" },
  { value: "totalCost", label: "Total cost (metal + labor + misc + stones)" },
  { value: "laborCost", label: "Labor cost" },
  { value: "miscCost", label: "Misc cost" },
  { value: "platingCharge", label: "Plating charge" },
  { value: "necklaceCost", label: "Necklace cost" },
  { value: "karat", label: "Karat" },
  { value: "metalType", label: "Metal type" },
  { value: "color", label: "Metal color" },
  { value: "weight", label: "Weight (g)" },
  { value: "length", label: "Length (mm)" },
  { value: "width", label: "Width (mm)" },
  { value: "height", label: "Height (mm)" },
  { value: "salesWeight", label: "Sales weight" },
  { value: "selling_pair", label: "Selling pair (single/pair/set)" },
  { value: "back_type", label: "Back type" },
  { value: "custom_back_type", label: "Custom back type" },
  { value: "back_type_quantity", label: "Back type quantity" },
  { value: "sample_status", label: "Status" },
  { value: "styleNumber", label: "Style number" },
];

/** The effective mapping: whatever's configured, over the defaults. */
export function getItemFieldMapping(settings) {
  const configured = settings?.options?.qbIntegration?.itemFieldMapping || {};
  return { ...DEFAULT_ITEM_FIELD_MAPPING, ...configured };
}

// Item-level config that's the SAME for every item created — not sourced
// from PLM data at all (there's nothing on a sample to map account names
// from), so this is separate from DEFAULT_ITEM_FIELD_MAPPING above. Only
// used on CREATE: QuickBooks' own ItemUpdate has no item_type/account fields
// at all, so none of this applies once an item already exists — you can't
// change an item's type or accounts after the fact through this connector
// (or QuickBooks itself, for most type changes).
//
// item_type: "Inventory" (QB tracks quantity on hand) requires account +
// cogs_account + asset_account to already exist in the company file's chart
// of accounts (exact FullName match) — expense_account is ignored for
// Inventory items; it only applies to NonInventory/Service items you want
// two-sided (given both an income and an expense account).
export const DEFAULT_ITEM_DEFAULTS = {
  item_type: "Inventory",
  account: "Sales",
  expense_account: "",
  cogs_account: "Cost of Goods Sold",
  asset_account: "Inventory Asset",
};

export const QB_ITEM_TYPES = ["Inventory", "NonInventory", "Service"];

/** The effective item-create defaults: whatever's configured, over these. */
export function getItemDefaults(settings) {
  const configured = settings?.options?.qbIntegration?.itemDefaults || {};
  return { ...DEFAULT_ITEM_DEFAULTS, ...configured };
}

/**
 * Reconcile the two shapes "a sample" arrives in here into one record with
 * consistent key names (matching sample_with_stones_export, since that's
 * the richer of the two and what MAPPABLE_SAMPLE_FIELDS is written against):
 *   - the flat view row the Samples list's batch buttons already fetch
 *     (has styleNumber at the top level) — used as-is.
 *   - { formData, starting_info }, the single-sample modal's live edit
 *     state (styleNumber lives on formData, most everything else on
 *     starting_info) — flattened onto the same key names.
 */
function normalizeSampleForQb(input) {
  if (!input) return {};
  if ("styleNumber" in input) return input; // already flat
  const fd = input.formData || {};
  const si = input.starting_info || {};
  return {
    styleNumber: fd.styleNumber,
    name: fd.name,
    notes: fd.notes,
    sample_status: fd.status,
    salesWeight: fd.salesWeight,
    selling_pair: fd.selling_pair,
    back_type: fd.back_type,
    custom_back_type: fd.custom_back_type,
    back_type_quantity: fd.back_type_quantity,
    vendor: si.vendor,
    manufacturerCode: si.manufacturerCode,
    starting_description: si.description,
    karat: si.karat,
    metalType: si.metalType,
    color: si.color,
    platingCharge: si.platingCharge,
    length: si.length,
    width: si.width,
    height: si.height,
    weight: si.weight,
    miscCost: si.miscCost,
    laborCost: si.laborCost,
    totalCost: si.totalCost,
    necklace: si.necklace,
    necklaceCost: si.necklaceCost,
  };
}

/**
 * Resolve starting_info.vendor (an integer FK into `vendors`) to the vendor's
 * NAME, exposed as `vendorName` for the mapping's Preferred Vendor source.
 *
 * QuickBooks addresses a preferred vendor by exact name and rejects one it
 * doesn't recognise — and that rejection fails the ENTIRE item write, not just
 * the vendor field. So an id with no match resolves to nothing and the field
 * is simply omitted, rather than sending a number QuickBooks would choke on.
 *
 * `vendors` is the app's already-loaded vendor list (getEntity("vendors")).
 * Callers that don't have one (e.g. Factory Costs, which works from a model
 * and a price rather than a sample) just don't set a preferred vendor.
 */
function attachVendorName(rec, vendors) {
  if (!rec || rec.vendorName) return rec;
  const id = rec.vendor;
  if (id == null || id === "") return rec;
  const list = Array.isArray(vendors) ? vendors : [];
  const hit = list.find((v) => String(v?.id) === String(id));
  if (!hit?.name) {
    // Silence here is what makes "the vendor just isn't syncing" so hard to
    // read: the payload is otherwise perfect, minus one field. Say why.
    console.warn(
      `[QB] no preferred vendor sent for ${rec.styleNumber || "(no style)"}: ` +
        `vendor id ${id} ` +
        (list.length
          ? `is not in the loaded vendor list (${list.length} vendors)`
          : "— the vendor list is empty/not loaded, so no id can resolve")
    );
    return rec;
  }
  return { ...rec, vendorName: hit.name };
}

function styleNumberFor(sample) {
  const rec = normalizeSampleForQb(sample);
  return String(rec?.styleNumber || "").trim();
}

// null = OK; otherwise a human-readable reason this sample can't go to QB.
function styleNumberProblem(sample) {
  const name = styleNumberFor(sample);
  if (!name) return "no style number";
  if (name.length > QB_NAME_MAX) {
    return `style number is ${name.length} chars, over QuickBooks' ${QB_NAME_MAX}-char limit`;
  }
  return null;
}

/**
 * Build the ItemCreate-shape payload (qbClient.createItem / ensureItemExists)
 * from the configured Item Create mapping — settings.options.qbIntegration
 * .mappings.itemCreate, the same "QB Field,Source" text block as the sales
 * order mappings (see qbMapping.js). `name` is always the style number, set
 * here rather than by the mapping, because every lookup addresses the item
 * by it.
 *
 * Throws on an unrecognized field name so a typo surfaces instead of silently
 * dropping a field; batch callers catch per sample.
 */
export function sampleToItemCreatePayload(sample, settings, vendors) {
  const rec = attachVendorName(normalizeSampleForQb(sample), vendors);
  const { payload, unrecognizedFields } = buildItemPayloadFromMapping(
    rec,
    getItemCreateMappingText(settings),
    { mode: "create" }
  );
  if (unrecognizedFields.length) {
    throw new Error(
      `Item create mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")}`
    );
  }
  return {
    name: styleNumberFor(rec),
    ...payload,
    // Fall back to the sample's own name only when the mapping resolved
    // nothing — an item with no description at all reads as blank in QB.
    description: payload.description ?? toStr(rec?.name),
  };
}

/**
 * Build the ItemUpdate-shape payload (qbClient.updateItem / ensureItemUpdated)
 * from the configured Item Update mapping. Note this schema accepts NO
 * item_type and NO account fields — those are create-time only, so an
 * existing item's type and accounts are never changed by a sync.
 */
export function sampleToItemUpdatePayload(sample, settings, vendors) {
  const rec = attachVendorName(normalizeSampleForQb(sample), vendors);
  const { payload, unrecognizedFields } = buildItemPayloadFromMapping(
    rec,
    getItemUpdateMappingText(settings),
    { mode: "update" }
  );
  if (unrecognizedFields.length) {
    throw new Error(
      `Item update mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")}`
    );
  }
  return payload;
}

/**
 * Create a QB Item for each selected sample. Existing items are skipped and
 * reported (never overwritten — use updateItemsForSamples for changes to an
 * item that's already there). One bad/failed sample never aborts the rest.
 *
 * Returns { enabled, created[], existed[], failed[], total }.
 */
export async function createItemsForSamples(samples, { settings, onProgress, vendors } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, created: [], existed: [], failed: [], total: 0 };
  }
  const created = [];
  const existed = [];
  const failed = [];
  const list = samples || [];

  for (let i = 0; i < list.length; i++) {
    const sample = list[i];
    const label = sample.styleNumber || sample.sample_id || "?";
    try {
      const problem = styleNumberProblem(sample);
      if (problem) throw new Error(problem);
      const payload = sampleToItemCreatePayload(sample, settings, vendors);
      console.info("[QB] POST /items " + payload.name, payload);
      const res = await ensureItemExists(payload, { settings });
      if (res.created) created.push({ sample: label });
      else if (res.existed) existed.push({ sample: label });
      else failed.push({ sample: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ sample: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, created, existed, failed, total: list.length };
}

/**
 * Push current PLM data (description, cost, manufacturer code) onto each
 * selected sample's QB Item — updating it if it's already there, or
 * creating it (same as the single-sample "Sync to QB" action) if it isn't.
 * Never just reports a miss and skips: every selected sample ends up synced
 * one way or the other, short of an actual error (bad style number, QB
 * rejection, etc.), which still lands in `failed`.
 *
 * Returns { enabled, updated[], created[], failed[], total }.
 */
export async function updateItemsForSamples(samples, { settings, onProgress, vendors } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], created: [], failed: [], total: 0 };
  }
  const updated = [];
  const created = [];
  const failed = [];
  const list = samples || [];

  for (let i = 0; i < list.length; i++) {
    const sample = list[i];
    const label = sample.styleNumber || sample.sample_id || "?";
    try {
      const problem = styleNumberProblem(sample);
      if (problem) throw new Error(problem);
      // ensureItemSynced updates the existing item when found, or creates it
      // when it isn't — sampleToItemCreatePayload has every field either
      // path needs (name + description/cost/manufacturer_part_number).
      const payload = sampleToItemCreatePayload(sample, settings, vendors);
      console.info("[QB] sync item " + payload.name, payload);
      const res = await ensureItemSynced(payload, { settings });
      if (res.updated) updated.push({ sample: label });
      else if (res.created) created.push({ sample: label });
      else failed.push({ sample: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ sample: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, created, failed, total: list.length };
}

/**
 * Single-sample "sync" for the detail modal's one button: creates the item
 * if it's missing in QuickBooks, or updates it if it's already there — the
 * caller doesn't need to know which state it's in first. GATED.
 *
 * Returns { skipped: true, reason } | { created: true, item } | { updated: true, item }.
 * Throws if the style number can't go to QB at all (missing / over 31 chars)
 * so the caller can show that as an error rather than a silent no-op.
 */
export async function syncItemForSample(sample, { settings, vendors } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  const problem = styleNumberProblem(sample);
  if (problem) throw new Error(problem);
  const payload = sampleToItemCreatePayload(sample, settings, vendors);
  console.info("[QB] sync item " + payload.name, payload);
  return ensureItemSynced(payload, { settings });
}

/**
 * Push a computed factory-cost unit price onto each row's QB Item, matched
 * by style number. Built for the Factory Costs page's "Update prices in QB"
 * button: each row there is `{ model, unit, ... }` — `model` is the style
 * number (QB's item FullName), `unit` is that page's computed per-piece
 * factory charge. Rows with no computed unit cost (no sample matched, or
 * still loading) or no style number are skipped before ever calling QB.
 *
 * Updates the item's price if it's already in QB; if there's no item under
 * that style number yet, creates a bare-bones one (name + price) instead of
 * just reporting a miss — same "never just error out" behavior as
 * updateItemsForSamples. A minimal create still satisfies QuickBooks (only
 * `name` is required); richer fields (description, manufacturer code) get
 * filled in whenever the Samples page's Create/Update in QB runs for it.
 *
 * Returns { enabled, updated[], created[], failed[], total }.
 */
export async function updateItemPricesForRows(rows, { settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], created: [], failed: [], total: 0 };
  }
  const updated = [];
  const created = [];
  const failed = [];
  const list = (rows || []).filter((r) => r && r.unit != null && r.model);

  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const label = r.model;
    try {
      const problem = styleNumberProblem({ styleNumber: r.model });
      if (problem) throw new Error(problem);
      // Include the configured item-create defaults (item_type/accounts) so
      // a bare-bones create here still respects e.g. Inventory + your real
      // chart-of-accounts names, instead of falling back to the connector's
      // own defaults (NonInventory/"Sales"/"Cost of Goods Sold"/"Inventory
      // Asset") — same accounts this page's item would get if it had been
      // created from the Samples page instead.
      // This page has a model + a unit price, not a sample — so the create
      // side reuses ONLY the mapping's Static: values (item type, accounts).
      // Data-sourced rows resolve to nothing against an empty record and drop
      // out, which is what we want: no description or cost invented here.
      const { payload: mappedDefaults } = buildItemPayloadFromMapping(
        {},
        getItemCreateMappingText(settings),
        { mode: "create" }
      );
      const res = await ensureItemSynced(
        {
          ...mappedDefaults,
          name: r.model,
          price: toQbAmount(r.unit),
        },
        { settings }
      );
      if (res.updated) updated.push({ item: label });
      else if (res.created) created.push({ item: label });
      else failed.push({ item: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ item: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, created, failed, total: list.length };
}
