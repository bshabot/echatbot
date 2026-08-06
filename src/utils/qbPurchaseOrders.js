// qbPurchaseOrders.js — push the Factory Costs page's computed unit cost onto
// the matching QuickBooks PURCHASE ORDER lines (our PO to the factory).
//
// Not to be confused with the sales-order path (qbSalesOrders.js), which
// prices what we bill Signet. This one prices what the factory bills US.
//
// The chain, worked out against real data:
//   Factory Costs row  ->  Signet PO (e.g. 169632) + vendor ("Aoxin Jewelry")
//   costView           ->  the vendor PO in QB      (e.g. 12851)
//   QB PO lines        ->  matched to rows by style (ITEM = "N498E-NEW")
//   write              ->  that line's Rate = the row's computed unit cost
//
// The vendor PO is NOT looked up again here. The page already resolved it at
// load (soVendorsByPo, from shipments) and shows it in the "Vendor SOs"
// column — "12851 Aoxin · 12850 Amtai". Re-deriving it would risk repricing a
// PO the user never saw; this way what gets written is what's on screen.
//
// Verified on the board 8/6: 247 Signet-PO+vendor pairs, 246 resolve to
// exactly one vendor PO. The 1 that doesn't is REPORTED, never guessed.
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
 * Group priced Factory Costs rows into one unit of work per (Signet PO,
 * vendor) — which is exactly how the page already renders them, and how the
 * factory POs are actually cut.
 */
export function groupRowsForPoUpdate(costView) {
  const groups = [];
  for (const so of costView?.sos || []) {
    for (const v of so.vendors || []) {
      const rows = (v.rows || []).filter((r) => r && r.model && r.unit != null);
      if (!rows.length) continue;
      groups.push({
        signetPo: String(so.po),
        vendorLabel: v.label,
        // the same numbers the Vendor SOs column renders
        vendorPos: (v.soNumbers || []).map(String),
        rows,
        expectedTotal: rows.reduce(
          (s, r) => s + Number(r.unit) * Number(r.order_qty || 0),
          0
        ),
      });
    }
  }
  return groups;
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
  { settings, onProgress } = {}
) {
  const out = { prepared: [], skipped: [], errors: [], enabled: true };
  if (!isQbEnabled(settings)) {
    return { ...out, enabled: false, errors: ["QuickBooks integration is off"] };
  }

  const groups = groupRowsForPoUpdate(costView);
  if (!groups.length) {
    out.errors.push("Nothing priced yet — hit Price it first");
    return out;
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const label = `SO ${g.signetPo} · ${g.vendorLabel}`;
    const vendorPos = g.vendorPos;

    if (!vendorPos.length) {
      out.skipped.push({ label, reason: "no vendor PO yet — the Vendor SOs column is empty for this one" });
    } else if (vendorPos.length > 1) {
      // 1 pair in 247 hits this. Picking one would silently reprice the wrong
      // factory PO, so it stops here and asks.
      out.skipped.push({
        label,
        reason: `links to ${vendorPos.length} vendor POs (${vendorPos.join(", ")}) — pick one manually`,
      });
    } else {
      const vendorPo = vendorPos[0];
      try {
        const existing = await findPurchaseOrder(vendorPo);
        if (!existing) {
          out.skipped.push({ label, reason: `PO ${vendorPo} not found in QuickBooks` });
        } else {
          const { matches, unmatchedRows, orphanQbLines } = matchPoLinesToCostRows(
            existing,
            g.rows
          );
          const lines = [];
          const changes = [];
          for (const { row, qbLine } of matches) {
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
          if (!lines.length) {
            // "nothing to send" has three very different causes and they must
            // NOT all read as success — that's how a sync looks like it worked
            // while changing nothing.
            let reason;
            if (!(existing.lines || []).length) {
              reason = `PO ${vendorPo} came back from QuickBooks with no line items — nothing to match against`;
            } else if (!matches.length) {
              reason =
                `no line on PO ${vendorPo} matches these styles (` +
                g.rows.map((r) => r.model).slice(0, 5).join(", ") +
                `) — its lines are: ` +
                (existing.lines || []).map((l) => l.item).slice(0, 5).join(", ");
            } else {
              reason = `PO ${vendorPo} already matches the computed costs`;
            }
            out.skipped.push({ label, reason });
          } else {
            out.prepared.push({
              label,
              signetPo: g.signetPo,
              vendorLabel: g.vendorLabel,
              vendorPo,
              payload: { lines },
              changes,
              // surfaced in the preview so nothing is a surprise
              rowsWithNoPoLine: unmatchedRows.map((r) => r.model),
              poLinesLeftAlone: orphanQbLines.map((l) => l.item),
            });
          }
        }
      } catch (e) {
        out.errors.push(`${label}: ` + (e?.message || String(e)));
      }
    }
    if (typeof onProgress === "function") onProgress(i + 1, groups.length);
  }
  return out;
}

/** PHASE 2 — send exactly what was previewed. */
export async function sendPreparedPoUpdates(prepared, { settings, onProgress } = {}) {
  const res = { updated: [], failed: [] };
  if (!isQbEnabled(settings)) return { ...res, enabled: false };

  const list = prepared || [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      await updatePurchaseOrder(p.vendorPo, p.payload);
      res.updated.push({ label: p.label, vendorPo: p.vendorPo, lines: p.payload.lines.length });
    } catch (e) {
      res.failed.push({ label: p.label, vendorPo: p.vendorPo, error: e?.message || String(e) });
    }
    if (typeof onProgress === "function") onProgress(i + 1, list.length);
  }
  return res;
}

/** One-line summary for the confirm dialog. */
export function summarizePoUpdate(p) {
  const n = p.changes.length;
  return `PO ${p.vendorPo} (${p.vendorLabel}) — ${n} line${n === 1 ? "" : "s"} repriced`;
}
