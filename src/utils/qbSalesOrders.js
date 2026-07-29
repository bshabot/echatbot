// src/utils/qbSalesOrders.js
//
// Orchestrates the Purchase Orders page's QuickBooks buttons on top of qbClient:
//   - createSalesOrdersForPos: create a QB Sales Order per selected Signet PO,
//     skipping (and reporting) any that already exist ("error out if it exists"
//     handled per-PO so one duplicate never aborts the batch). The payload is
//     built from a configurable mapping (see qbMapping.js) instead of a fixed
//     shape — settings.options.qbIntegration.mappings.salesOrderCreate, a
//     plain "QB Field,Source" text block edited on the Settings page.
//   - syncMemosFromQb: pull the live memos view from the connector and write
//     memos onto matching POs — same effect as the xlsx memo upload, sourced
//     from QuickBooks directly. Also flags any PO number that doesn't show up
//     in that report AT ALL (not just "no memo") as possibly missing from QB.
//   - updateSalesOrdersForPos: push the current PLM PO data onto an SO that's
//     ALREADY in QuickBooks. Never creates one — POs with no SO yet are
//     skipped and reported so you can "Create in QB" first. Like create, the
//     payload is built from a configurable mapping (see qbMapping.js) —
//     settings.options.qbIntegration.mappings.salesOrderUpdate, the same
//     Field,Source DSL as create, against the update field vocabulary (no
//     Customer; adds "manually closed"). A caller can also pass
//     priceOverridesByPoId (sku_number -> new price) to send a freshly
//     recomputed price — e.g. the rebill calculator's price at a newly
//     chosen lock date — INSTEAD of whatever the mapping's Price source
//     resolves to for that line (see POLinesView.jsx's
//     handleUpdateThisSoInQb, the only current caller that passes this).
//
// Everything here is GATED through qbClient — no QuickBooks calls happen unless
// the integration is turned ON in Settings.

import {
  ensureSalesOrderCreated,
  ensureSalesOrderUpdated,
  fetchMemosReport,
  findSalesOrder,
  isQbEnabled,
} from "./qbClient";
import {
  buildSalesOrderCreatePayloadFromMapping,
  buildSalesOrderUpdatePayloadFromMapping,
  getSoCreateMappingText,
  getSoUpdateMappingText,
} from "./qbMapping";

/**
 * Create QB Sales Orders for the given PO rows. Fetches each PO's line items
 * from running_line_po_items (including vendor_style_number + raw_data, so
 * the mapping's line-level sources — "Manufacturer's Model #", any raw
 * Signet export column — have something to resolve against), builds the
 * payload from the configured Sales-Order-Create mapping, then calls
 * ensureSalesOrderCreated per PO. Never throws for a single PO — existing
 * and failed rows are collected so the whole batch finishes.
 *
 * Returns { enabled, created[], existed[], failed[], total } where each entry
 * is { po } (and failed entries also carry { error }).
 */
export async function createSalesOrdersForPos(pos, { supabase, settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, created: [], existed: [], failed: [], total: 0 };
  }
  const created = [];
  const existed = [];
  const failed = [];
  const list = pos || [];
  const mappingText = getSoCreateMappingText(settings);

  for (let i = 0; i < list.length; i++) {
    const po = list[i];
    const label = po.po_number || (po.id ? String(po.id).slice(0, 8) : "?");
    try {
      let lines = [];
      if (supabase && po.id) {
        const { data, error } = await supabase
          .from("running_line_po_items")
          .select("line_number,sku_number,vendor_style_number,description,quantity,unit_price,raw_data")
          .eq("po_id", po.id);
        if (error) throw error;
        lines = data || [];
      }
      const { payload, unrecognizedFields } = buildSalesOrderCreatePayloadFromMapping(
        po,
        lines,
        mappingText
      );
      if (unrecognizedFields.length) {
        throw new Error(
          `Mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")}`
        );
      }
      const res = await ensureSalesOrderCreated(payload, { settings });
      if (res.created) created.push({ po: label });
      else if (res.existed) existed.push({ po: label });
      else failed.push({ po: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, created, existed, failed, total: list.length };
}

/**
 * Pull the live memos view from the connector and write memos onto matching
 * running_line_purchase_orders (matched by po_number). Mirrors the page's
 * handleMemoUpload parse, but sourced from QuickBooks instead of an xlsx.
 * Never clears a memo (blank memos are ignored), matching Brian's rule.
 *
 * `poNumbers` (optional): every PO number the caller wants checked against
 * the report. Any of those NOT present in the report at all (regardless of
 * whether it has a memo) comes back in `notFound` — that's the "possibly not
 * in QB" signal, distinct from "in QB but no memo yet".
 *
 * Returns { enabled, updated, seen, pairs, today, notFound }.
 */
export async function syncMemosFromQb({ supabase, settings, poNumbers = [] } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: 0, seen: 0, pairs: [], today: null, notFound: [] };
  }
  const { rows } = await fetchMemosReport({ settings });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const pairs = [];
  const seenPoNumbers = new Set();
  for (const r of rows || []) {
    const numRaw = r?.Num ?? r?.num;
    const memoRaw = r?.Memo ?? r?.memo;
    if (numRaw == null) continue;
    const m = String(numRaw).trim().match(/^(\d{4,})/);
    if (!m) continue;
    seenPoNumbers.add(m[1]);
    const memo = memoRaw == null ? "" : String(memoRaw).trim();
    if (!memo) continue; // never clear a memo
    pairs.push({ po: m[1], memo });
  }

  let updated = 0;
  if (supabase) {
    for (const { po, memo } of pairs) {
      const { data, error } = await supabase
        .from("running_line_purchase_orders")
        .update({ memo, memo_updated_at: today })
        .eq("po_number", po)
        .select("id");
      if (!error && data?.length) updated++;
    }
  }

  const notFound = (poNumbers || [])
    .map((p) => String(p ?? "").trim())
    .filter((p) => p && !seenPoNumbers.has(p));

  return { enabled: true, updated, seen: pairs.length, pairs, today, notFound };
}

