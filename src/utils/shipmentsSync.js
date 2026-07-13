// LIVE: the real shipments table.
export const SHIPMENTS_TABLE = "shipments";

// shipmentsSync.js — keeps the board honest against Signet's scraped POs.
//
// Model (Kevin 7/7, dates amended 7/13): the QuickBooks PO export creates
// board rows and links. Signet's scraped POs now do TWO things here:
//   1. DATES — Signet ship/cancel dates are king (extensions land in Signet,
//      not QB — stale QB dates were throwing false NEED-TO-SHIP flags).
//      Open linked rows get ship_date/due_date refreshed on every sync.
//   2. MEMO CHECK — when an SO is in transit, read its memo to see what is
//      and isn't shipped. Findings only.

import { parseMemo } from "./shipmentMemoParser";

export async function syncShipmentsFromPOs(supabase) {
  const summary = { checkedSOs: 0, findings: [], errors: [], datesFixed: 0 };

  const { data: rows, error } = await supabase
    .from(SHIPMENTS_TABLE)
    .select("id, vendor_po, signet_po_number, vendor, status, route, ship_date, due_date, factory_shipped_at, hk_arrived_at, hk_departed_at, received_confirmed_at, deleted_at");
  if (error) {
    summary.errors.push("read shipments: " + error.message);
    return summary;
  }
  const live = (rows ?? []).filter((r) => !r.deleted_at);

  // every open linked row gets its dates checked; memo check stays
  // in-transit only
  const openLinked = live.filter((r) => r.status === "open" && r.signet_po_number);
  const openSOs = new Set(openLinked.map((r) => String(r.signet_po_number)));
  const transitSOs = new Set(
    live
      .filter((r) => r.status === "open" && stageOf(r) === "in_transit" && r.signet_po_number)
      .map((r) => String(r.signet_po_number))
  );
  if (openSOs.size === 0) return summary;

  const { data: pos, error: e2 } = await supabase
    .from("running_line_purchase_orders")
    .select("po_number, memo, ship_date, due_date")
    .eq("direction", "forward")
    .in("po_number", [...openSOs]);
  if (e2) {
    summary.errors.push("read Signet POs: " + e2.message);
    return summary;
  }

  // 1) Signet dates are king — refresh rows whose window drifted (extensions)
  const poByNumber = new Map((pos ?? []).map((p) => [String(p.po_number), p]));
  for (const r of openLinked) {
    const po = poByNumber.get(String(r.signet_po_number));
    if (!po || (!po.ship_date && !po.due_date)) continue;
    const ship = po.ship_date || r.ship_date;
    // cancel: never auto-shorten — the LATER date wins, so an extension typed
    // anywhere (Sales Orders tab, QB) survives a stale Signet scrape
    const due = po.due_date && (!r.due_date || po.due_date > r.due_date) ? po.due_date : r.due_date;
    if (ship === r.ship_date && due === r.due_date) continue;
    const { error: e3 } = await supabase
      .from(SHIPMENTS_TABLE)
      .update({ ship_date: ship, due_date: due, updated_at: new Date().toISOString() })
      .eq("id", r.id);
    if (e3) summary.errors.push(`dates ${r.vendor_po}: ${e3.message}`);
    else summary.datesFixed++;
  }

  const bySO = new Map();
  for (const r of live) {
    const k = String(r.signet_po_number || "");
    if (!k) continue;
    if (!bySO.has(k)) bySO.set(k, []);
    bySO.get(k).push(r);
  }

  // 2) memo check — in-transit SOs only
  for (const po of pos ?? []) {
    if (!transitSOs.has(String(po.po_number))) continue;
    summary.checkedSOs++;
    const parsed = parseMemo(po.memo);
    if (parsed.entries.length === 0) continue;
    const boardPos = bySO.get(String(po.po_number)) || [];
    for (const e of parsed.entries) {
      const match = boardPos.find(
        (b) => String(b.vendor_po).toLowerCase() === String(e.vendorPo).toLowerCase()
      );
      if (!match) {
        summary.findings.push(`SO ${po.po_number}: memo lists ${e.vendorPo} (${e.vendor}) — not on the board`);
      } else if (match.status === "open" && stageOf(match) === "ordered") {
        summary.findings.push(`SO ${po.po_number}: ${e.vendorPo} (${match.vendor || e.vendor}) — not shipped`);
      }
    }
  }

  return summary;
}

// ---- flag engine: ONE flag only (Kevin 7/7) ----
export const FLAGS = {
  NEED_TO_SHIP: "need_to_ship",
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
// Cancel date: the LATER of Signet vs QB wins — an extension lands in
// whichever system got it first (Signet scrape, or typed on the QB sales
// order and imported), and the board honors it either way.
export function dueDateOf(s) {
  const a = s.due_date;
  const b = s.qb_due_date;
  if (a && b) return a >= b ? a : b; // ISO date strings compare fine
  return a || b || null;
}
export function amountOf(s) {
  return s.qb_amount ?? s.amount ?? null;
}

// One flag: NEED TO SHIP — not shipped and the cancel date is within 3 weeks
// (or already past). The moment goods move, it clears. Surfaces ONLY in
// Needs attention.
export function computeFlag(s) {
  if (s.status === "closed") return null;
  if (isMoving(s)) return FLAGS.ON_TRACK; // shipped — no flag
  const dueDays = daysUntil(dueDateOf(s));
  if (dueDays == null) return FLAGS.ON_TRACK;
  if (dueDays <= 21) return FLAGS.NEED_TO_SHIP;
  return FLAGS.ON_TRACK;
}

// board visibility: open AND (within 4wks of ship OR already moving OR flagged)
export function isOnBoard(s) {
  if (s.status !== "open") return false;
  const shipDays = daysUntil(shipDateOf(s));
  if (computeFlag(s) === FLAGS.NEED_TO_SHIP) return true;
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
