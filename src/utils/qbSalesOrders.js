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
  SO_UPDATE_HEADER_FIELD_KEYS,
  SO_UPDATE_LINE_FIELD_KEYS,
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
 * Flatten a built payload's header fields into [{ field, label, value }] for
 * display. Used by the create preview, where there's nothing to diff against
 * — the sales order doesn't exist yet, so every value is simply "what will be
 * written".
 */
export function summarizeCreatePayload(payload) {
  const header = [];
  for (const [field, value] of Object.entries(payload || {})) {
    if (field === "lines" || field === "add_lines" || field === "custom_fields") continue;
    header.push({
      field,
      label: PREVIEW_HEADER_LABELS[field] || field,
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : value,
    });
  }
  for (const [name, value] of Object.entries(payload?.custom_fields || {})) {
    header.push({ field: `custom:${name}`, label: `${name} (custom field)`, value });
  }
  return { header, lines: payload?.lines || [] };
}

/** Header fields worth showing in a preview, with friendly labels. */
const PREVIEW_HEADER_LABELS = {
  customer: "Customer",
  ref_number: "SO number",
  other: "Other (lock date)",
  ship_date: "Ship date",
  due_date: "Due date",
  po_number: "PO number",
  memo: "Memo",
  txn_date: "Transaction date",
  class_name: "Class",
  template: "Template",
  ship_method: "Ship method",
  silver_lock_date: "Silver Lock Date",
};

// QuickBooks surfaces the built-in Other field under custom_fields on a read
// (see _so_to_dict in qb_connector.py), so a payload's `other` has to be
// compared against that rather than a top-level property.
function existingHeaderValue(existingSo, apiField) {
  if (apiField === "other") {
    return existingSo?.other ?? existingSo?.custom_fields?.Other ?? null;
  }
  if (apiField === "silver_lock_date") {
    return existingSo?.silver_lock_date ?? null;
  }
  return existingSo?.[apiField] ?? null;
}

const sameValue = (a, b) =>
  (a == null ? "" : String(a).trim()) === (b == null ? "" : String(b).trim());

/**
 * Diff a built payload against the sales order QuickBooks currently has, so a
 * batch can be shown before it's sent. Pure — touches nothing.
 *
 * Returns { header[], lines[], addLines[], orphans[], changeCount } where each
 * header entry is { field, label, from, to } and each line entry is
 * { txn_line_id, item, fields: [{ field, from, to }] } — only fields that
 * actually differ are included, so an unchanged PO shows changeCount 0 and can
 * be skipped instead of burning a QuickBooks round trip.
 */
export function diffSalesOrderUpdate(payload, existingSo, matchReport = []) {
  const header = [];
  for (const [field, to] of Object.entries(payload || {})) {
    if (field === "lines" || field === "add_lines" || field === "custom_fields") continue;
    const from = existingHeaderValue(existingSo, field);
    if (!sameValue(from, to)) {
      header.push({ field, label: PREVIEW_HEADER_LABELS[field] || field, from, to });
    }
  }
  // custom_fields are a map — diff each named field on its own.
  for (const [name, to] of Object.entries(payload?.custom_fields || {})) {
    const from = existingSo?.custom_fields?.[name] ?? null;
    if (!sameValue(from, to)) {
      header.push({ field: `custom:${name}`, label: `${name} (custom field)`, from, to });
    }
  }

  const existingById = new Map(
    (existingSo?.lines || [])
      .filter((l) => l && l.txn_line_id)
      .map((l) => [String(l.txn_line_id), l])
  );
  const byLineId = new Map(
    (matchReport || []).map((m) => [String(m.txn_line_id), m])
  );

  const lines = [];
  for (const l of payload?.lines || []) {
    const cur = existingById.get(String(l.txn_line_id));
    const fields = [];
    for (const f of ["item", "quantity", "rate", "description", "other1", "other2"]) {
      if (!(f in l)) continue;
      const from = cur?.[f] ?? null;
      if (!sameValue(from, l[f])) fields.push({ field: f, from, to: l[f] });
    }
    if (fields.length) {
      lines.push({
        txn_line_id: l.txn_line_id,
        item: l.item ?? cur?.item ?? null,
        sku: byLineId.get(String(l.txn_line_id))?.sku ?? null,
        fields,
      });
    }
  }

  const addLines = (payload?.add_lines || []).map((l) => ({
    item: l.item ?? null,
    quantity: l.quantity ?? null,
    rate: l.rate ?? null,
  }));

  return {
    header,
    lines,
    addLines,
    changeCount: header.length + lines.length + addLines.length,
  };
}

