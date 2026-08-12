// qbPurchaseOrders.js — push the Factory Costs page's computed unit cost onto
// the matching QuickBooks PURCHASE ORDER lines (our PO to the factory).
//
// Not to be confused with the sales-order path (qbSalesOrders.js), which
// prices what we bill Signet. This one prices what the factory bills US.
//
// What it does, end to end:
//   1. take the vendor PO numbers off the priced sales orders (12851, 12850)
//   2. read each PO from QuickBooks with its lines
//   3. match each line to a priced row by STYLE (ITEM = "N498E-NEW")
//   4. PATCH that line's Rate to the row's computed unit cost
//
// That's the whole thing. No vendor pairing, no per-sales-order routing — the
// sales order is only where the PO numbers are listed. Kevin 8/6: "take 12851
// and match the line items then update the cost... po number match line item
// update cost."
//
// Dropping vendor from the match also dodged a real mismatch: the board
// stores short names ("CIJ") while the PLM stores QB payees ("China Ideal
// Jewellry Co, Ltd"), which share no substring — so any vendor-based pairing
// silently failed for 39 of the board's rows.
//
// Deliberate non-goals:
//   - Header fields are never touched (Kevin 8/6: no lock date on the PO).
//   - A QB line whose style isn't in the priced set is left alone, NOT zeroed.
//   - Nothing is ever deleted, and no line is ever appended: a PO line that
//     doesn't exist in QB is a data question for a human, not something to
//     invent from a cost sheet.
//
// GATED: no QuickBooks call unless options.qbIntegration.enabled is true.

import { isQbEnabled, findPurchaseOrder, updatePurchaseOrder } from "./qbClient";
import { trackQbProcess } from "./qbSyncStatus";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";

// Both phases below are wrapped in qbSyncStatus.js's trackQbProcess(), same
// as every other QB-calling function in the app — so the Factory Costs
// page's "Update prices in QB" button reports into the global
// QbSyncJobStore (with Stop support) and leaves a start/finish row in
// sync_logs, instead of the page tracking busy/progress on its own.

const normKey = (v) => String(v ?? "").trim().toLowerCase();

/** QuickBooks stores PO cost to 5 decimals (your 12851 line reads 7.5344).
 * Rounding to 2 here would quietly change the PO total, so keep the precision
 * and only clamp the float dust that shows up after multiplying metal weights. */
export function toQbCost(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(5));
}

/**
 * Everything the reprice needs, flattened: every priced row on screen, and
 * every vendor PO number those sales orders point at. Nothing is grouped.
 */
export function collectForPoUpdate(costView) {
  const rows = [];
  const vendorPos = [];
  for (const so of costView?.sos || []) {
    for (const v of so.vendors || []) {
      for (const r of v.rows || []) {
        if (r && r.model && r.unit != null) rows.push(r);
      }
    }
    for (const ref of so.vendorPos || []) {
      const s = String(ref);
      if (s && !vendorPos.includes(s)) vendorPos.push(s);
    }
  }
  return { rows, vendorPos };
}

/**
 * Match a QB purchase order's lines to priced rows by style number.
 * Mirrors matchSoLinesToPlmLines: a QB line is consumed once matched, so a
 * style appearing twice on one PO can't be claimed by the same row twice.
 */
export function matchPoLinesToCostRows(existingPo, rows) {
  const qbLines = (existingPo?.lines || []).filter((l) => l && l.txn_line_id);
  const byItem = new Map();
  for (const l of qbLines) {
    const it = normKey(l.item);
    if (!it) continue;
    if (!byItem.has(it)) byItem.set(it, []);
    byItem.get(it).push(l);
  }
  const consumed = new Set();
  const take = (bucket) => {
    if (!bucket) return null;
    for (const l of bucket) if (!consumed.has(l.txn_line_id)) return l;
    return null;
  };

  const matches = [];
  const unmatchedRows = [];
  for (const r of rows) {
    const hit = take(byItem.get(normKey(r.model)));
    if (!hit) {
      unmatchedRows.push(r);
      continue;
    }
    consumed.add(hit.txn_line_id);
    matches.push({ row: r, qbLine: hit });
  }
  return {
    matches,
    unmatchedRows,
    orphanQbLines: qbLines.filter((l) => !consumed.has(l.txn_line_id)),
  };
}

/**
 * PHASE 1 — read QuickBooks, compute every change, write NOTHING.
 * The preview the user approves is the exact payload phase 2 sends, so the
 * two can't disagree (same pattern as the sales-order batch update).
 */
