import { normalizeModel, stripModel, vendorLabelFor } from "./labelOrderUtils";

/**
 * Component ordering (silicone backs / screw backs / gold-plated backs).
 *
 * Same pipeline as Label Orders: live Signet PO lines -> vendor attribution
 * (attributeLine, shared from labelOrderUtils) -> per-vendor batch -> on-screen
 * PO lines + component_orders rows so nothing gets ordered twice.
 *
 * Item codes / prices come from component_items: SB-100 $0.11, SCB-100-SNG
 * $0.22, SB-100-GP $0.11 — all from Amtai Group Inc./TAFA TECHNOLOGY, verified
 * 8/19/26 against 17 real component POs (3/26 - 8/26).
 *
 * The per-piece spec lives in component_specs, keyed by normalized model.
 * It was backfilled 8/18/26 from the QuickBooks PO export (8,499 lines,
 * 7/2023-8/2026) — the SB / Screwback / Chain / GP SB columns Esther has been
 * keying by hand. source = 'qb_backfill' (from history), 'qb_blank' (style was
 * ordered but nobody ever filled a component column — treat as UNKNOWN, not
 * zero) or 'manual' (set in this page).
 */

/**
 * What we actually buy. Chains were retired 8/19/26 (Brian: "we dont order the
 * chains no more") — the column stays in component_specs / component_orders so
 * history reads back correctly, but nothing on the page counts it. To bring a
 * component back, add it here and set component_items.active = true.
 */
export const COMPONENTS = [
  { key: "sb", label: "Silicone backs" },
  { key: "scb", label: "Screw backs" },
  { key: "gp_sb", label: "Gold-plated backs" },
];

export function buildSpecMaps(specRows) {
  const exact = {};
  const stripped = {};
  for (const s of specRows || []) {
    const n = normalizeModel(s.model);
    if (!(n in exact)) exact[n] = s;
    const st = stripModel(s.model);
    if (!(st in stripped)) stripped[st] = s;
  }
  return { exact, stripped };
}

/**
 * Exact style wins — but only if it actually carries a count. A `qb_blank` row
 * means "ordered before, nobody ever filled the component column", so a known
 * sibling (G111ESQ5-14Y for G111ESQ5-14Y-NEW) beats it. Otherwise every -NEW
 * re-release would ask again for a style we already know.
 */
export function specFor(model, maps) {
  if (!maps) return null;
  const exact = maps.exact[normalizeModel(model)];
  if (exact && exact.source !== "qb_blank") return exact;
  const stripped = maps.stripped[stripModel(model)];
  if (stripped && stripped.source !== "qb_blank") return stripped;
  return exact || stripped || null;
}

/** per-piece counts + extended totals for one PO line */
export function componentsForLine(line, maps) {
  const spec = specFor(line.model, maps);
  const qty = Number(line.order_qty || 0);
  const per = {};
  const totals = {};
  for (const c of COMPONENTS) {
    per[c.key] = Number(spec?.[c.key] || 0);
    totals[c.key] = per[c.key] * qty;
  }
  const pieces = COMPONENTS.reduce((s, c) => s + totals[c.key], 0);
  return {
    spec,
    per,
    totals,
    pieces,
    // a style QuickBooks never had a component value for is a QUESTION, not a
    // zero — it goes to the review modal instead of silently ordering nothing
    specKnown: !!spec && spec.source !== "qb_blank",
  };
}

/**
 * Group attributed + spec'd lines into one batch per vendor.
 * Same SKU on two selected POs -> one detail row, quantities summed.
 */
export function buildComponentBatches(lines, soVendorsByPo) {
  const byVendor = {};
  for (const l of lines) {
    if (!l.vendorLabel) continue;
    const b = (byVendor[l.vendorLabel] ??= {
      vendorId: l.vendorId,
      vendorLabel: l.vendorLabel,
      lines: [],
      rowsBySku: {},
      soNumbers: new Set(),
      totals: Object.fromEntries(COMPONENTS.map((c) => [c.key, 0])),
      units: 0,
    });
    b.lines.push(l);
    const key = `${l.sku || l.model}`;
    const row = (b.rowsBySku[key] ??= {
      sku: l.sku,
      model: l.model,
      qty: 0,
      per: l.per,
      totals: Object.fromEntries(COMPONENTS.map((c) => [c.key, 0])),
      pos: new Set(),
    });
    row.qty += Number(l.order_qty || 0);
    row.pos.add(l.po_number);
    for (const c of COMPONENTS) {
      row.totals[c.key] += l.totals[c.key];
      b.totals[c.key] += l.totals[c.key];
    }
    b.units += Number(l.order_qty || 0);
    const sos = (soVendorsByPo[l.po_number] || {})[l.vendorLabel] || [];
    sos.forEach((so) => b.soNumbers.add(so));
  }
  return Object.values(byVendor)
    .map((b) => {
      const soNumbers = [...b.soNumbers].sort();
      const rows = Object.values(b.rowsBySku)
        .map((r) => ({ ...r, pos: [...r.pos].sort().join(", ") }))
        .sort((a, x) => String(a.model).localeCompare(String(x.model)));
      return {
        ...b,
        rows,
        soNumbers,
        batchTag: soNumbers.length
          ? `${soNumbers.join("-")} ${b.vendorLabel}`
          : `${b.vendorLabel} (no vendor PO on shipments board yet)`,
        pieces: COMPONENTS.reduce((s, c) => s + b.totals[c.key], 0),
      };
    })
    .sort((a, b) => a.vendorLabel.localeCompare(b.vendorLabel));
}

export { vendorLabelFor };
