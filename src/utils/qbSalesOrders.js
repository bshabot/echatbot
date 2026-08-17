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
  createSalesOrder,
  ensureSalesOrderCreated,
  ensureSalesOrderUpdated,
  fetchMemosReport,
  fetchWriteResult,
  findSalesOrder,
  isQbEnabled,
  isUnknownOutcome,
} from "./qbClient";
import {
  buildSalesOrderCreatePayloadFromMapping,
  buildSalesOrderUpdatePayloadFromMapping,
  getSoCreateMappingText,
  getSoUpdateMappingText,
  SO_UPDATE_HEADER_FIELD_KEYS,
  SO_UPDATE_LINE_FIELD_KEYS,
} from "./qbMapping";
import { persistSyncResult, runPool, QB_SYNC_CONCURRENCY, trackQbProcess, capDetail } from "./qbSyncStatus";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";

// ---------- "U <date>" update marker on the memo ----------
//
// Kevin 8/13: "in sales order if we update a record, can you update the
// memo to be U Date + what the memo is." Whenever a real change actually
// goes out to QuickBooks on an existing sales order (not just a no-op
// prepare/check), the memo gets stamped with "U <M/D>" so anyone glancing
// at the SO in QuickBooks — or the PLM's own memo column — can see it was
// touched by our update flow and when, without digging through sync_logs.
// It's pushed IN the same PATCH as the rest of the update (not a separate
// write), so it lands atomically with whatever else changed, and mirrors
// the existing "updated <date> <memo>" convention already used in the
// rebill xlsx export (see PurchaseOrders.jsx's exportMD).
//
// Replaces rather than stacks: re-stamping strips any prior "U <date> "
// this same marker wrote before prepending the new one, so a PO updated on
// several different days shows only the most recent date, not a growing
// trail of markers.
//
// Hardcoded here rather than added to the Settings mapping DSL — this is
// an internal bookkeeping convention, not something that should vary per
// company file, and it needs to apply with zero Settings.jsx changes.
const MEMO_UPDATE_STAMP_RE = /^U \d{1,2}\/\d{1,2}\s*/;

function todayEasternMD() {
  const iso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const p = iso.split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso;
}

function todayEasternISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** "U 8/13 <memo without any prior U-stamp>" — see doc block above. */
function stampUpdatedMemo(currentMemo) {
  const base = (currentMemo || "").replace(MEMO_UPDATE_STAMP_RE, "").trim();
  const md = todayEasternMD();
  return base ? `U ${md} ${base}` : `U ${md}`;
}

/**
 * Best-effort: keep the PLM's own memo column in sync with what was just
 * written to QuickBooks, so it doesn't sit stale until the next scheduled
 * syncMemosFromQb pull. Never throws — a failure here must never be mistaken
 * for the actual sales-order update failing (that already succeeded by the
 * time this runs).
 */
async function persistLocalMemo(supabase, po, memo) {
  if (!supabase || !po?.id || memo == null) return;
  try {
    await supabase
      .from("running_line_purchase_orders")
      .update({ memo, memo_updated_at: todayEasternISO() })
      .eq("id", po.id);
  } catch (e) {
    console.warn("[QB] local memo persist failed for PO " + (po.po_number || po.id), e);
  }
}

/**
 * A4 — decide what a WRITE timeout actually meant.
 *
 * A 130s abort does NOT mean the write didn't happen: the connector's job can
 * still be delivered to QuickBooks after we gave up, and QB commits it (real
 * case: PO 170942 on 8/10, stamped `failed` while the SO existed). So instead
 * of recording `failed`, wait for the connector to catch up and look:
 *
 *   1. GET /write-results/{key} — the connector records late outcomes now (K3).
 *   2. Fall back to reading the sales order itself: does it exist, and does
 *      its memo carry today's "U <date>" stamp?
 *
 * Returns "created" | "synced" | "unknown" — never "failed". `unknown` is a
 * real, honest state (grey "QB ?" chip); the next run resolves it.
 */
