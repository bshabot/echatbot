import ExcelJS from "exceljs";
import { normalizeModel, stripModel, vendorLabelFor } from "./labelOrderUtils";

/**
 * Component ordering (silicone backs / screw backs / chains / flat-GP backs).
 *
 * Same pipeline as Label Orders: live Signet PO lines -> vendor attribution
 * (attributeLine, shared from labelOrderUtils) -> per-vendor batch -> file +
 * component_orders rows so nothing gets ordered twice.
 *
 * The per-piece spec lives in component_specs, keyed by normalized model.
 * It was backfilled 8/18/26 from the QuickBooks PO export (8,499 lines,
 * 7/2023-8/2026) — the SB / Screwback / Chain / GP SB columns Esther has been
 * keying by hand. source = 'qb_backfill' (from history), 'qb_blank' (style was
 * ordered but nobody ever filled a component column — treat as UNKNOWN, not
 * zero) or 'manual' (set in this page).
 */

export const COMPONENTS = [
  { key: "sb", label: "Silicone backs" },
  { key: "scb", label: "Screw backs" },
  { key: "chain", label: "Chains" },
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
          : `${b.vendorLabel} (no vendor SO on shipments board yet)`,
        pieces: COMPONENTS.reduce((s, c) => s + b.totals[c.key], 0),
      };
    })
    .sort((a, b) => a.vendorLabel.localeCompare(b.vendorLabel));
}

/**
 * One workbook per vendor:
 *   "Order"  = what to order — component | quantity (non-zero only)
 *   "Detail" = the math behind it, same shape as the SB and chain workbook
 */
export async function generateComponentFileBlob(batch) {
  const wb = new ExcelJS.Workbook();

  const order = wb.addWorksheet("Order");
  order.addRow(["Vendor", batch.vendorLabel]);
  order.addRow(["Vendor SO(s)", batch.soNumbers.join(", ")]);
  order.addRow(["Pieces on order", batch.units]);
  order.addRow([]);
  order.addRow(["Component", "Quantity"]);
  for (const c of COMPONENTS) {
    if (batch.totals[c.key] > 0) order.addRow([c.label, batch.totals[c.key]]);
  }
  order.getRow(5).font = { bold: true };
  order.getColumn(1).width = 28;
  order.getColumn(2).width = 14;

  const detail = wb.addWorksheet("Detail");
  detail.addRow([
    "Vendor SO / PO",
    "SKU",
    "Style",
    "Qty",
    "SB /pc",
    "SCB /pc",
    "Chain /pc",
    "GP SB /pc",
    "Total SB",
    "Total SCB",
    "Total chains",
    "Total GP SB",
  ]);
  detail.getRow(1).font = { bold: true };
  for (const r of batch.rows) {
    detail.addRow([
      r.pos,
      r.sku || "",
      r.model,
      r.qty,
      r.per.sb,
      r.per.scb,
      r.per.chain,
      r.per.gp_sb,
      r.totals.sb,
      r.totals.scb,
      r.totals.chain,
      r.totals.gp_sb,
    ]);
  }
  detail.addRow([
    "TOTAL",
    "",
    "",
    batch.units,
    "",
    "",
    "",
    "",
    batch.totals.sb,
    batch.totals.scb,
    batch.totals.chain,
    batch.totals.gp_sb,
  ]).font = { bold: true };
  detail.getColumn(1).width = 16;
  detail.getColumn(2).width = 12;
  detail.getColumn(3).width = 24;

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function componentFileName(vendorLabel, date = new Date()) {
  const d = `${date.getMonth() + 1}-${date.getDate()}-${String(
    date.getFullYear()
  ).slice(2)}`;
  return `Component Order - ${vendorLabel} - ${d}.xlsx`;
}

export { vendorLabelFor };
