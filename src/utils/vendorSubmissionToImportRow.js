// Turns a staged vendor submission into the spreadsheet-header row that
// formatImportRow() expects, so approval goes through the exact same path as
// Import and Bulk Add (formatImportRow -> insertFormattedSampleRows).
// Plan: docs/vendor-portal-build-plan.md

export const STAFF_ITEM_INFO_STATIC = {
  metals: {
    Gold: ["10K", "14K", "18K", "22K", "24K"],
    Silver: ["925"],
    Brass: ["Brass"],
  },
  colors: ["Yellow", "White", "Silver", "Rose", "Antique", "Two-Tone", "Tri-Tone", "Black"],
  sellingPair: ["pairs", "piece", "set"],
  backTypes: ["silicone", "screw", "flat", "hook", "crawler", "none"],
};

export function submissionToImportRow(data, vendorName, styleNumber) {
  const d = data || {};
  // Vendors send a manufacturer code only; staff assign the style number at approval.
  const style = String(styleNumber ?? d.style_number ?? "").trim();
  const row = {
    "ID (Sample)": "",
    "Style Number": style,
    Sku: style,
    Vendor: vendorName || "",
    "Manufacturer Code": d.manufacturer_code || "",
    Type: d.type || "",
    "Metal Type": d.metal_type || "",
    Karat: d.karat || "",
    Color: d.color || "",
    "Weight (g)": d.weight ?? "",
    "Length (in)": d.length ?? "",
    "Width (in)": d.width ?? "",
    "Height (in)": d.height ?? "",
    Plating: d.plating || "",
    "Selling Pair": d.selling_pair || "pairs",
    "Back Type": d.back_type || "none",
    // The grid feeds Detail into the auto-description; here the vendor's own
    // description wins and Detail is the fallback.
    "Quote Description": d.description || d.detail || "",
    "Sample Status": "Working_on_it:yellow",
  };
  (d.stones || []).slice(0, 10).forEach((s, i) => {
    const n = i + 1;
    row[`Stone ${n} Type`] = s.type || "";
    row[`Stone ${n} Shape`] = s.shape || "";
    row[`Stone ${n} Color`] = s.color || "";
    row[`Stone ${n} Size`] = s.size || "";
    row[`Stone ${n} Quantity`] = s.quantity ?? "";
  });
  return row;
}