/**
 * Build (but do NOT send) the update for each selected PO, and diff it against
 * what QuickBooks currently has. This is the first half of the batch flow:
 * everything is computed up front so the whole batch can be reviewed before
 * any of it lands, and the prepared payloads are handed back so the send step
 * transmits EXACTLY what was shown — no rebuild in between, no chance of the
 * preview and the write disagreeing.
 *
 * Returns { enabled, prepared[], notFound[], failed[], unchanged[], total }.
 * Each prepared entry is { po, label, payload, diff, matchReport, orphans }.
 */
export async function prepareSalesOrderUpdatesForPos(pos, { supabase, settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, prepared: [], notFound: [], failed: [], unchanged: [], total: 0 };
  }
  const prepared = [];
  const notFound = [];
  const failed = [];
  const unchanged = [];
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
      let lockInfo = null;
      if (supabase && po.lock_date) {
        const { data } = await supabase
          .from("metal_lock_history")
          .select("date,silver_lock,gold_lock")
          .eq("date", po.lock_date)
          .maybeSingle();
        lockInfo = data || { date: po.lock_date };
      }
      const { payload, unrecognizedFields, matchReport, orphanQbLines } =
        buildSalesOrderUpdatePayloadFromMapping(
          po,
          lines,
          existingSo,
          mappingText,
          undefined,
          lockInfo
        );
      if (unrecognizedFields.length) {
        throw new Error(
          `Mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")}`
        );
      }
      const diff = diffSalesOrderUpdate(payload, existingSo, matchReport);
      if (diff.changeCount === 0) {
        unchanged.push({ po: label });
      } else {
        prepared.push({
          po,
          label,
          payload,
          diff,
          matchReport: matchReport || [],
          orphans: orphanQbLines || [],
        });
      }
    } catch (e) {
      console.warn("[QB] prepare failed for PO " + label, e);
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, prepared, notFound, failed, unchanged, total: list.length };
}

/**
 * Second half of the batch flow: send payloads that were already built and
 * reviewed by prepareSalesOrderUpdatesForPos. Sends them verbatim, so what
 * was approved in the preview is what QuickBooks receives. One PO failing
 * never stops the rest.
 *
 * Returns { enabled, updated[], failed[], total }.
 */