const TIMEOUT_RECHECK_DELAY_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function reconcileTimedOutWrite(
  refNumber,
  { action = "update", writeKey, expectMemo, delayMs = TIMEOUT_RECHECK_DELAY_MS } = {}
) {
  await sleep(delayMs);

  if (writeKey) {
    const rec = await fetchWriteResult(writeKey);
    if (rec?.status === "done" || rec?.status === "late-done") {
      return action === "create" ? "created" : "synced";
    }
    if (rec?.status === "error" || rec?.status === "late-error") return "failed";
  }

  try {
    const so = await findSalesOrder(refNumber);
    if (!so) return action === "create" ? "unknown" : "unknown";
    if (action === "create") return "created";
    // An update only counts as landed if today's stamp is on the memo —
    // the SO existing proves nothing, it existed before we started.
    if (expectMemo && sameValue(so.memo, expectMemo)) return "synced";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// Pull every existing Zales SO number in ONE report call (the all-so-zales
// view) so a batch can check existence locally instead of a per-PO
// GET /sales-orders/{ref} — each of which, over the Web Connector transport,
// can wait a full poll cycle and time out (the 130s failures). Returns a Set of
// ref-number strings, or null if the bulk fetch fails (callers fall back to the
// per-PO check so nothing regresses). Bounded by the view's date range.
async function fetchExistingSoRefs(settings) {
  try {
    const { rows } = await fetchMemosReport({ settings });
    return new Set(
      (rows || [])
        .map((r) => String(r?.Num ?? r?.num ?? "").trim())
        .filter(Boolean)
    );
  } catch {
    return null;
  }
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
  const list = pos || [];
  return trackQbProcess(
    supabase,
    {
      type: "create-direct",
      label: `Creating ${list.length} sales order${list.length === 1 ? "" : "s"} in QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.id).filter(Boolean),
      source: "qb-sales-order",
      action: "create-direct",
      // Safe to blind-retry: every path here checks for an existing SO
      // (the bulk existingRefs set, or ensureSalesOrderCreated's own check)
      // before POSTing, so replaying the same list just re-skips what
      // already went through.
      retry: () => createSalesOrdersForPos(pos, { supabase, settings, onProgress }),
      initiator: { pos },
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const created = [];
      const existed = [];
      const failed = [];
      const mappingText = getSoCreateMappingText(settings);

      // Existence check, ONCE for the whole batch. A per-PO GET /sales-orders/{ref}
      // over the Web Connector (qbwc) transport can wait a full poll cycle and time
      // out — that's the 130s "QB API timed out" failures. Instead, pull every
      // existing Zales SO number in a single report call (the all-so-zales view)
      // and check membership locally. If that bulk fetch fails (e.g. QB is hung),
      // fall back to the slower per-PO check so behavior never regresses.
      //
      // Caveat: the view is bounded to its configured date range (report_views.json
      // all-so-zales), so an SO outside that window won't be "seen" and its PO would
      // be (re-)created. Current POs fall inside it; widen the view if that changes.
      let existingRefs = null;
      try {
        const { rows } = await fetchMemosReport({ settings });
        existingRefs = new Set(
          (rows || [])
            .map((r) => String(r?.Num ?? r?.num ?? "").trim())
            .filter(Boolean)
        );
      } catch {
        existingRefs = null;
      }

      let cancelled = false;
      for (let i = 0; i < list.length; i++) {
        if (store.shouldCancel(procId)) {
          cancelled = true;
          break;
        }
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

          if (existingRefs && payload.ref_number != null) {
            // Fast path: local existence check, then a single POST if missing —
            // no per-PO existence GET, so no per-PO timeout.
            if (existingRefs.has(String(payload.ref_number))) {
              existed.push({ po: label });
            } else {
              await createSalesOrder(payload);
              created.push({ po: label });
            }
          } else {
            // Fallback: bulk fetch failed (or no ref_number to match on) — use the
            // per-PO check, same as before.
            const res = await ensureSalesOrderCreated(payload, { settings });
            if (res.created) created.push({ po: label });
            else if (res.existed) existed.push({ po: label });
            else failed.push({ po: label, error: res.reason || "skipped" });
          }
        } catch (e) {
          failed.push({ po: label, error: e?.message || String(e) });
        }
        store.updateProcess(procId, { done: i + 1, total: list.length, phase: "Creating in QuickBooks" });
        if (typeof onProgress === "function") onProgress(i + 1, list.length);
      }

      return { enabled: true, created, existed, failed, total: list.length, cancelled };
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Created ${result.created.length}, ${result.existed.length} already existed, ${result.failed.length} failed (of ${result.total})`,
      summary: {
        created: result.created.length,
        existed: result.existed.length,
        failed: result.failed.length,
        // [{ po, error }] — which PO and the actual QB/connector error.
        failedDetail: capDetail(result.failed),
      },
    })
  );
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
export async function prepareSalesOrderUpdatesForPos(
  pos,
  { supabase, settings, onProgress, forceMemoStamp = true } = {}
) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, prepared: [], notFound: [], failed: [], unchanged: [], total: 0 };
  }
  const list = pos || [];
  return trackQbProcess(
    supabase,
    {
      type: "update-prepare",
      label: `Checking ${list.length} PO${list.length === 1 ? "" : "s"} against QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.id).filter(Boolean),
      source: "qb-sales-order",
      action: "update-prepare",
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const prepared = [];
      const notFound = [];
      const failed = [];
      const unchanged = [];
      const mappingText = getSoUpdateMappingText(settings);

      // Skip the slow per-PO existence GET for POs QuickBooks clearly doesn't have.
      // We still fetch the full SO (below) for the ones that DO exist, because the
      // diff needs their line txn_line_ids.
      const existingRefs = await fetchExistingSoRefs(settings);

      let cancelled = false;
      for (let i = 0; i < list.length; i++) {
        if (store.shouldCancel(procId)) {
          cancelled = true;
          break;
        }
        const po = list[i];
        const label = po.po_number || (po.id ? String(po.id).slice(0, 8) : "?");
        try {
          if (!po.po_number) throw new Error("PO has no PO number");
          if (existingRefs != null && !existingRefs.has(String(po.po_number))) {
            notFound.push({ po: label });
            continue;
          }
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
          // A1 — Kevin 8/13: "when I update or click the update then it
          // should allow an update": a deliberate click shouldn't come back
          // empty-handed just because the mapped fields already match QB.
          // That needs a FLAG, not the removal of the diff. Stamping the
          // memo unconditionally routed every PO to `prepared`, so every
          // send re-PATCHed every line (silently reverting hand-edits made
          // in QB), Resume re-sent everything, and a same-day re-click fired
          // a batch of no-op PATCHes.
          //
          //   forceMemoStamp true  (button click) — always send something,
          //     unless the memo already carries today's stamp, in which case
          //     there is genuinely nothing left to do.
          //   forceMemoStamp false (Resume / background) — only POs with a
          //     real change are sent.
          const stamped = stampUpdatedMemo(existingSo?.memo ?? po.memo ?? "");
          const memoAlreadyStamped = sameValue(existingSo?.memo, stamped);
          let diff = diffSalesOrderUpdate(payload, existingSo, matchReport);
          if (diff.changeCount === 0 && (!forceMemoStamp || memoAlreadyStamped)) {
            unchanged.push({ po: label });
            continue;
          }
          payload.memo = stamped;
          diff = diffSalesOrderUpdate(payload, existingSo, matchReport);
          prepared.push({
            po,
            label,
            payload,
            existingSo, // A2 — the send step reuses this instead of re-GETting
            preparedAt: Date.now(), // B8 — previews go stale
            diff,
            matchReport: matchReport || [],
            orphans: orphanQbLines || [],
          });
        } catch (e) {
          console.warn("[QB] prepare failed for PO " + label, e);
          failed.push({ po: label, error: e?.message || String(e) });
        }
        store.updateProcess(procId, { done: i + 1, total: list.length, phase: "Checking QuickBooks" });
        if (typeof onProgress === "function") onProgress(i + 1, list.length);
      }

      return { enabled: true, prepared, notFound, failed, unchanged, total: list.length, cancelled };
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Checked ${result.total}: ${result.prepared.length} have changes, ${result.unchanged.length} already up to date, ${result.notFound.length} not in QB, ${result.failed.length} failed`,
      summary: {
        prepared: result.prepared.length,
        unchanged: result.unchanged.length,
        notFound: result.notFound.length,
        failed: result.failed.length,
        // [{ po, error }] — e.g. "Mapping has unrecognized QB field(s): ..."
        failedDetail: capDetail(result.failed),
        // [{ po }] — which POs QuickBooks doesn't have an SO for yet.
        notFoundDetail: capDetail(result.notFound),
      },
    })
  );
}

