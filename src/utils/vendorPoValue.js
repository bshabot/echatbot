// vendorPoValue.js — value of the goods in each vendor PO, priced off the
// Signet sales order (Brian 10/30/26). Used for the EFW declared value.
//
// A vendor PO = this vendor's slice of the Signet SO. We pull the SO's lines
// (newest scrape per SKU), attribute each line to a vendor with the SAME
// hierarchy as the PO click-through / Labels / Factory Costs
// (alias > single-SO vendor > exact sample > stripped), then for each
// shipment row sum  order_qty x SO unit_cost  over the lines that belong to
// that row's vendor. Cancelled lines are skipped.
//
// Returns { [rowId]: { value, units, styles, unmatched } } — rows with no SO
// or no attributed lines come back with value null so the caller can fall
// back (QB amount).
import {
  attributeLine,
  normalizeModel,
  stripModel,
  vendorLabelFor,
} from "./labelOrderUtils";

const SKIP_STATUSES = ["CANCEL", "CANCELLED", "CANCELED"];

// PostgREST caps every response at 1000 rows — page through the whole table.
async function fetchAll(supabase, table, cols, build = (q) => q) {
  const step = 1000;
  const out = [];
  for (let from = 0; ; from += step) {
    const { data, error } = await build(supabase.from(table).select(cols)).range(from, from + step - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < step) break;
  }
  return out;
}

export async function fetchVendorPoValues(supabase, rows) {
  const sos = [...new Set(rows.map((r) => String(r.signet_po_number || "").trim()).filter(Boolean))];
  const out = {};
  for (const r of rows) out[r.id] = { value: null, units: 0, styles: 0, unmatched: 0 };
  if (!sos.length) return out;
  const soSet = new Set(sos);

  // signet_pos_latest = newest scrape per (PO, SKU). Small SO sets filter
  // server-side; the whole board (hundreds of SOs) just pulls the view.
  const [latest, ships, vendors, aliases, samples, sis] = await Promise.all([
    fetchAll(supabase, "signet_pos_latest", "po_number, sku, model, order_qty, unit_cost, order_status",
      (q) => (sos.length <= 100 ? q.in("po_number", sos) : q).order("po_number").order("sku")),
    fetchAll(supabase, "shipments", "id, signet_po_number, vendor_po, vendor",
      (q) => q.is("deleted_at", null).order("id")),
    fetchAll(supabase, "vendors", "id, name", (q) => q.order("id")),
    fetchAll(supabase, "model_aliases", "alias, vendor_id", (q) => q.order("alias")),
    fetchAll(supabase, "samples", "id, styleNumber, starting_info_id", (q) => q.order("id")),
    fetchAll(supabase, "starting_info", "id, vendor", (q) => q.order("id")),
  ]);
  const linesRes = { data: latest.filter((l) => soSet.has(String(l.po_number).trim())) };
  const shipRes = { data: ships.filter((s) => soSet.has(String(s.signet_po_number || "").trim())) };
  const vendRes = { data: vendors };
  const aliasRes = { data: aliases };
  const sampRes = { data: samples };
  const siRes = { data: sis };

  // newest scrape per (SO, SKU)
  const seen = new Set();
  const lines = [];
  for (const l of linesRes.data || []) {
    const k = `${l.po_number}|${l.sku}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (SKIP_STATUSES.includes(String(l.order_status || "").toUpperCase())) continue;
    lines.push(l);
  }

  const soVendorsByPo = {};
  for (const s of shipRes.data || []) {
    if (!s.signet_po_number || !s.vendor_po) continue;
    const label = vendorLabelFor(s.vendor);
    if (!label) continue;
    const p = (soVendorsByPo[s.signet_po_number] ??= {});
    (p[label] ??= []).push(String(s.vendor_po));
  }

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
  const ctx = { aliasMap, exactMap, strippedMap, soVendorsByPo, vendorsById };
  const attributed = lines.map((l) => attributeLine(l, ctx));

  // (SO, vendor label) -> totals
  const totals = {};
  const unmatchedBySo = {};
  for (const l of attributed) {
    if (!l.vendorLabel) {
      unmatchedBySo[l.po_number] = (unmatchedBySo[l.po_number] || 0) + 1;
      continue;
    }
    const k = `${l.po_number}|${l.vendorLabel}`;
    const t = (totals[k] ??= { value: 0, units: 0, styles: 0 });
    const qty = Number(l.order_qty || 0);
    t.value += qty * Number(l.unit_cost || 0);
    t.units += qty;
    t.styles += 1;
  }

  // Two rows for the same SO + same vendor (split vendor POs) must not
  // double-count: the first row carries the value, the rest get 0.
  const used = new Set();
  for (const r of rows) {
    const so = String(r.signet_po_number || "").trim();
    const label = vendorLabelFor(r.vendor);
    if (!so || !label) continue;
    const k = `${so}|${label}`;
    const t = totals[k];
    if (!t) continue;
    if (used.has(k)) {
      out[r.id] = { value: 0, units: 0, styles: 0, unmatched: 0, sharedWith: k };
      continue;
    }
    used.add(k);
    out[r.id] = {
      value: Math.round(t.value * 100) / 100,
      units: t.units,
      styles: t.styles,
      unmatched: unmatchedBySo[so] || 0,
    };
  }
  return out;
}
