import ExcelJS from "exceljs";

// FineLine display names per vendor record name (vendors.name -> label used in
// FineLine internal-PO tags and on shipments.vendor). Default = vendors.name.
const VENDOR_LABELS = {
  ADEMAS: "Amtai",
  INAH: "Inah",
};

export function vendorLabelFor(vendorName) {
  if (!vendorName) return null;
  return VENDOR_LABELS[vendorName.trim().toUpperCase()] || vendorName.trim();
}

export function normalizeModel(model) {
  return (model || "").trim().toUpperCase();
}

// Signet suffix noise: "-NEW" and trailing size segments like "/7", "/7.5"
export function stripModel(model) {
  return normalizeModel(model)
    .replace(/-NEW$/i, "")
    .replace(/\/[0-9.]+$/, "");
}

/**
 * Vendor attribution for one PO line. Hierarchy (see FineLine plan doc):
 *   1. model_aliases (human-confirmed) — always wins
 *   2. PO has exactly ONE vendor SO on the shipments board -> that vendor
 *   3. sample match: EXACT styleNumber first, then suffix-stripped
 *      (exact must win — both variants can exist as samples)
 *   4. no match -> needsReview
 * A resolved vendor outside the PO's SO set (multi-vendor PO) -> needsReview
 * with the sample vendor preselected.
 */
export function attributeLine(line, ctx) {
  const { aliasMap, exactMap, strippedMap, soVendorsByPo, vendorsById } = ctx;
  const norm = normalizeModel(line.model);
  const soSet = soVendorsByPo[line.po_number] || {}; // { label: [so numbers] }
  const soLabels = Object.keys(soSet);

  const finish = (vendorId, source) => {
    const v = vendorsById[vendorId];
    const label = v ? vendorLabelFor(v.name) : null;
    const outsideSoSet =
      label && soLabels.length > 0 && !soLabels.includes(label);
    return {
      ...line,
      vendorId,
      vendorLabel: label,
      source,
      needsReview: !vendorId || (outsideSoSet && source !== "alias"),
      reviewReason: !vendorId
        ? "no match in PLM"
        : outsideSoSet && source !== "alias"
          ? `matched ${label} but PO ${line.po_number} has SOs for ${soLabels.join(", ")}`
          : null,
    };
  };

  const alias = aliasMap[norm];
  if (alias) return finish(alias, "alias");

  if (soLabels.length === 1) {
    const onlyLabel = soLabels[0];
    const v = Object.values(vendorsById).find(
      (x) => vendorLabelFor(x.name) === onlyLabel
    );
    if (v) return finish(v.id, "single-so");
  }

  const exact = exactMap[norm];
  if (exact) return finish(exact, "exact");

  const stripped = strippedMap[stripModel(line.model)];
  if (stripped) return finish(stripped, "stripped");

  return finish(null, "none");
}

/**
 * Group attributed lines into per-vendor batches.
 * Same SKU on multiple selected POs -> ONE row, quantities summed
 * (FineLine is SKU-keyed; confirmed against Esther's historical orders).
 * Returns [{ vendorId, vendorLabel, soNumbers, batchTag, skuRows, lines, units }]
 */
export function buildBatches(lines, soVendorsByPo) {
  const byVendor = {};
  for (const l of lines) {
    if (!l.vendorLabel) continue;
    const b = (byVendor[l.vendorLabel] ??= {
      vendorId: l.vendorId,
      vendorLabel: l.vendorLabel,
      lines: [],
      qtyBySku: {},
      soNumbers: new Set(),
    });
    b.lines.push(l);
    b.qtyBySku[l.sku] = (b.qtyBySku[l.sku] || 0) + Number(l.order_qty || 0);
    const sos = (soVendorsByPo[l.po_number] || {})[l.vendorLabel] || [];
    sos.forEach((so) => b.soNumbers.add(so));
  }
  return Object.values(byVendor)
    .map((b) => {
      const soNumbers = [...b.soNumbers].sort();
      const skuRows = Object.entries(b.qtyBySku)
        .map(([sku, qty]) => ({ sku, qty }))
        .sort((a, x) => a.sku.localeCompare(x.sku));
      return {
        vendorId: b.vendorId,
        vendorLabel: b.vendorLabel,
        lines: b.lines,
        soNumbers,
        batchTag: soNumbers.length
          ? `${soNumbers.join("-")} ${b.vendorLabel}`
          : `${b.vendorLabel} (no vendor SO on shipments board yet)`,
        skuRows,
        units: skuRows.reduce((s, r) => s + r.qty, 0),
      };
    })
    .sort((a, b) => a.vendorLabel.localeCompare(b.vendorLabel));
}

// Exact clone of FineLine's SpreadSheetLoad template:
// sheet "Sheet1", headers SKU | Quantity | Vendor Style (optional), no other data.
export async function generateLabelFileBlob(skuRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["SKU", "Quantity", "Vendor Style (optional)"]);
  for (const r of skuRows) {
    ws.addRow([Number(r.sku), Number(r.qty)]);
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function labelFileName(vendorLabel, date = new Date()) {
  const d = `${date.getMonth() + 1}-${date.getDate()}-${String(date.getFullYear()).slice(2)}`;
  return `FineLine Upload - ${vendorLabel} - ${d}.xlsx`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
