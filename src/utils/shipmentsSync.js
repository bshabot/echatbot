// TEST MODE: all reads/writes go to shipments_test. Flip to "shipments" to go live.
export const SHIPMENTS_TABLE = "shipments_test";

// shipmentsSync.js — RECONCILE the shipments board against running_line_purchase_orders.
//
// Model (Kevin 7/6): the QuickBooks PO export is the source of truth — it's the
// ONLY thing that creates board rows (see qbPoImport.js). This sync never
// inserts; it reconciles existing rows against Signet's scraped POs:
//   - refreshes Signet-owned delivery dates (ship_date / due_date) so buyer
//     extensions flow through and flags clear themselves
//   - fills amount only when missing (QB per-PO $ stays preferred)
//   - cross-checks the Signet memo against the row's vendor PO and flags ⚠
//     disagreements — never overwrites
//   - reports Signet POs that have NO board row at all (orphans = we haven't
//     placed/recorded the factory order in QB yet)
// NEVER clobbers hand-entered fields (stamps, tracking, counts, notes, status,
// route, manual links).

import { parseMemo } from "./shipmentMemoParser";

export async function syncShipmentsFromPOs(supabase) {
  const summary = { scanned: 0, updated: 0, flagged: 0, orphanPos: [], errors: [] };

  const { data: pos, error } = await supabase
    .from("running_line_purchase_orders")
    .select("id, po_number, po_date, ship_date, due_date, memo, total_amount, direction")
    .eq("direction", "forward");
  if (error) {
    summary.errors.push("read POs: " + error.message);
    return summary;
  }

  // Only POs with real dates matter (junk/pricing POs have none).
  const dated = (pos ?? []).filter((p) => p.ship_date && p.due_date);
  summary.scanned = dated.length;
  const byPoNumber = new Map(dated.map((p) => [String(p.po_number), p]));

  const { data: rows, error: exErr } = await supabase
    .from(SHIPMENTS_TABLE)
    .select("id, vendor_po, signet_po_number, signet_po_id, link_source, memo_note, ship_date, due_date, amount, status");
  if (exErr) {
    summary.errors.push("read shipments: " + exErr.message);
    return summary;
  }

  const linkedSOs = new Set(
    (rows ?? []).map((r) => String(r.signet_po_number || "")).filter(Boolean)
  );

  for (const row of rows ?? []) {
    const po = byPoNumber.get(String(row.signet_po_number || ""));
    if (!po) continue; // no scraped Signet PO for this row (verbal/pre-SO) — QB dates carry it

    const patch = {};
    if (po.id !== row.signet_po_id) patch.signet_po_id = po.id;
    if (po.ship_date !== row.ship_date) patch.ship_date = po.ship_date;
    if (po.due_date !== row.due_date) patch.due_date = po.due_date;
    // parent PO total is only a proxy — fill it only when nothing better exists
    if (row.amount == null && po.total_amount != null) patch.amount = po.total_amount;

    // memo cross-check: if Signet's memo names vendor POs and this row's isn't
    // one of them, QB and Signet disagree → flag, human decides
    const parsed = parseMemo(po.memo);
    if (
      row.status === "open" &&
      parsed.entries.length > 0 &&
      !parsed.entries.some((e) => String(e.vendorPo) === String(row.vendor_po))
    ) {
      const note = `⚠ Signet memo lists ${parsed.entries.map((e) => e.vendorPo).join("/")}`;
      if (!String(row.memo_note || "").includes(note)) {
        patch.memo_note = [row.memo_note, note].filter(Boolean).join("; ");
        summary.flagged++;
      }
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { error: upErr } = await supabase
        .from(SHIPMENTS_TABLE)
        .update(patch)
        .eq("id", row.id);
      if (upErr) summary.errors.push(`update ${row.vendor_po}: ` + upErr.message);
      else summary.updated++;
    }
  }

  // Signet POs with no board row at all — surfaced, never inserted.
  for (const po of dated) {
    if (!linkedSOs.has(String(po.po_number))) summary.orphanPos.push(String(po.po_number));
  }

  return summary;
}

// ---- flag engine (clocks unchanged) ----
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

// "moving" = goods have left the factory as far as we can tell. This stops the
// nudge/extension clock.
function isMoving(s) {
  return !!(s.hk_arrived_at || s.inbound_master_id || s.received_confirmed_at || s.factory_shipped_at);
}

// Date precedence: Signet-scraped dates are king; manual target date next;
// QuickBooks dates are the fallback — they're what makes verbal/pre-SO POs
// alert correctly. Dollars: QB per-vendor-PO amount is exact, parent total is
// a proxy.
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

// three stages only — a PO is ordered, shipped (any signal that goods left),
// or closed. Legacy stamp columns still count as "shipped".
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