/**
 * Second half of the batch flow: send payloads that were already built and
 * reviewed by prepareSalesOrderUpdatesForPos. Sends them verbatim, so what
 * was approved in the preview is what QuickBooks receives. One PO failing
 * never stops the rest.
 *
 * Returns { enabled, updated[], failed[], total, cancelled }.
 */
export async function sendPreparedSalesOrderUpdates(
  prepared,
  { supabase, settings, onProgress, concurrency = QB_SYNC_CONCURRENCY } = {}
) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, updated: [], failed: [], total: 0, cancelled: false };
  }
  const list = prepared || [];
  return trackQbProcess(
    supabase,
    {
      type: "update-send",
      label: `Updating ${list.length} sales order${list.length === 1 ? "" : "s"} in QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.po?.id).filter(Boolean),
      source: "qb-sales-order",
      action: "update-send",
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const updated = [];
      const failed = [];

      // Bounded concurrency: several PATCHes in flight at once so the connector's
      // queue stays fed (QuickBooks still serializes the writes). Each result is
      // persisted as it settles, so a browser close mid-batch keeps what succeeded.
      const { cancelled } = await runPool(
        list,
        async ({ po, label, payload, diff, matchReport, orphans, existingSo }) => {
          const poLabel = label || po?.po_number || "?";
          try {
            console.info("[QB] PATCH /sales-orders/" + po.po_number, payload);
            // A2 — prepare already fetched this SO; passing it through skips a
            // redundant per-PO GET and halves every update batch.
            const res = await ensureSalesOrderUpdated(po.po_number, payload, {
              settings,
              existingSo: existingSo ?? undefined,
            });
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
              await persistSyncResult(supabase, po, {
                action: "update",
                result: "synced",
                soRef: po.po_number,
              });
              // Keep our own memo column in step with what QuickBooks now has
              // (payload.memo was stamped in prepareSalesOrderUpdatesForPos)
              // instead of waiting on the next scheduled memo pull.
              await persistLocalMemo(supabase, po, payload.memo);
            } else if (res.notFound) {
              failed.push({ po: poLabel, error: "sales order no longer in QuickBooks" });
              await persistSyncResult(supabase, po, { action: "update", result: "not_found" });
            } else {
              failed.push({ po: poLabel, error: res.reason || "skipped" });
              await persistSyncResult(supabase, po, {
                action: "update",
                result: "failed",
                error: res.reason || "skipped",
              });
            }
          } catch (e) {
            // A4 — a timeout is "we don't know", not "it failed".
            if (isUnknownOutcome(e)) {
              store.updateProcess(procId, { phase: `Verifying ${poLabel}` });
              const verdict = await reconcileTimedOutWrite(po.po_number, {
                action: "update",
                expectMemo: payload?.memo,
              });
              if (verdict === "synced") {
                updated.push({
                  po: poLabel,
                  matched: matchReport?.length || 0,
                  repriced: (diff?.lines || []).filter((l) =>
                    l.fields.some((f) => f.field === "rate")
                  ).length,
                  added: (diff?.addLines || []).length,
                  headerChanges: diff?.header || [],
                  orphans: orphans || [],
                  lateConfirmed: true,
                });
                await persistSyncResult(supabase, po, {
                  action: "update",
                  result: "synced",
                  soRef: po.po_number,
                });
                await persistLocalMemo(supabase, po, payload.memo);
                return;
              }
              if (verdict === "unknown") {
                failed.push({
                  po: poLabel,
                  error:
                    "timed out — QuickBooks may or may not have applied this. " +
                    "Left as unknown; re-check before resending.",
                  unknown: true,
                });
                await persistSyncResult(supabase, po, {
                  action: "update",
                  result: "unknown",
                  soRef: po.po_number,
                  error: e?.message || String(e),
                });
                return;
              }
              // verdict === "failed" — fall through and record it properly.
            }
            console.warn("[QB] send failed for PO " + poLabel, e);
            failed.push({ po: poLabel, error: e?.message || String(e) });
            await persistSyncResult(supabase, po, {
              action: "update",
              result: "failed",
              error: e?.message || String(e),
            });
          }
        },
        {
          concurrency,
          onProgress: (done, total) => {
            store.updateProcess(procId, { done, total, phase: "Sending to QuickBooks" });
            if (typeof onProgress === "function") onProgress(done, total);
          },
          shouldCancel: () => store.shouldCancel(procId),
        }
      );

      return { enabled: true, updated, failed, total: list.length, cancelled };
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Updated ${result.updated.length}, ${result.failed.length} failed (of ${result.total})`,
      summary: {
        updated: result.updated.length,
        failed: result.failed.length,
        // [{ po, error }] — the actual PATCH failure per PO (or "sales order
        // no longer in QuickBooks" if it vanished between prepare and send).
        failedDetail: capDetail(result.failed),
      },
    })
  );
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
  const list = pos || [];
  return trackQbProcess(
    supabase,
    {
      type: "create-prepare",
      label: `Checking ${list.length} PO${list.length === 1 ? "" : "s"} against QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.id).filter(Boolean),
      source: "qb-sales-order",
      action: "create-prepare",
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const prepared = [];
      const existed = [];
      const failed = [];
      const mappingText = getSoCreateMappingText(settings);

      // One existence call for the whole batch instead of a per-PO GET (the per-PO
      // GET is what was taking ~130s each and stalling big runs). Falls back to the
      // per-PO check only if this bulk fetch fails.
      const existingRefs = await fetchExistingSoRefs(settings);

      let cancelled = false;
      for (let i = 0; i < list.length; i++) {
        if (store.shouldCancel(procId)) {
          cancelled = true;
          break;
        }
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
          // "Already exists?" — local membership when we have the batch set,
          // otherwise the per-PO GET as a fallback. Shown in the review rather than
          // discovered mid-send.
          const already =
            existingRefs != null
              ? existingRefs.has(String(payload.ref_number))
              : Boolean(await findSalesOrder(payload.ref_number));
          if (already) {
            existed.push({ po: label });
          } else {
            prepared.push({ po, label, payload, summary: summarizeCreatePayload(payload) });
          }
        } catch (e) {
          console.warn("[QB] prepare-create failed for PO " + label, e);
          failed.push({ po: label, error: e?.message || String(e) });
        }
        store.updateProcess(procId, { done: i + 1, total: list.length, phase: "Checking QuickBooks" });
        if (typeof onProgress === "function") onProgress(i + 1, list.length);
      }

      return { enabled: true, prepared, existed, failed, total: list.length, cancelled };
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Checked ${result.total}: ${result.prepared.length} ready to create, ${result.existed.length} already exist, ${result.failed.length} failed`,
      summary: {
        prepared: result.prepared.length,
        existed: result.existed.length,
        failed: result.failed.length,
        failedDetail: capDetail(result.failed),
      },
    })
  );
}

