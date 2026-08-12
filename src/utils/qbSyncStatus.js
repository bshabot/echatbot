// src/utils/qbSyncStatus.js
//
// Durable QuickBooks sync status + process tracking, shared by every QB
// operation in qbSalesOrders.js and qbPoImport.js. Three concerns:
//   - persistSyncResult: stamp a PO row's qb_* columns AND write a general
//     sync_logs entry (via logEvent) after every attempt, so "what was created
//     vs synced, and when" and "what failed and why" survive a reload — and a
//     re-run can skip what's done. Per-RECORD detail (one row per PO).
//   - trackQbProcess: wrap a whole QB operation (checking, sending, syncing —
//     not just the bulk send) in the global QbSyncJobStore, with a paired
//     start/finish sync_logs entry. Per-OPERATION detail (one row per click).
//   - runPool: bounded-concurrency runner so a bulk batch isn't strictly serial
//     (several requests in flight at once), while still reporting progress.
//
// All three are best-effort about their own failures: recording a result must
// never be what breaks the sync it is recording.

import { logEvent } from "./logEvent";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";

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
 * Run `worker(item, index)` over items with bounded concurrency. Resolves to
 * `{ results, cancelled }` — `results` in the original order (unstarted slots
 * left `undefined` when cancelled). `worker` should handle its own errors (a
 * throw rejects the whole run). onProgress(done, total) fires as each settles.
 *
 * `shouldCancel()` — if provided, checked before starting each new item (not
 * mid-item), so a Stop request halts new dispatches while whatever's already
 * in flight finishes and gets persisted normally. That's what makes Stop safe
 * mid-batch: nothing already-launched is aborted, only the queue is drained.
 */
export async function runPool(items, worker, { concurrency = 4, onProgress, shouldCancel } = {}) {
  const list = items || [];
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  let cancelled = false;
  async function lane() {
    for (;;) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        cancelled = true;
        return;
      }
      const i = next++;
      if (i >= list.length) return;
      results[i] = await worker(list[i], i);
      done++;
      if (typeof onProgress === "function") onProgress(done, list.length);
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: lanes }, lane));
  return { results, cancelled };
}

/**
 * Default in-flight requests for a bulk QB batch. QuickBooks serializes writes,
 * so this stays modest — enough to keep the connector's job queue fed without
 * piling up dozens of outstanding qbXML jobs.
 */
export const QB_SYNC_CONCURRENCY = 4;

/**
 * Wrap ANY QuickBooks operation (checking, sending, syncing memos — not just
 * the bulk send) so it reports into the global QbSyncJobStore and leaves a
 * paired start/finish row in sync_logs. This is what makes "nothing runs
 * only on the page" true: every exported qbSalesOrders.js / qbPoImport.js
 * function that talks to QuickBooks goes through this, so the floating
 * widget (and the log) sees every process, not just bulk creates/updates.
 *
 * `run(procId)` does the real work and returns exactly what the caller's
 * function should return — this never changes a return shape, it only
 * observes. Inside `run`, use `useQbSyncJobStore.getState().updateProcess(procId, {...})`
 * for progress and `useQbSyncJobStore.getState().shouldCancel(procId)` to
 * check for a Stop request.
 *
 * `summarize(result)` -> `{ status, message, summary }` lets each call site
 * describe its own outcome (status: 'done' | 'cancelled' | 'error') without
 * this helper needing to know every function's return shape. Omit it to get
 * a generic "Finished: <label>" success entry.
 *
 * `retry` (optional) — a zero-arg function that re-runs this exact call with
 * the same arguments (call sites pass e.g. `() => thisFunction(sameArgs)`,
 * which works because a named exported function can reference itself). Only
 * pass this when re-running from scratch is actually safe to replay blindly
 * — every ensureXxx in qbClient.js checks state before writing, so most
 * operations qualify. Leave it out for the multi-phase sales-order
 * create/update send flows: retrying those with a stale `prepared` list
 * could resend items that already went through before a Stop/failure — those
 * route through the Purchase Orders resume flow instead, which re-checks
 * live QuickBooks state first. Only lives for this browser tab's JS context
 * — gone the moment a process rehydrates as "interrupted".
 *
 * `initiator` (optional) — the plain-data args this call needs to be re-run
 * (e.g. `{ samples }`, `{ rows }`, `{ costView }`) — NOT settings/vendors/
 * supabase, which qbRetryRegistry.js pulls fresh at retry time instead of
 * freezing a stale snapshot. Same safety rule as `retry`: only set this on
 * operations that are safe to blind-replay. Unlike `retry`, this is plain
 * JSON, so it survives the persist round-trip — it's what lets an
 * "interrupted" card (post-reload) offer one-click Retry too, via
 * qbRetryRegistry.js, instead of only "Go to <page>".
 *
 * On throw: the process is marked "error", a failure row is logged, and the
 * error is re-thrown so the caller's existing try/catch still runs.
 */
export async function trackQbProcess(
  supabase,
  { type, label, total = 0, poIds = [], source, action, retry, initiator },
  run,
  summarize
) {
  const store = useQbSyncJobStore.getState();
  const procId = store.startProcess({ type, label, total, poIds, retry, initiator });
  await logEvent(supabase, {
    level: "info",
    source,
    action,
    message: `Started: ${label}`,
    details: { total, poIds },
  });
  try {
    const result = await run(procId);
    const s = (typeof summarize === "function" && summarize(result)) || {};
    store.finishProcess(procId, { status: s.status || "done", summary: s.summary ?? null });
    await logEvent(supabase, {
      level: s.status === "error" ? "error" : "success",
      source,
      action,
      message: s.message || `Finished: ${label}`,
      details: s.summary ?? null,
    });
    return result;
  } catch (e) {
    store.finishProcess(procId, { status: "error" });
    await logEvent(supabase, {
      level: "error",
      source,
      action,
      message: `Failed: ${label} — ${e?.message || e}`,
    });
    throw e;
  }
}
