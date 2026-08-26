// src/utils/soCoverage.js
//
// "Does every item on this Sales Order actually have a vendor PO covering
// it?" — Kevin 8/20: a Sales Order can have several factory POs split
// across vendors (see the Vendor SO glossary entry), and it's easy for a
// SKU on the Signet SO to fall through the cracks — never placed with any
// factory, or placed but not yet linked on the Shipments board. This finds
// those gaps in bulk, across every open SO on the board at once, using the
// SAME attribution logic VendorPoItemsDialog.jsx already uses for one PO at
// a time (attributeLine, in labelOrderUtils.js) — a line with no vendorLabel
// there is exactly a line with no vendor PO covering it here.
//
// This does NOT replace the shipments board's timing flag (FLAGS in
// shipmentsSync.js — "ONE flag only" by design, Kevin 7/7). Missing-item
// coverage is a different question ("is anything unordered") from timing
// ("is what WAS ordered running late"), so it's tracked separately and
// merged in as its own badge, not folded into computeFlag().
import {
  attributeLine,
  normalizeModel,
  stripModel,
  vendorLabelFor,
} from "./labelOrderUtils";

const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];
const CHUNK = 150; // stay well under PostgREST's URL/`.in()` practical limit

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bulk version of VendorPoItemsDialog's fetch+attribute, scoped to a list of
 * Signet PO numbers instead of one. Returns
 *   Map<po_number, { total, unassigned: [{sku, model, description, order_qty}], unassignedUnits }>
 * A PO with no entry (or `unassigned.length === 0`) is fully covered — every
 * live line attributes to some vendor PO on the board.
 *
 * `poNumbers` should be whatever set you actually want checked (e.g. every
 * distinct signet_po_number among open shipments rows) — this fetches
 * `signet_pos` lines ONLY for those, not the whole scraped table.
 */
export async function computeSoCoverage(supabase, poNumbers) {
  const pos = Array.from(new Set((poNumbers || []).map((p) => String(p).trim()).filter(Boolean)));
  const result = new Map();
  if (!supabase || pos.length === 0) return result;

  const [vendRes, aliasRes, sampRes, siRes] = await Promise.all([
    supabase.from("vendors").select("id, name"),
    supabase.from("model_aliases").select("alias, vendor_id"),
    supabase.from("samples").select("styleNumber, starting_info_id"),
    supabase.from("starting_info").select("id, vendor"),
  ]);
  const err = vendRes.error || aliasRes.error || sampRes.error || siRes.error;
  if (err) throw err;

  const vendorsById = {};
  for (const v of vendRes.data || []) vendorsById[v.id] = v;
  const aliasMap = {};
  for (const a of aliasRes.data || []) aliasMap[normalizeModel(a.alias)] = a.vendor_id;
  const siVendor = {};
  for (const si of siRes.data || []) siVendor[si.id] = si.vendor;
  const exactMap = {};
  const strippedMap = {};
  for (const s of sampRes.data || []) {
    if (!s.styleNumber || !s.starting_info_id) continue;
    const vId = siVendor[s.starting_info_id];
    if (!vId) continue;
    const norm = normalizeModel(s.styleNumber);
    const stripped = stripModel(s.styleNumber);
    if (!(norm in exactMap)) exactMap[norm] = vId;
    if (!(stripped in strippedMap)) strippedMap[stripped] = vId;
  }

  // signet_pos + shipments, chunked across the PO list — same shape as the
  // single-PO dialog fetch, just batched over many POs in one pass instead
  // of one round trip per PO (which is what made this impractical board-wide
  // before).
  const lineRows = [];
  const shipRows = [];
  for (const batch of chunk(pos, CHUNK)) {
    const [linesRes, shipRes] = await Promise.all([
      supabase
        .from("signet_pos")
        .select("po_number, sku, model, description, order_qty, shipped_qty, order_status, scraped_at")
        .in("po_number", batch)
        .limit(50000),
      supabase
        .from("shipments")
        .select("signet_po_number, vendor_po, vendor")
        .in("signet_po_number", batch)
        .is("deleted_at", null),
    ]);
    if (linesRes.error) throw linesRes.error;
    if (shipRes.error) throw shipRes.error;
    lineRows.push(...(linesRes.data || []));
    shipRows.push(...(shipRes.data || []));
  }

  // Dedupe to the newest scrape per (po_number, sku) — a PO gets re-scraped
  // repeatedly and only the latest snapshot is real.
  const seen = new Set();
  const lines = [];
  const sorted = [...lineRows].sort(
    (a, b) => new Date(b.scraped_at || 0) - new Date(a.scraped_at || 0)
  );
  for (const l of sorted) {
    const key = `${l.po_number}::${l.sku}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(l);
  }

  const soVendorsByPo = {};
  for (const s of shipRows) {
    if (!s.signet_po_number || !s.vendor_po) continue;
    const label = vendorLabelFor(s.vendor);
    if (!label) continue;
    const p = (soVendorsByPo[s.signet_po_number] ??= {});
    (p[label] ??= []).push(String(s.vendor_po));
  }

  const ctx = { aliasMap, exactMap, strippedMap, soVendorsByPo, vendorsById };

  for (const po of pos) {
    const poLines = lines.filter(
      (l) => String(l.po_number).trim() === po && LIVE_STATUSES.includes(l.order_status)
    );
    if (poLines.length === 0) continue; // nothing scraped for this PO yet — not our call to flag
    const attributed = poLines.map((l) => attributeLine(l, ctx));
    const unassigned = attributed.filter((l) => !l.vendorLabel);
    if (unassigned.length === 0) continue;
    result.set(po, {
      total: poLines.length,
      unassigned: unassigned.map((l) => ({
        sku: l.sku,
        model: l.model,
        description: l.description,
        order_qty: l.order_qty,
      })),
      unassignedUnits: unassigned.reduce((s, l) => s + Number(l.order_qty || 0), 0),
    });
  }

  return result;
}