/**
 * Same contract as qbClient.js's ensureSalesOrderCreated — resolves to
 * { existed: true } or { created: true, item } — but the existence check
 * comes from a pre-fetched `existingRefs` Set (see fetchExistingSoRefs)
 * instead of a live GET /sales-orders/{ref}.
 *
 * Why this exists: a live per-item GET, over the QuickBooks Web Connector's
 * poll-based transport, can wait a full poll cycle and time out (qbFetch's
 * own 130s limit — see qbClient.js's `timeoutMs`, sized to outlive the
 * connector's 120s server-side wait). Doing that once per PO turns a
 * 20-PO batch into 20 individual round trips, any one of which can time out
 * the whole item — Kevin 8/13: "it sends a request for a report, then sends
 * the gets for each of the records... my requests timeout." Prepare already
 * dodges this exact problem by fetching the all-so-zales view ONCE and
 * checking membership locally (fetchExistingSoRefs) instead of GETting every
 * PO — Send never got the same fix until now.
 *
 * Trade-off, accepted deliberately: the check is only as fresh as
 * `existingRefs`, fetched once right before this whole batch sends. An SO
 * created by someone else after that fetch but before this PO's turn in the
 * batch won't be caught here, and QuickBooks gets a second POST for the same
 * ref_number. That's the SAME category of race Prepare-then-Send already
 * accepts today (an SO created between reviewing the batch and hitting Send
 * isn't caught either) — just narrower: bounded to how long this batch takes
 * to send, not however long the review sat open, and refetched fresh right
 * here rather than reusing Prepare's now-stale copy.
 *
 * `existingRefs == null` (the bulk fetch failed) or no ref_number to check
 * falls back to the live per-item GET — same fallback Prepare already uses.
 */
