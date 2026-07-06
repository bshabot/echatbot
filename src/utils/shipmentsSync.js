// TEST MODE: all reads/writes go to shipments_test. Flip to "shipments" to go live.
export const SHIPMENTS_TABLE = "shipments_test";

// shipmentsSync.js — build/refresh the shipments board from running_line_purchase_orders.
// Reads forward Signet POs, parses memos into vendor-PO rows, upserts into `shipments`.
// NEVER clobbers hand-entered fields (stamps, tracking, counts, notes, status, route).
// Safe to run any time (the "Refresh from POs" button calls this).

import { parseMemo, defaultRouteForVendor } from "./shipmentMemoParser";

// Fields the sync owns (refreshed every run so extensions/date-moves flow through):
//   signet_po_id, signet_po_number, ship_date, due_date, amount,
//   vendor/vendor_code/memo_note (only while link_source === 'auto')
// Fields humans own (sync must never touch after insert):
//   status, route, factory_shipped_at, leg1_tracking, hk_arrived_at, carton_count,
//   inbound_master_id, received_confirmed_at, target_ship_date, notes,
//   link_source (once 'manual'), vendor (once manually linked)

export async function syncShipmentsFromPOs(supabase) {
  const summary = { scanned: 0, created: 0, updated: 0, needsLink: [], errors: [] };

  const { data: pos, error } = await supabase
    .from("running_line_purchase_orders")
    .select("id, po_number, po_date, ship_date, due_date, memo, total_amount, direction")
    .eq("direction", "forward");
  if (error) {
    summary.errors.push("read POs: " + error.message);
    return summary;
  }

  // Only POs with real dates surface (junk/pricing POs have none) — locked decision.
  const dated = (pos ?? []).filter((p) => p.ship_date && p.due_date);
  summary.scanned = dated.length;

  const { data: existingRows, error: exErr } = await supabase
    .from(SHIPMENTS_TABLE)
    .select("id, vendor_po, link_source, signet_po_number");
  if (exErr) {
    summary.errors.push("read shipments: " + exErr.message);
    return summary;
  }
  const existing = new Map((existingRows ?? []).map((r) => [r.vendor_po, r]));

  for (const po of dated) {
    const parsed = parseMemo(po.memo);

    // Unparseable / partially-parseable memo -> surface the PO itself once as a
    // needs_link placeholder row keyed by the Signet PO number, so a human can
    // attach the right vendor PO(s) via the Link dialog.
    if (parsed.entries.length === 0) {
      const placeholderKey = `PO ${po.po_number}`;
      if (!existing.has(placeholderKey)) {
        const { error: insErr } = await supabase.from(SHIPMENTS_TABLE).insert({
          vendor_po: placeholderKey,
          signet_po_id: po.id,
          signet_po_number: po.po_number,
          ship_date: po.ship_date,
          due_date: po.due_date,
          amount: po.total_amount,
          link_source: "needs_link",
          memo_note: po.memo ? String(po.memo).slice(0, 120) : null,
        });
        if (insErr) summary.errors.push(`insert ${placeholderKey}: ` + insErr.message);
        else {
          summary.created++;
          summary.needsLink.push(placeholderKey);
        }
      }
      continue;
    }

    for (const entry of parsed.entries) {
      const row = existing.get(entry.vendorPo);
      const note = [
        ...parsed.notes,
        ...(parsed.unresolved.length ? ["unparsed: " + parsed.unresolved.join(", ")] : []),
      ].join("; ") || null;

      if (!row) {
        const { error: insErr } = await supabase.from(SHIPMENTS_TABLE).insert({
          vendor_po: entry.vendorPo,
          signet_po_id: po.id,
          signet_po_number: po.po_number,
          vendor: entry.vendor,
          vendor_code: entry.vendorCode,
          ship_date: po.ship_date,
          due_date: po.due_date,
          amount: po.total_amount,
          route: defaultRouteForVendor(entry.vendor),
          link_source: "auto",
          memo_note: note,
        });
        if (insErr) summary.errors.push(`insert ${entry.vendorPo}: ` + insErr.message);
        else summary.created++;
      } else {
        // refresh sync-owned fields only; respect manual links
        const patch = {
          signet_po_id: po.id,
          signet_po_number: po.po_number,
          ship_date: po.ship_date,
          due_date: po.due_date,
          amount: po.total_amount,
          updated_at: new Date().toISOString(),
        };
        if (row.link_source === "auto") {
          patch.vendor = entry.vendor;
          patch.vendor_code = entry.vendorCode;
          patch.memo_note = note;
        }
        const { error: upErr } = await supabase
          .from(SHIPMENTS_TABLE)
          .update(patch)
          .eq("id", row.id);
        if (upErr) summary.errors.push(`update ${entry.vendorPo}: ` + upErr.message);
        else summary.updated++;
      }
    }

    // partially-parsed memo (some tokens unresolved) -> also surface for linking
    if (parsed.unresolved.length > 0) {
      summary.needsLink.push(`PO ${po.po_number}: ${parsed.unresolved.join(", ")}`);
    }
  }

  return summary;
}

