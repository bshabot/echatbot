import {
  attributeLine,
  normalizeModel,
  stripModel,
  vendorLabelFor,
} from "./labelOrderUtils";

// Stats for a set of shipment rows (e.g. the POs sitting in Hong Kong):
// what's in them, grouped by product type, with qty, average unit price and
// average piece weight per type.
//
// Contents come from the Signet PO lines for each row's SO, attributed to the
// row's vendor with the same hierarchy as VendorPoItemsDialog (alias >
// single-SO vendor > exact sample > stripped), so a vendor PO only counts the
// lines that belong to it.
//   price  = signet_pos.unit_cost (what Signet pays us per piece)
//   weight = samples.salesWeight, falling back to starting_info.weight
// Averages are QTY-WEIGHTED (a style with 500 pcs counts 500x), and weight
// averages only cover pieces that have a weight on file — the count of pieces
// without one is reported so a thin average is visible.

// There is no usable product-type column in the PLM (samples.type is empty,
// starting_info.category is mostly "fashion"), so type is read off the Signet
// description first, then the style-number suffix.
export const TYPE_ORDER = [
  "Flatbacks",
  "Studs",
  "Huggies & hoops",
  "Earrings (other)",
  "Necklaces",
  "Bracelets & bangles",
  "Rings",
  "Charms",
  "Sets",
  "Other",
];

export function classifyType(line) {
  const d = String(line.description || "").toUpperCase();
  const m = normalizeModel(line.model);
  if (/FLATBACK|\bFB\b/.test(d)) return "Flatbacks";
  if (/\bSET\b|SETSB|\bSETS\b/.test(d)) return "Sets";
  if (/CHARM/.test(d)) return "Charms";
  if (/HUGGIE|HOOP/.test(d)) return "Huggies & hoops";
  if (/BRACELET|\bBRC\b|\bBR\b|BANGLE/.test(d)) return "Bracelets & bangles";
  if (/NECKLACE|\bNECK\b|PENDANT|\bNK\b/.test(d)) return "Necklaces";
  if (/\bRING\b|\bRNG\b|\bBAND\b/.test(d)) return "Rings";
  if (/\bSTUDS?\b/.test(d)) return "Studs";
  if (/POST|\bEARS?\b|EARRING/.test(d)) return "Earrings (other)";
  // fall back on the style-number suffix: N1759HE-GP, S5788C-4-NEW, N2068BR ...
  const base = m.replace(/-NEW$/, "").split("-")[0].replace(/\/.*$/, "");
  if (/FB\d/.test(m) || /^[A-Z]*FB\d/.test(base)) return "Flatbacks";
  if (/HE$/.test(base)) return "Huggies & hoops";
  if (/(BR|BN)$/.test(base)) return "Bracelets & bangles";
  if (/NK$/.test(base)) return "Necklaces";
  if (/R$/.test(base) && /\d/.test(base)) return "Rings";
  if (/[CP]$/.test(base) && /\d/.test(base)) return "Charms";
  if (/E$/.test(base) && /\d/.test(base)) return "Earrings (other)";
  return "Other";
}