async function ensureSalesOrderCreatedFast(payload, existingRefs, settings) {
  if (existingRefs == null || payload?.ref_number == null) {
    return ensureSalesOrderCreated(payload, { settings });
  }
  if (existingRefs.has(String(payload.ref_number))) {
    return { existed: true };
  }
  const item = await createSalesOrder(payload);
  return { created: true, item };
}

/**
 * Send Sales Order creates that were already built and reviewed by
 * prepareSalesOrderCreatesForPos. Re-checks existence for the whole batch
 * with ONE fresh bulk fetch right before sending (ensureSalesOrderCreatedFast
 * above) instead of a live GET per PO, so an SO created by someone else
 * between the review and the send is still caught and reported instead of
 * duplicated — just without turning a 20-PO batch into 20 round trips that
 * can each individually time out.
 *
 * Returns { enabled, created[], existed[], failed[], total, cancelled }.
 */
export async function sendPreparedSalesOrderCreates(
  prepared,
  { supabase, settings, onProgress, concurrency = QB_SYNC_CONCURRENCY } = {}
) {
  if (!isQbEnabled(settings)) {
    return { enabled: false, created: [], existed: [], failed: [], total: 0, cancelled: false };
  }
  const list = prepared || [];
  return trackQbProcess(
    supabase,
    {
      type: "create-send",
      label: `Creating ${list.length} sales order${list.length === 1 ? "" : "s"} in QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.po?.id).filter(Boolean),
      source: "qb-sales-order",
      action: "create-send",
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const created = [];
      const existed = [];
      const failed = [];

      // ONE fresh existence check for the whole batch, right before sending —
      // see ensureSalesOrderCreatedFast's doc comment for the reasoning and
      // the trade-off. Falls back to a live per-PO check (the old behavior)
      // only if this bulk fetch itself fails.
      const existingRefs = await fetchExistingSoRefs(settings);

      // Bounded concurrency (several POSTs in flight) + per-record persistence: each
      // PO's outcome is stamped onto its row and logged the moment it settles, so a
      // partial run is fully recorded and a re-run skips what already got created.
      const { cancelled } = await runPool(
        list,
        async ({ po, label, payload }) => {
          const poLabel = label || po?.po_number || "?";
          try {
            console.info("[QB] POST /sales-orders " + poLabel, payload);
            const res = await ensureSalesOrderCreatedFast(payload, existingRefs, settings);
            if (res.created) {
              created.push({ po: poLabel });
              await persistSyncResult(supabase, po, {
                action: "create",
                result: "created",
                soRef: payload?.ref_number,
              });
            } else if (res.existed) {
              existed.push({ po: poLabel });
              await persistSyncResult(supabase, po, {
                action: "create",
                result: "existed",
                soRef: payload?.ref_number,
              });
            } else {
              failed.push({ po: poLabel, error: res.reason || "skipped" });
              await persistSyncResult(supabase, po, {
                action: "create",
                result: "failed",
                error: res.reason || "skipped",
                soRef: payload?.ref_number,
              });
            }
          } catch (e) {
            // A4 — a timed-out create is "unknown", never "failed": the
            // connector may still deliver it and QB may still commit it.
            // Recording it as failed is how a duplicate SO gets created on
            // the retry.
            if (isUnknownOutcome(e)) {
              store.updateProcess(procId, { phase: `Verifying ${poLabel}` });
              const verdict = await reconcileTimedOutWrite(payload?.ref_number, {
                action: "create",
                writeKey: payload?.ref_number ? `so:${payload.ref_number}` : undefined,
              });
              if (verdict === "created") {
                created.push({ po: poLabel, lateConfirmed: true });
                await persistSyncResult(supabase, po, {
                  action: "create",
                  result: "created",
                  soRef: payload?.ref_number,
                });
                return;
              }
              if (verdict === "unknown") {
                failed.push({
                  po: poLabel,
                  error:
                    "timed out — QuickBooks may or may not have created this SO. " +
                    "Left as unknown; check QB before resending.",
                  unknown: true,
                });
                await persistSyncResult(supabase, po, {
                  action: "create",
                  result: "unknown",
                  soRef: payload?.ref_number,
                  error: e?.message || String(e),
                });
                return;
              }
            }
            console.warn("[QB] create failed for PO " + poLabel, e);
            failed.push({ po: poLabel, error: e?.message || String(e) });
            await persistSyncResult(supabase, po, {
              action: "create",
              result: "failed",
              error: e?.message || String(e),
              soRef: payload?.ref_number,
            });
          }
        },
        {
          concurrency,
          onProgress: (done, total) => {
            store.updateProcess(procId, { done, total, phase: "Creating in QuickBooks" });
            if (typeof onProgress === "function") onProgress(done, total);
          },
          shouldCancel: () => store.shouldCancel(procId),
        }
      );

      return { enabled: true, created, existed, failed, total: list.length, cancelled };
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Created ${result.created.length}, ${result.existed.length} already existed, ${result.failed.length} failed (of ${result.total})`,
      summary: {
        created: result.created.length,
        existed: result.existed.length,
        failed: result.failed.length,
        failedDetail: capDetail(result.failed),
      },
    })
  );
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
  return trackQbProcess(
    supabase,
    {
      type: "memo-sync",
      label: "Syncing PO memos from QuickBooks",
      source: "qb-memos",
      action: "memo-sync",
      // Safe to blind-retry: it just re-reads the report and re-writes
      // whatever memo is live right now, same as re-clicking the button.
      retry: () => syncMemosFromQb({ supabase, settings, poNumbers }),
      initiator: { poNumbers },
    },
    () => syncMemosFromQbInner({ supabase, settings, poNumbers }),
    (result) => ({
      status: "done",
      message: `Memo sync: ${result.updated} PO memo${result.updated === 1 ? "" : "s"} updated (${result.seen} resolved, ${result.notFound?.length || 0} not in report, ${result.conflicts?.length || 0} conflicts)`,
      summary: {
        updated: result.updated,
        resolved: result.seen,
        notFound: result.notFound?.length || 0,
        conflicts: result.conflicts?.length || 0,
        // plain PO-number strings — checked for but not in the report at all.
        notFoundDetail: capDetail(result.notFound),
        // [{ po, chosen, options, resolved }] — which POs had more than one
        // candidate memo and how it was (or wasn't) resolved.
        conflictDetail: capDetail(result.conflicts),
      },
    })
  );
}