/**
 * Push current PLM data onto each selected PO's EXISTING QB Sales Order,
 * built from the configured Sales-Order-Update mapping (same mechanism as
 * createSalesOrdersForPos — see qbMapping.js). POs with no SO in QB yet are
 * skipped and reported — this never creates one (use createSalesOrdersForPos
 * / the "Create in QB" button for that). Never throws for a single PO — one
 * failure doesn't abort the batch.
 *
 * `priceOverridesByPoId` (optional): Map of po.id -> Map(sku_number -> new
 * price). Lets a caller that already has newly-computed per-line prices
 * (e.g. POLinesView's rebill calculator at a newly chosen lock date) push
 * THOSE instead of whatever the mapping's Price source resolves to for that
 * line, without changing behavior for callers that don't pass it (they get
 * whatever the mapping resolves, same as create).
 *
 * Returns { enabled, updated[], notFound[], failed[], total }.
 */
export async function updateSalesOrdersForPos(pos, { supabase, settings, onProgress, priceOverridesByPoId } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], notFound: [], failed: [], total: 0 };
  }
  const updated = [];
  const notFound = [];
  const failed = [];
  const list = pos || [];
  const mappingText = getSoUpdateMappingText(settings);

  for (let i = 0; i < list.length; i++) {
    const po = list[i];
    const label = po.po_number || (po.id ? String(po.id).slice(0, 8) : "?");
    try {
      if (!po.po_number) throw new Error("PO has no PO number");
      const existingSo = await findSalesOrder(po.po_number);
      if (!existingSo) {
        notFound.push({ po: label });
        continue;
      }
      let lines = [];
      if (supabase && po.id) {
        const { data, error } = await supabase
          .from("running_line_po_items")
          .select("line_number,sku_number,vendor_style_number,description,quantity,unit_price,raw_data")
          .eq("po_id", po.id);
        if (error) throw error;
        lines = data || [];
      }
      // The metal lock the price was computed at, so the mapping can stamp it
      // onto the line (default: Other1 = Silver Lock Date). Keyed on the PO's
      // chosen lock_date — POLinesView saves that before pushing, so this
      // reads the lock the new price actually came from. Best-effort: a
      // missing row just leaves the rate sources empty and the date falling
      // back to po.lock_date.
      let lockInfo = null;
      if (supabase && po.lock_date) {
        const { data } = await supabase
          .from("metal_lock_history")
          .select("date,silver_lock,gold_lock")
          .eq("date", po.lock_date)
          .maybeSingle();
        lockInfo = data || { date: po.lock_date };
      }
      const priceOverrides = priceOverridesByPoId?.get(po.id);
      const { payload, unrecognizedFields, matchReport, addedCount, orphanQbLines } =
        buildSalesOrderUpdatePayloadFromMapping(
          po,
          lines,
          existingSo,
          mappingText,
          priceOverrides,
          lockInfo
        );
      if (unrecognizedFields.length) {
        throw new Error(
          `Mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")}`
        );
      }
      const res = await ensureSalesOrderUpdated(po.po_number, payload, { settings });
      // repriced = lines whose rate actually moved, so the caller can say
      // "2 lines repriced" instead of a bare "updated" (and so a surprise
      // add_lines count is visible rather than silently duplicating the SO).
      const repriced = (matchReport || []).filter(
        (m) => m.newRate != null && String(m.oldRate) !== String(m.newRate)
      ).length;
      if (res.updated) {
        updated.push({
          po: label,
          matched: matchReport?.length || 0,
          repriced,
          added: addedCount || 0,
          lines: matchReport || [],
          orphans: orphanQbLines || [],
        });
      } else if (res.notFound) notFound.push({ po: label });
      else failed.push({ po: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, notFound, failed, total: list.length };
}