// ---- flag engine (decisions #5/#6/#20/#21 — clocks unchanged) ----
export const FLAGS = {
  LATE: "late",
  NEED_EXTENSION: "need_extension",
  NUDGE: "nudge",
  ON_TRACK: "on_track",
};

const DAY = 24 * 60 * 60 * 1000;

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / DAY);
}

// "moving" = goods have left the factory as far as we can tell: cartons are at
// Dominic's (HK), on an inbound master, or already received. This stops the
// nudge/extension clock. (7/2: separate Factory-shipped stamp dropped — the
// At-HK confirm is the first stamp and carries box counts + tracking.)
function isMoving(s) {
  return !!(s.hk_arrived_at || s.inbound_master_id || s.received_confirmed_at || s.factory_shipped_at);
}

// Date precedence: Signet-scraped dates are king; manual target date next;
// QuickBooks dates (from the QB PO import) are the fallback — they're what
// makes verbal/pre-SO POs alert correctly. Same idea for dollars: the QB
// per-vendor-PO amount is exact, the parent total is a proxy.
export function shipDateOf(s) {
  return s.ship_date || s.target_ship_date || s.qb_ship_date || null;
}
export function dueDateOf(s) {
  return s.due_date || s.qb_due_date || null;
}
export function amountOf(s) {
  return s.qb_amount ?? s.amount ?? null;
}

export function computeFlag(s) {
  if (s.status === "closed") return null;
  const dueDays = daysUntil(dueDateOf(s));
  const shipDays = daysUntil(shipDateOf(s));
  const moving = isMoving(s);

  if (dueDays != null && dueDays < 0) return FLAGS.LATE; // past cancel date, not closed
  if (!moving && shipDays != null && shipDays <= 5) return FLAGS.NEED_EXTENSION;
  if (!moving && shipDays != null && shipDays <= 21) return FLAGS.NUDGE;
  return FLAGS.ON_TRACK;
}

// board visibility: open AND (within 4wks of ship OR already moving OR flagged)
export function isOnBoard(s) {
  if (s.status !== "open") return false;
  const shipDays = daysUntil(shipDateOf(s));
  const flag = computeFlag(s);
  if (flag === FLAGS.LATE || flag === FLAGS.NEED_EXTENSION) return true;
  if (isMoving(s)) return true;
  if (shipDays != null && shipDays <= 28) return true;
  return false;
}

// v2 SIMPLE (7/2): three stages only — a PO is ordered, shipped (any signal
// that goods left: shipped-stamp, HK confirm, on a tracked shipment, or an old
// received stamp), or closed. Legacy stamp columns still count as "shipped".
export function stageOf(s) {
  if (s.status === "closed") return "closed";
  if (isMoving(s)) return "shipped";
  return "ordered";
}

export const STAGE_LABELS = {
  ordered: "Ordered",
  shipped: "Shipped",
  closed: "CLOSED",
  // legacy keys kept so old references render sanely
  at_hk: "Shipped",
  inbound: "Shipped",
  received: "Shipped",
};

// the date to display for "shipped" — first signal we have
export function shippedDateOf(s) {
  return s.factory_shipped_at || s.hk_arrived_at || null;
}
