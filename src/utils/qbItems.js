// src/utils/qbItems.js
//
// Orchestrates the Samples page's QuickBooks buttons on top of qbClient.
// Each sample (styleNumber = the catalog's unique key) maps to a QB Item:
//   name (FullName)            = styleNumber — QB's hard 31-char limit; a
//                                 style number that doesn't fit is reported
//                                 as a failure rather than silently truncated
//   description                = starting_description (house-style text),
//                                 falling back to the sample's name
//   cost                       = totalCost (metal + labor + misc + stones)
//   manufacturer_part_number   = manufacturerCode
// `price` is intentionally left unset — samples don't carry a wholesale or
// retail number yet; set it in QuickBooks once one exists.
//
//   - createItemsForSamples / updateItemsForSamples: the Samples list's
//     multi-select "Create in QB" / "Update in QB" buttons (batch, mirrors
//     the Purchase Orders page's createSalesOrdersForPos / updateSalesOrdersForPos).
//   - syncItemForSample: the single-sample detail modal's one button —
//     creates the item if it's missing, updates it if it's already there.
//
// Everything here is GATED through qbClient — no QuickBooks calls happen
// unless the integration is turned ON in Settings.

import {
  ensureItemExists,
  ensureItemSynced,
  ensureItemUpdated,
  isQbEnabled,
} from "./qbClient";

const QB_NAME_MAX = 31;

function toStr(v) {
  return v == null || v === "" ? undefined : String(v);
}

function styleNumberFor(sample) {
  return String(sample?.styleNumber || "").trim();
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

/** Build the ItemCreate-shape payload (qbClient.createItem / ensureItemExists). */
export function sampleToItemCreatePayload(sample) {
  return {
    name: styleNumberFor(sample),
    description: toStr(sample?.starting_description || sample?.name),
    cost: sample?.totalCost != null ? String(sample.totalCost) : undefined,
    manufacturer_part_number: toStr(sample?.manufacturerCode),
  };
}

/** Build the ItemUpdate-shape payload (qbClient.updateItem / ensureItemUpdated). */
export function sampleToItemUpdatePayload(sample) {
  return {
    description: toStr(sample?.starting_description || sample?.name),
    cost: sample?.totalCost != null ? String(sample.totalCost) : undefined,
    manufacturer_part_number: toStr(sample?.manufacturerCode),
  };
}

/**
 * Create a QB Item for each selected sample. Existing items are skipped and
 * reported (never overwritten — use updateItemsForSamples for changes to an
 * item that's already there). One bad/failed sample never aborts the rest.
 *
 * Returns { enabled, created[], existed[], failed[], total }.
 */
export async function createItemsForSamples(samples, { settings, onProgress } = {}) {
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
      const payload = sampleToItemCreatePayload(sample);
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
 * selected sample's EXISTING QB Item. Samples with no item in QB yet are
 * skipped and reported — this never creates one (use createItemsForSamples /
 * the "Create in QB" button for that first).
 *
 * Returns { enabled, updated[], notFound[], failed[], total }.
 */
export async function updateItemsForSamples(samples, { settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], notFound: [], failed: [], total: 0 };
  }
  const updated = [];
  const notFound = [];
  const failed = [];
  const list = samples || [];

  for (let i = 0; i < list.length; i++) {
    const sample = list[i];
    const label = sample.styleNumber || sample.sample_id || "?";
    try {
      const problem = styleNumberProblem(sample);
      if (problem) throw new Error(problem);
      const payload = sampleToItemUpdatePayload(sample);
      const res = await ensureItemUpdated(styleNumberFor(sample), payload, { settings });
      if (res.updated) updated.push({ sample: label });
      else if (res.notFound) notFound.push({ sample: label });
      else failed.push({ sample: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ sample: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, notFound, failed, total: list.length };
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
export async function syncItemForSample(sample, { settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  const problem = styleNumberProblem(sample);
  if (problem) throw new Error(problem);
  const payload = sampleToItemCreatePayload(sample);
  return ensureItemSynced(payload, { settings });
}