async function syncMemosFromQbInner({ supabase, settings, poNumbers = [] }) {
  const { rows } = await fetchMemosReport({ settings });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Group the report by PO number FIRST. Several rows can collapse onto one
  // PO — the number match is a prefix (so 167896, 167896R and 167896-2 all
  // land on 167896), and a company file can carry more than one sales order
  // for the same PO. The old code pushed every row into a flat list and wrote
  // them in order, so whichever row came last silently won: PO 167896 has two
  // SOs and "replacement" overwrote "not confirmed yet" with nothing reported.
  const byPo = new Map();
  const seenPoNumbers = new Set();
  for (const r of rows || []) {
    const numRaw = r?.Num ?? r?.num;
    const memoRaw = r?.Memo ?? r?.memo;
    const typeRaw = r?.Type ?? r?.type;
    if (numRaw == null) continue;
    // The view is meant to be sales orders only, but a report that ever
    // returned another transaction type under the same Num would otherwise
    // overwrite the SO's memo.
    if (typeRaw != null && !/sales\s*order/i.test(String(typeRaw))) continue;
    const num = String(numRaw).trim();
    const m = num.match(/^(\d{4,})/);
    if (!m) continue;
    const po = m[1];
    seenPoNumbers.add(po);
    const memo = memoRaw == null ? "" : String(memoRaw).trim();
    if (!memo) continue; // never clear a memo
    if (!byPo.has(po)) byPo.set(po, []);
    byPo.get(po).push({ num, memo });
  }

  // Resolve each PO to at most one memo, deterministically.
  const pairs = [];
  const conflicts = [];
  for (const [po, rowsForPo] of byPo) {
    if (rowsForPo.length === 1) {
      pairs.push({ po, memo: rowsForPo[0].memo });
      continue;
    }
    const distinct = [...new Set(rowsForPo.map((r) => r.memo))];
    if (distinct.length === 1) {
      pairs.push({ po, memo: distinct[0] });
      continue;
    }
    // An exact Num match beats a prefix match — "167896" outranks "167896R".
    const exact = rowsForPo.filter((r) => r.num === po);
    if (exact.length === 1) {
      pairs.push({ po, memo: exact[0].memo });
      conflicts.push({ po, chosen: exact[0], options: rowsForPo, resolved: "exact-num" });
      continue;
    }
    // Genuinely ambiguous: leave the existing memo alone rather than pick one
    // at random, and report it so it can be settled in QuickBooks.
    conflicts.push({ po, chosen: null, options: rowsForPo, resolved: "skipped" });
  }

  // Write the resolved memos back onto the matching POs (never clearing one).
  // This loop + `updated` were dropped in a refactor, leaving `updated`
  // undefined at the return below (a ReferenceError every call) — restored here.
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

  // Start/finish logging for this whole operation is handled by the
  // trackQbProcess wrapper in syncMemosFromQb above — this inner function
  // just returns the numbers for its summarize() callback to report.
  return { enabled: true, updated, seen: pairs.length, pairs, today, notFound, conflicts };
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
  const list = pos || [];
  return trackQbProcess(
    supabase,
    {
      type: "so-update",
      label:
        list.length === 1
          ? `Updating sales order for PO ${list[0]?.po_number || list[0]?.id || "?"}`
          : `Updating ${list.length} sales orders in QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p.id).filter(Boolean),
      source: "qb-sales-order",
      action: "so-update",
    },
    (procId) => updateSalesOrdersForPosInner(list, { supabase, settings, onProgress, priceOverridesByPoId, procId }),
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Updated ${result.updated.length}, ${result.notFound.length} not in QB, ${result.failed.length} failed (of ${result.total})`,
      summary: {
        updated: result.updated.length,
        notFound: result.notFound.length,
        failed: result.failed.length,
        failedDetail: capDetail(result.failed),
        notFoundDetail: capDetail(result.notFound),
      },
    })
  );
}

