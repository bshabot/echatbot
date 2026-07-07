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

// Flags (Kevin 7/6): a flag = NOT SHIPPED with the cancel date closing in.
//   not shipped & past cancel        → LATE
//   not shipped & ≤5d before cancel  → NEED EXTENSION
//   not shipped & ≤21d (3wk) before  → NUDGE
// Once goods are moving, the flag clears — flags only ever mean "still at the
// factory and the window is closing". They surface ONLY in Needs attention.
export function computeFlag(s) {
  if (s.status === "closed") return null;
  if (isMoving(s)) return FLAGS.ON_TRACK; // shipped — no flag
  const dueDays = daysUntil(dueDateOf(s));
  if (dueDays == null) return FLAGS.ON_TRACK;
  if (dueDays < 0) return FLAGS.LATE;
  if (dueDays <= 5) return FLAGS.NEED_EXTENSION;
  if (dueDays <= 21) return FLAGS.NUDGE;
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

// Stages (Kevin 7/6 v1.1) mirroring the physical flow:
//   ordered    → nothing shipped yet
//   hong_kong  → factory shipped (quick-ship stamp), cartons at/heading to
//                Grandways HK. Inah (route='direct') skips this stage.
//   in_transit → left HK (hk_departed_at) or direct-shipped — on the way to us
//   closed     → shipped out / done
export function stageOf(s) {
  if (s.status === "closed") return "closed";
  if (s.factory_shipped_at || s.hk_arrived_at) {
    if (s.route === "direct") return "in_transit";
    return s.hk_departed_at ? "in_transit" : "hong_kong";
  }
  return "ordered";
}

export const STAGE_LABELS = {
  ordered: "Ordered",
  hong_kong: "Hong Kong",
  in_transit: "In transit",
  closed: "CLOSED",
};

// Quick-ship parser — smooth mode, no ":" needed:
//   "12770 3 12771 2"      → alternating PO / boxes
//   "12770:3 12772x4"      → still accepted
// A token is a PO if it has letters (12382A) or is a number ≥ 1000; a small
// number (< 1000) is the box count for the PO before it. Vendor POs are
// always 4+ digits, box counts never are — so the two can't collide.
export function parseQuickShip(text) {
  const entries = [];
  const bad = [];
  let pending = null; // a PO still waiting for its box count
  const flushPending = () => {
    if (pending) bad.push(`${pending} (no box count)`);
    pending = null;
  };
  for (const tok of String(text || "").trim().split(/[\s,;]+/)) {
    if (!tok) continue;
    const m = tok.match(/^([A-Za-z0-9-]+)[:xX](\d+)$/);
    if (m) {
      flushPending();
      entries.push({ vendorPo: m[1], boxes: parseInt(m[2], 10) });
      continue;
    }
    const isSmallNumber = /^\d{1,3}$/.test(tok);
    if (isSmallNumber && pending) {
      entries.push({ vendorPo: pending, boxes: parseInt(tok, 10) });
      pending = null;
    } else if (/^[A-Za-z0-9-]+$/.test(tok) && !isSmallNumber) {
      flushPending();
      pending = tok;
    } else {
      flushPending();
      bad.push(tok);
    }
  }
  flushPending();
  return { entries, bad };
}

// the date to display for "shipped" — first signal we have
export function shippedDateOf(s) {
  return s.factory_shipped_at || s.hk_arrived_at || null;
}