export async function sendPreparedSalesOrderUpdates(prepared, { settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], failed: [], total: 0 };
  }
  const updated = [];
  const failed = [];
  const list = prepared || [];

  for (let i = 0; i < list.length; i++) {
    const { po, label, payload, diff, matchReport, orphans } = list[i];
    const poLabel = label || po?.po_number || "?";
    try {
      console.info("[QB] PATCH /sales-orders/" + po.po_number, payload);
      const res = await ensureSalesOrderUpdated(po.po_number, payload, { settings });
      if (res.updated) {
        updated.push({
          po: poLabel,
          matched: matchReport?.length || 0,
          repriced: (diff?.lines || []).filter((l) =>
            l.fields.some((f) => f.field === "rate")
          ).length,
          added: (diff?.addLines || []).length,
          headerChanges: diff?.header || [],
          orphans: orphans || [],
        });
      } else if (res.notFound) {
        failed.push({ po: poLabel, error: "sales order no longer in QuickBooks" });
      } else {
        failed.push({ po: poLabel, error: res.reason || "skipped" });
      }
    } catch (e) {
      console.warn("[QB] send failed for PO " + poLabel, e);
      failed.push({ po: poLabel, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, failed, total: list.length };
}

/**
 * Build (but do NOT send) a Sales Order create for each selected PO, and
 * check which ones QuickBooks already has. Same two-phase shape as the update
 * flow: nothing is written until the prepared payloads are approved, and the
 * send step transmits them verbatim.
 *
 * A PO whose SO already exists goes to `existed` and is NOT prepared — create
 * never overwrites.
 *
 * Returns { enabled, prepared[], existed[], failed[], total }, where each
 * prepared entry is { po, label, payload, summary }.
 */
export async function prepareSalesOrderCreatesForPos(pos, { supabase, settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, prepared: [], existed: [], failed: [], total: 0 };
  }
  const prepared = [];
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
      if (!payload.ref_number) {
        throw new Error(
          "mapping produced no RefNumber — the existence check needs it"
        );
      }
      // Ask QuickBooks up front so "already exists" is shown in the review
      // rather than discovered mid-send.
      const already = await findSalesOrder(payload.ref_number);
      if (already) {
        existed.push({ po: label });
      } else {
        prepared.push({ po, label, payload, summary: summarizeCreatePayload(payload) });
      }
    } catch (e) {
      console.warn("[QB] prepare-create failed for PO " + label, e);
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, prepared, existed, failed, total: list.length };
}

/**
 * Send Sales Order creates that were already built and reviewed by
 * prepareSalesOrderCreatesForPos. Still re-checks existence per PO inside
 * ensureSalesOrderCreated, so an SO created by someone else between the
 * review and the send is reported instead of duplicated.
 *
 * Returns { enabled, created[], existed[], failed[], total }.
 */
export async function sendPreparedSalesOrderCreates(prepared, { settings, onProgress } = {}) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, created: [], existed: [], failed: [], total: 0 };
  }
  const created = [];
  const existed = [];
  const failed = [];
  const list = prepared || [];

  for (let i = 0; i < list.length; i++) {
    const { po, label, payload } = list[i];
    const poLabel = label || po?.po_number || "?";
    try {
      console.info("[QB] POST /sales-orders " + poLabel, payload);
      const res = await ensureSalesOrderCreated(payload, { settings });
      if (res.created) created.push({ po: poLabel });
      else if (res.existed) existed.push({ po: poLabel });
      else failed.push({ po: poLabel, error: res.reason || "skipped" });
    } catch (e) {
      console.warn("[QB] create failed for PO " + poLabel, e);
      failed.push({ po: poLabel, error: e?.message || String(e) });
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
          `Mapping has unrecognized QB field(s): ${unrecognizedFields.join(", ")} — ` +
            `known header fields: ${Object.keys(SO_UPDATE_HEADER_FIELD_KEYS).join(", ")}; ` +
            `line fields: ${Object.keys(SO_UPDATE_LINE_FIELD_KEYS).join(", ")}; ` +
            `or Custom:<exact QB field name>`
        );
      }
      // Logged so the payload can be compared against the connector's request
      // log directly. If this prints but no PATCH /sales-orders/<n> shows up
      // on the connector, the request never left the browser.
      console.info("[QB] PATCH /sales-orders/" + po.po_number, payload);
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
          // What went to QB's header custom fields (data extensions), so a
          // mapping pointed at a field name that doesn't exist in this
          // company file shows up as "sent X" with the SO still unchanged,
          // instead of failing silently.
          customFields: payload.custom_fields || null,
          silverLockDate: payload.silver_lock_date ?? null,
        });
      } else if (res.notFound) notFound.push({ po: label });
      else failed.push({ po: label, error: res.reason || "skipped" });
    } catch (e) {
      console.warn("[QB] update failed for PO " + label, e);
      failed.push({ po: label, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, notFound, failed, total: list.length };
}