async function updateSalesOrdersForPosInner(list, { supabase, settings, onProgress, priceOverridesByPoId, procId }) {
  const store = useQbSyncJobStore.getState();
  const updated = [];
  const notFound = [];
  const failed = [];
  const mappingText = getSoUpdateMappingText(settings);

  let cancelled = false;
  for (let i = 0; i < list.length; i++) {
    if (store.shouldCancel(procId)) {
      cancelled = true;
      break;
    }
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
      // Every direct "Update this SO in QB" push is a deliberate real change
      // (no unchanged-skip here, unlike the batch preview flow) — always
      // stamp the memo (stampUpdatedMemo, above).
      payload.memo = stampUpdatedMemo(existingSo?.memo ?? po.memo ?? "");
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
        await persistSyncResult(supabase, po, {
          action: "update",
          result: "synced",
          soRef: po.po_number,
        });
        // Keep our own memo column in step with what QuickBooks now has,
        // instead of waiting on the next scheduled memo pull.
        await persistLocalMemo(supabase, po, payload.memo);
      } else if (res.notFound) {
        notFound.push({ po: label });
        await persistSyncResult(supabase, po, { action: "update", result: "not_found" });
      } else {
        failed.push({ po: label, error: res.reason || "skipped" });
        await persistSyncResult(supabase, po, {
          action: "update",
          result: "failed",
          error: res.reason || "skipped",
        });
      }
    } catch (e) {
      console.warn("[QB] update failed for PO " + label, e);
      failed.push({ po: label, error: e?.message || String(e) });
      await persistSyncResult(supabase, po, {
        action: "update",
        result: "failed",
        error: e?.message || String(e),
      });
    }
    store.updateProcess(procId, { done: i + 1, total: list.length, phase: "Updating in QuickBooks" });
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }

  return { enabled: true, updated, notFound, failed, total: list.length, cancelled };
}