export async function prepareFactoryCostPoUpdates(
  costView,
  { settings, onProgress, supabase } = {}
) {
  if (!isQbEnabled(settings)) {
    return { prepared: [], skipped: [], errors: ["QuickBooks integration is off"], enabled: false };
  }

  const { rows, vendorPos } = collectForPoUpdate(costView);
  if (!rows.length) {
    return { prepared: [], skipped: [], errors: ["Nothing priced yet — hit Price it first"], enabled: true };
  }
  if (!vendorPos.length) {
    return {
      prepared: [],
      skipped: [],
      errors: ["No vendor PO on the selected sales order(s) — the Vendor SOs column is empty"],
      enabled: true,
    };
  }

  return trackQbProcess(
    supabase,
    {
      type: "po-price-prepare",
      label: `Checking ${vendorPos.length} factory PO${vendorPos.length === 1 ? "" : "s"} against computed costs`,
      total: vendorPos.length,
      poIds: vendorPos.map(String),
      source: "qb-purchase-order",
      action: "price-prepare",
      // Read-only — always safe to blind-retry.
      retry: () => prepareFactoryCostPoUpdates(costView, { settings, onProgress, supabase }),
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const out = { prepared: [], skipped: [], errors: [], enabled: true, cancelled: false };

      // A row is claimed once. If the same style sits on two POs, the first PO
      // read takes it rather than both being repriced from one row.
      const claimedRows = new Set();

      for (let i = 0; i < vendorPos.length; i++) {
        if (store.shouldCancel(procId)) {
          out.cancelled = true;
          break;
        }
        const ref = vendorPos[i];
        try {
          const po = await findPurchaseOrder(ref);
          if (!po) {
            out.skipped.push({ label: `PO ${ref}`, reason: "not found in QuickBooks" });
          } else {
            const available = rows.filter((r) => !claimedRows.has(r));
            const { matches, orphanQbLines } = matchPoLinesToCostRows(po, available);

            const lines = [];
            const changes = [];
            for (const { row, qbLine } of matches) {
              claimedRows.add(row);
              const next = toQbCost(row.unit);
              if (next == null) continue;
              const cur = Number(qbLine.rate);
              if (Number.isFinite(cur) && Math.abs(cur - next) < 0.000005) continue; // already right
              // string, not number — the connector's OrderLineEdit is `str | None`
              lines.push({ txn_line_id: qbLine.txn_line_id, rate: String(next) });
              changes.push({
                item: qbLine.item,
                qty: qbLine.quantity ?? row.order_qty ?? null,
                from: Number.isFinite(cur) ? cur : null,
                to: next,
              });
            }

            if (lines.length) {
              out.prepared.push({
                label: `PO ${ref}`,
                vendorPo: ref,
                payload: { lines },
                changes,
                poLinesLeftAlone: orphanQbLines.map((l) => l.item),
              });
            } else {
              // "nothing to send" has three very different causes and they must
              // NOT all read as success — that's how a sync looks like it worked
              // while changing nothing.
              let reason;
              if (!(po.lines || []).length) {
                reason = "came back from QuickBooks with no line items — nothing to match against";
              } else if (!matches.length) {
                reason =
                  "no line matches the priced styles — its lines are: " +
                  (po.lines || []).map((l) => l.item).slice(0, 6).join(", ");
              } else {
                reason = "already matches the computed costs";
              }
              out.skipped.push({ label: `PO ${ref}`, reason });
            }
          }
        } catch (e) {
          out.errors.push(`PO ${ref}: ` + (e?.message || String(e)));
        }
        store.updateProcess(procId, { done: i + 1, total: vendorPos.length, phase: "Checking QuickBooks" });
        if (typeof onProgress === "function") onProgress(i + 1, vendorPos.length);
      }

      const leftover = rows.filter((r) => !claimedRows.has(r));
      if (leftover.length) {
        out.skipped.push({
          label: "Priced but on no PO line",
          reason: leftover.map((r) => r.model).join(", "),
        });
      }

      return out;
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `${result.prepared.length} PO(s) ready to reprice, ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
      summary: { prepared: result.prepared.length, skipped: result.skipped.length, errors: result.errors.length },
    })
  );
}

/** PHASE 2 — send exactly what was previewed. */
export async function sendPreparedPoUpdates(prepared, { settings, onProgress, supabase } = {}) {
  if (!isQbEnabled(settings)) return { updated: [], failed: [], enabled: false };

  const list = prepared || [];
  return trackQbProcess(
    supabase,
    {
      type: "po-price-send",
      label: `Repricing ${list.length} factory PO${list.length === 1 ? "" : "s"} in QuickBooks`,
      total: list.length,
      poIds: list.map((p) => p?.vendorPo).filter(Boolean).map(String),
      source: "qb-purchase-order",
      action: "price-send",
      // Safe to blind-retry: each line PATCH sets a rate to the same target
      // value either way, so replaying an already-sent line is a no-op.
      retry: () => sendPreparedPoUpdates(prepared, { settings, onProgress, supabase }),
    },
    async (procId) => {
      const store = useQbSyncJobStore.getState();
      const res = { updated: [], failed: [], cancelled: false };

      for (let i = 0; i < list.length; i++) {
        if (store.shouldCancel(procId)) {
          res.cancelled = true;
          break;
        }
        const p = list[i];
        try {
          await updatePurchaseOrder(p.vendorPo, p.payload);
          res.updated.push({ label: p.label, vendorPo: p.vendorPo, lines: p.payload.lines.length });
        } catch (e) {
          res.failed.push({ label: p.label, vendorPo: p.vendorPo, error: e?.message || String(e) });
        }
        store.updateProcess(procId, { done: i + 1, total: list.length, phase: "Repricing in QuickBooks" });
        if (typeof onProgress === "function") onProgress(i + 1, list.length);
      }
      return res;
    },
    (result) => ({
      status: result.cancelled ? "cancelled" : "done",
      message: `Repriced ${result.updated.length} PO(s), ${result.failed.length} failed`,
      summary: { updated: result.updated.length, failed: result.failed.length },
    })
  );
}

/** One-line summary for the confirm dialog. */
export function summarizePoUpdate(p) {
  const n = p.changes.length;
  return `PO ${p.vendorPo} — ${n} line${n === 1 ? "" : "s"} repriced`;
}