// PostgREST caps a response (default 1000 rows) no matter the .limit(), so
// page through with .range() instead of trusting one call.
async function fetchAll(build) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function computeShipmentStats(supabase, rows) {
  // one entry per (SO, vendor): two vendor POs for the same vendor on the same
  // SO share the same attributed lines — count them once, not twice
  const rowsWithSo = rows.filter((r) => r.signet_po_number);
  const noSo = rows.filter((r) => !r.signet_po_number).map((r) => r.vendor_po);
  const pairs = new Map();
  const dupePos = [];
  for (const r of rowsWithSo) {
    const so = String(r.signet_po_number).trim();
    const label = vendorLabelFor(r.vendor);
    const key = `${so}|${label}`;
    if (pairs.has(key)) dupePos.push(r.vendor_po);
    else pairs.set(key, { so, label });
  }
  const sos = [...new Set([...pairs.values()].map((p) => p.so))];
  if (!sos.length) {
    return { types: [], totals: null, notes: { noSo, dupePos, cancelled: 0, unmatched: 0, noWeightPcs: 0, noPricePcs: 0 }, rowCount: rows.length };
  }

  const [lineRows, shipRows, vendRows, aliasRows, sampRows, siRows] = await Promise.all([
    fetchAll(() =>
      supabase
        .from("signet_pos")
        .select("po_number, sku, model, description, order_qty, unit_cost, order_status, scraped_at")
        .in("po_number", sos)
        .order("scraped_at", { ascending: false })
        .order("id", { ascending: true })
    ),
    fetchAll(() =>
      supabase
        .from("shipments")
        .select("signet_po_number, vendor_po, vendor")
        .in("signet_po_number", sos)
        .is("deleted_at", null)
        .order("id", { ascending: true })
    ),
    fetchAll(() => supabase.from("vendors").select("id, name").order("id")),
    fetchAll(() => supabase.from("model_aliases").select("alias, vendor_id").order("alias")),
    fetchAll(() =>
      supabase.from("samples").select("styleNumber, starting_info_id, salesWeight").order("styleNumber")
    ),
    fetchAll(() => supabase.from("starting_info").select("id, vendor, weight").order("id")),
  ]);

  // newest scrape per (SO, sku)
  const seen = new Set();
  const lines = [];
  for (const l of lineRows) {
    const k = `${l.po_number}|${l.sku}`;
    if (seen.has(k)) continue;
    seen.add(k);
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
  const vendorsById = {};
  for (const v of vendRows) vendorsById[v.id] = v;
  const aliasMap = {};
  for (const a of aliasRows) aliasMap[normalizeModel(a.alias)] = a.vendor_id;

  const siById = {};
  for (const si of siRows) siById[si.id] = si;
  const exactMap = {};
  const strippedMap = {};
  const weightExact = {};
  const weightStripped = {};
  for (const s of sampRows) {
    if (!s.styleNumber) continue;
    const norm = normalizeModel(s.styleNumber);
    const stripped = stripModel(s.styleNumber);
    const si = siById[s.starting_info_id];
    if (si?.vendor) {
      if (!(norm in exactMap)) exactMap[norm] = si.vendor;
      if (!(stripped in strippedMap)) strippedMap[stripped] = si.vendor;
    }
    const w = Number(s.salesWeight) > 0 ? Number(s.salesWeight) : Number(si?.weight) > 0 ? Number(si.weight) : null;
    if (w != null) {
      if (!(norm in weightExact)) weightExact[norm] = w;
      if (!(stripped in weightStripped)) weightStripped[stripped] = w;
    }
  }
  const ctx = { aliasMap, exactMap, strippedMap, soVendorsByPo, vendorsById };
  const weightOf = (model) => weightExact[normalizeModel(model)] ?? weightStripped[stripModel(model)] ?? null;

  const buckets = new Map();
  const notes = { noSo, dupePos, cancelled: 0, unmatched: 0, noWeightPcs: 0, noPricePcs: 0 };
  for (const raw of lines) {
    const { vendorLabel } = attributeLine(raw, ctx);
    if (!pairs.has(`${String(raw.po_number).trim()}|${vendorLabel}`)) {
      // belongs to a vendor/SO that isn't in the selection (or no vendor match)
      if (!vendorLabel) notes.unmatched += Number(raw.order_qty || 0);
      continue;
    }
    if (/CANCEL/i.test(raw.order_status || "")) {
      notes.cancelled += Number(raw.order_qty || 0);
      continue;
    }
    const qty = Number(raw.order_qty || 0);
    if (!qty) continue;
    const type = classifyType(raw);
    const b = buckets.get(type) ?? { type, qty: 0, styles: new Set(), value: 0, pricedQty: 0, weightQty: 0, weightSum: 0 };
    b.qty += qty;
    b.styles.add(normalizeModel(raw.model));
    const price = Number(raw.unit_cost);
    if (Number.isFinite(price) && price > 0) {
      b.value += price * qty;
      b.pricedQty += qty;
    } else notes.noPricePcs += qty;
    const w = weightOf(raw.model);
    if (w != null) {
      b.weightSum += w * qty;
      b.weightQty += qty;
    } else notes.noWeightPcs += qty;
    buckets.set(type, b);
  }

  const types = [...buckets.values()]
    .map((b) => ({
      type: b.type,
      qty: b.qty,
      styles: b.styles.size,
      avgPrice: b.pricedQty ? b.value / b.pricedQty : null,
      avgWeight: b.weightQty ? b.weightSum / b.weightQty : null,
      totalValue: b.value,
      totalWeight: b.weightSum,
    }))
    .sort((a, b) => b.qty - a.qty || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));

  const sum = (f) => types.reduce((s, t) => s + f(t), 0);
  const qtyAll = sum((t) => t.qty);
  const pricedQty = [...buckets.values()].reduce((s, b) => s + b.pricedQty, 0);
  const weightQty = [...buckets.values()].reduce((s, b) => s + b.weightQty, 0);
  const totals = {
    qty: qtyAll,
    styles: sum((t) => t.styles),
    totalValue: sum((t) => t.totalValue),
    avgPrice: pricedQty ? sum((t) => t.totalValue) / pricedQty : null,
    avgWeight: weightQty ? sum((t) => t.totalWeight) / weightQty : null,
    totalWeight: sum((t) => t.totalWeight),
  };
  return { types, totals, notes, rowCount: rows.length };
}
