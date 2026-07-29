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
//     ALREADY in QuickBooks (due date, ship date, memo, po_number, and line
//     qty/rate/description changes). Never creates one — POs with no SO yet
//     are skipped and reported so you can "Create in QB" first. Still uses
//     the older fixed-shape builder below (poToSalesOrderUpdatePayload) — not
//     yet moved onto the mapping mechanism.
//
// Everything here is GATED through qbClient — no QuickBooks calls happen unless
// the integration is turned ON in Settings.

import {
  ensureSalesOrderCreated,
  ensureSalesOrderUpdated,
  fetchMemosReport,
  findSalesOrder,
  isQbEnabled,
  toQbAmount,
} from "./qbClient";
import {
  buildSalesOrderCreatePayloadFromMapping,
  getSoCreateMappingText,
} from "./qbMapping";

function toStr(v) {
  return v == null || v === "" ? undefined : String(v);
}

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
 * Build a SalesOrderUpdate payload (header + line reconciliation) from a PLM
 * PO row, its current line items, and the SO QuickBooks already has on file
 * (from findSalesOrder — needed to map PLM lines onto QB's txn_line_id).
 *
 * Existing QB lines are matched to PLM lines by `other1`, which is stamped
 * with the SKU number at creation time (see buildSalesOrderCreatePayloadFromMapping
 * in qbMapping.js, which falls back to the SKU for other1 when the mapping
 * doesn't set it) — a match becomes a line update (qty/rate/description); a
 * PLM line with no match on the SO (added since it was created) is appended
 * via add_lines. Lines that exist on the QB side only are left alone — this
 * never deletes a line.
 *
 * `priceOverrides` (optional): Map of sku_number -> new unit price. When a
 * line's SKU has an entry, that price is sent as `rate` INSTEAD OF the
 * line's stored `unit_price` — this is how a re-lock's newly computed price
 * (e.g. POLinesView's rebill calculator, at whatever lock date is chosen)
 * gets pushed to QB rather than the stale stored price. Lines with no
 * override fall back to the stored unit_price, unchanged.
 */
export function poToSalesOrderUpdatePayload(po, lines = [], existingSo, priceOverrides) {
  const existingLines = existingSo?.lines || [];
  const bySku = new Map(
    existingLines.filter((l) => l && l.other1).map((l) => [String(l.other1), l])
  );

  const lineUpdates = [];
  const addLines = [];
  for (const l of lines || []) {
    if (!l || !l.sku_number) continue;
    const sku = String(l.sku_number);
    const overridePrice = priceOverrides?.get(sku);
    const rate = overridePrice != null ? overridePrice : l.unit_price;
    const shared = {
      item: sku,
      description: toStr(l.description),
      quantity: l.quantity != null ? String(l.quantity) : undefined,
      rate: toQbAmount(rate),
      other1: sku,
    };
    const match = bySku.get(sku);
    if (match?.txn_line_id) {
      lineUpdates.push({ txn_line_id: match.txn_line_id, ...shared });
    } else {
      addLines.push(shared);
    }
  }

  return {
    po_number: toStr(po.po_number),
    due_date: toStr(po.due_date),
    ship_date: toStr(po.ship_date),
    memo: toStr(po.memo),
    lines: lineUpdates,
    add_lines: addLines,
  };
}

/**
 * Push current PLM data (due date, ship date, memo, po_number, and any line
 * qty/rate/description changes) onto each selected PO's EXISTING QB Sales
 * Order. POs with no SO in QB yet are skipped and reported — this never
 * creates one (use createSalesOrdersForPos / the "Create in QB" button for
 * that). Never throws for a single PO — one failure doesn't abort the batch.
 *
 * `priceOverridesByPoId` (optional): Map of po.id -> Map(sku_number -> new
 * price). Lets a caller that already has newly-computed per-line prices
 * (e.g. a rebill at a newly chosen lock date) push THOSE instead of the
 * stored unit_price, without changing behavior for callers that don't pass
 * it (they keep sending the stored price, same as before).
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
          .select("line_number,sku_number,description,quantity,unit_price")
          .eq("po_id", po.id);
        if (error) throw error;
        lines = data || [];
      }
      const priceOverrides = priceOverridesByPoId?.get(po.id);
      const payload = poToSalesOrderUpdatePayload(po, lines, existingSo, priceOverrides);
      const res = await ensureSalesOrderUpdated(po.po_number, payload, { settings });
      if (res.updated) updated.push({ po: label });
      else if (res.notFound) notFound.push({ po: label });
      else failed.push({ po: label, error: res.reason || "skipped" });
    } catch (e) {
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, notFound, failed, total: list.length };
}
