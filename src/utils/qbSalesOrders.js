// src/utils/qbSalesOrders.js
//
// Orchestrates the Sales Orders page's QuickBooks buttons on top of qbClient:
//   - createSalesOrdersForPos: create a QB Sales Order per selected Signet PO,
//     skipping (and reporting) any that already exist ("error out if it exists"
//     handled per-PO so one duplicate never aborts the batch).
//   - syncMemosFromQb: pull the live memos view from the connector and write
//     memos onto matching POs — same effect as the xlsx memo upload, sourced
//     from QuickBooks directly.
//
// Everything here is GATED through qbClient — no QuickBooks calls happen unless
// the integration is turned ON in Settings.

import {
  ensureSalesOrderCreated,
  fetchMemosReport,
  isQbEnabled,
  QB_SALES_ORDER_CUSTOMER,
} from "./qbClient";

function toStr(v) {
  return v == null || v === "" ? undefined : String(v);
}

/**
 * Build a connector SalesOrderCreate payload from a PLM PO row + its line
 * items. ref_number = the Signet PO number, so the existence check
 * (GET /sales-orders/{ref}) is a clean "already there?" test.
 */
export function poToSalesOrderPayload(po, lines = []) {
  return {
    customer: QB_SALES_ORDER_CUSTOMER,
    ref_number: toStr(po.po_number),
    po_number: toStr(po.po_number),
    txn_date: toStr(po.po_date),
    ship_date: toStr(po.ship_date),
    due_date: toStr(po.due_date),
    memo: toStr(po.memo),
    lines: (lines || [])
      .slice()
      .sort((a, b) => (a.line_number || 0) - (b.line_number || 0))
      .filter((l) => l && l.sku_number)
      .map((l) => ({
        item: String(l.sku_number),
        description: toStr(l.description),
        quantity: l.quantity != null ? String(l.quantity) : undefined,
        rate: l.unit_price != null ? String(l.unit_price) : undefined,
        other1: String(l.sku_number),
      })),
  };
}

/**
 * Create QB Sales Orders for the given PO rows. Fetches each PO's line items
 * from running_line_po_items, builds the payload, then calls
 * ensureSalesOrderCreated per PO. Never throws for a single PO — existing and
 * failed rows are collected so the whole batch finishes.
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

  for (let i = 0; i < list.length; i++) {
    const po = list[i];
    const label = po.po_number || (po.id ? String(po.id).slice(0, 8) : "?");
    try {
      let lines = [];
      if (supabase && po.id) {
        const { data, error } = await supabase
          .from("running_line_po_items")
          .select("line_number,sku_number,description,quantity,unit_price")
          .eq("po_id", po.id);
        if (error) throw error;
        lines = data || [];
      }
      const payload = poToSalesOrderPayload(po, lines);
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
 * Returns { enabled, updated, seen, pairs, today }.
 */
export async function syncMemosFromQb({ supabase, settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: 0, seen: 0, pairs: [], today: null };
  }
  const { rows } = await fetchMemosReport({ settings });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const pairs = [];
  for (const r of rows || []) {
    const numRaw = r?.Num ?? r?.num;
    const memoRaw = r?.Memo ?? r?.memo;
    if (numRaw == null) continue;
    const m = String(numRaw).trim().match(/^(\d{4,})/);
    if (!m) continue;
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

  return { enabled: true, updated, seen: pairs.length, pairs, today };
}
