// src/utils/qbSyncStatus.js
//
// Durable QuickBooks Sales-Order sync status, shared by the create/update flows
// in qbSalesOrders.js. Two concerns:
//   - persistSyncResult: stamp a PO row's qb_* columns AND write a general
//     sync_logs entry (via logEvent) after every attempt, so "what was created
//     vs synced, and when" and "what failed and why" survive a reload — and a
//     re-run can skip what's done.
//   - runPool: bounded-concurrency runner so a bulk batch isn't strictly serial
//     (several requests in flight at once), while still reporting progress.
//
// Both are best-effort about their own failures: recording a result must never
// be what breaks the sync it is recording.

import { logEvent } from "./logEvent";

/** Map a result -> the qb_* patch written onto running_line_purchase_orders. */
function statusPatch(result, soRef, nowIso) {
  switch (result) {
    case "created":
      return {
        qb_so_status: "created",
        qb_so_ref: soRef ?? null,
        qb_created_at: nowIso,
        qb_synced_at: nowIso,
        qb_sync_error: null,
      };
    case "existed":
      return {
        qb_so_status: "existed",
        ...(soRef ? { qb_so_ref: soRef } : {}),
        qb_synced_at: nowIso,
        qb_sync_error: null,
      };
    case "synced":
      return {
        qb_so_status: "synced",
        ...(soRef ? { qb_so_ref: soRef } : {}),
        qb_synced_at: nowIso,
        qb_sync_error: null,
      };
    case "failed":
      return { qb_so_status: "failed" }; // qb_sync_error filled in by caller
    case "not_found":
      // No SO in QB yet — don't clobber a prior good status, just clear the error.
      return { qb_sync_error: null };
    default:
      return {};
  }
}

/** result -> sync_logs level: failures are errors, no-SO-yet is info, rest ok. */
function levelFor(result) {
  if (result === "failed") return "error";
  if (result === "not_found") return "info";
  return "success";
}

/**
 * Record one attempt: patch the PO row's qb_* columns and write a general
 * sync_logs entry (via logEvent). `result` in
 * { created | existed | synced | not_found | failed }. Swallows its own errors
 * so status-recording never breaks the actual sync.
 */
export async function persistSyncResult(supabase, po, { action, result, error = null, soRef = null } = {}) {
  if (!supabase || !po) return;
  const nowIso = new Date().toISOString();
  const patch = statusPatch(result, soRef, nowIso);
  if (result === "failed") patch.qb_sync_error = error || "failed";
  try {
    if (po.id && Object.keys(patch).length) {
      await supabase.from("running_line_purchase_orders").update(patch).eq("id", po.id);
    }
  } catch (e) {
    console.warn("[QB] status persist failed for PO " + (po.po_number || po.id), e);
  }
  await logEvent(supabase, {
    level: levelFor(result),
    source: "qb-sales-order",
    action: action || null, // 'create' | 'update'
    message:
      `PO ${po.po_number || po.id}: ${action || "sync"} → ${result}` +
      (error ? ` — ${error}` : ""),
    details: { po_id: po.id || null, so_ref: soRef || null, result, error: error || null },
    poNumber: po.po_number || null,
  });
}

/**
 * Run `worker(item, index)` over items with bounded concurrency. Resolves to an
 * array of results in the original order. `worker` should handle its own errors
 * (a throw rejects the whole run). onProgress(done, total) fires as each settles.
 */
export async function runPool(items, worker, { concurrency = 4, onProgress } = {}) {
  const list = items || [];
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await worker(list[i], i);
      done++;
      if (typeof onProgress === "function") onProgress(done, list.length);
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/**
 * Default in-flight requests for a bulk QB batch. QuickBooks serializes writes,
 * so this stays modest — enough to keep the connector's job queue fed without
 * piling up dozens of outstanding qbXML jobs.
 */
export const QB_SYNC_CONCURRENCY = 4;
