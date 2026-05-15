import React, { useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import * as XLSX from "xlsx";
import { Upload, AlertTriangle } from "lucide-react";

// Phase-1 PO uploader: lets Brian drop an xlsx, pick the format manually,
// preview the parsed rows, set a tariff %, then save. Parsing is naive — once
// we have a real PO file the parsing logic gets refined.

export default function POUploader({ direction, onUploaded }) {
  const { supabase } = useSupabase();
  const [format, setFormat] = useState("A"); // 'A' single-PO sheet, 'B' multi-PO sheet
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState("");
  const [supplier, setSupplier] = useState(direction === "reverse" ? "Signet" : "");
  const [tariffPct, setTariffPct] = useState(10);
  const [upchargePct, setUpchargePct] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleFile = async (e) => {
    setError("");
    setParsed(null);
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf);

      // Detect file shape: format A is an HTML-table export (single PO with a
      // "Purchase Order Header" block + a "PODETAIL" block). Format B is a real
      // .xls with one sheet, header row across the top, one row per line.
      const sheetNames = wb.SheetNames;
      let lines = [];
      let headerInfo = {};

      if (format === "A") {
        // -------- Format A: HTML export, multiple <table> blocks per sheet --------
        // XLSX.read merges HTML tables into one sheet; the actual line-item header
        // row reads: PONUMBER | SKU | Manufacturer's Model # | Description |
        // Order QTY | Shipped QTY | Unit Cost($) | Cost Extension($) | DEPT | CLASS
        const allRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetNames[0]], {
          header: 1,
          defval: null,
        });

        // Pull header fields by scanning for the labels
        const findCell = (label) => {
          for (let i = 0; i < allRows.length; i++) {
            const row = allRows[i] || [];
            for (let j = 0; j < row.length; j++) {
              if (String(row[j] || "").trim() === label) {
                // value sits 1 cell to the right
                return row[j + 1];
              }
            }
          }
          return null;
        };
        headerInfo = {
          po_number: findCell("Purchase Order Number"),
          po_date: findCell("Order Date"),
          merchant: findCell("Merchant"),
          division: findCell("Division"),
          warehouse: findCell("Warehouse Number"),
          status: findCell("Order Status"),
        };

        // Find the PODETAIL line-item header row
        const headerRowIdx = allRows.findIndex(
          (r) =>
            Array.isArray(r) && r.some((c) => String(c || "").toUpperCase() === "SKU")
        );
        if (headerRowIdx === -1) throw new Error("Couldn't find SKU header row");
        const cols = allRows[headerRowIdx].map((c) => String(c || "").trim());
        const idx = (label) =>
          cols.findIndex((c) => c.toLowerCase() === label.toLowerCase());
        const iPo = idx("PONUMBER");
        const iSku = idx("SKU");
        const iModel = idx("Manufacturer's Model #");
        const iDesc = idx("Merchandise Description");
        const iQty = idx("Order QTY");
        const iUnit = idx("Unit Cost($)");
        const iTotal = idx("Cost Extension($)");

        for (let i = headerRowIdx + 1; i < allRows.length; i++) {
          const r = allRows[i] || [];
          const skuVal = r[iSku];
          // skip the "Total Qty" footer row
          if (!skuVal || /total\s*qty/i.test(String(r[2] || ""))) continue;
          lines.push({
            line_number: lines.length + 1,
            po_number: r[iPo] ? String(r[iPo]) : headerInfo.po_number ? String(headerInfo.po_number) : null,
            sku_number: String(skuVal),
            vendor_style_number: iModel >= 0 ? String(r[iModel] ?? "") : null,
            description: iDesc >= 0 ? String(r[iDesc] ?? "") : null,
            quantity: iQty >= 0 ? Number(r[iQty]) || null : null,
            unit_price: iUnit >= 0 ? Number(r[iUnit]) || null : null,
            total_price: iTotal >= 0 ? Number(String(r[iTotal] ?? "").replace(/,/g, "")) || null : null,
            raw_data: Object.fromEntries(cols.map((c, j) => [c, r[j]])),
          });
        }
      } else {
        // -------- Format B: multi-PO sheet, one row per line --------
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetNames[0]], {
          defval: null,
        });
        const sample = rows[0] || {};
        const keys = Object.keys(sample);
        const find = (re) => keys.find((k) => re.test(k));
        const kPo = find(/^po number$/i) || find(/^po\.?\s*num/i);
        const kSku = find(/^sku$/i) || find(/sku/i);
        const kModel = find(/manufacturer.*model/i) || find(/model/i);
        const kDesc = find(/description/i);
        const kQty = find(/order\s*qty/i) || find(/qty|quantity/i);
        const kUnit = find(/unit\s*cost/i);
        const kTotal = find(/cost\s*extension|extension/i);
        const kDate = find(/order\s*date/i);

        lines = rows
          .filter((r) => kSku && r[kSku] != null)
          .map((r, i) => ({
            line_number: i + 1,
            po_number: kPo ? String(r[kPo] ?? "") : null,
            sku_number: String(r[kSku]),
            vendor_style_number: kModel ? String(r[kModel] ?? "") : null,
            description: kDesc ? String(r[kDesc] ?? "") : null,
            quantity: kQty ? Number(r[kQty]) || null : null,
            unit_price: kUnit ? Number(r[kUnit]) || null : null,
            total_price: kTotal ? Number(String(r[kTotal] ?? "").replace(/,/g, "")) || null : null,
            order_date: kDate ? r[kDate] : null,
            raw_data: r,
          }));
        // For format B, set a "first PO date" as header info
        if (lines[0]?.order_date) headerInfo.po_date = lines[0].order_date;
      }

      const total = lines.reduce((s, l) => s + (Number(l.total_price) || 0), 0);
      const uniquePos = new Set(lines.map((l) => l.po_number).filter(Boolean));

      setParsed({
        sheetName: sheetNames[0],
        lineCount: lines.length,
        uniquePoCount: uniquePos.size,
        lines,
        total,
        headerInfo,
      });
      // Auto-fill the PO meta if available
      if (headerInfo.po_number) setPoNumber(String(headerInfo.po_number));
      if (headerInfo.po_date) {
        const d = new Date(headerInfo.po_date);
        if (!isNaN(d)) setPoDate(d.toISOString().slice(0, 10));
      }
    } catch (e) {
      setError(`Failed to parse: ${e.message}`);
    }
  };

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    setError("");
    try {
      const { data: poRow, error: poErr } = await supabase
        .from("running_line_purchase_orders")
        .insert({
          direction,
          po_number: poNumber || null,
          po_date: poDate || null,
          supplier: supplier || null,
          file_format: format,
          file_name: file?.name || null,
          tariff_percent: Number(tariffPct) || 0,
          upcharge_percent: Number(upchargePct) || 0,
          line_count: parsed.lineCount,
          total_amount: parsed.total,
          raw_data: { sheetName: parsed.sheetName, sample: parsed.lines.slice(0, 5) },
        })
        .select()
        .single();
      if (poErr) throw poErr;

      // Insert lines
      const lineRows = parsed.lines.map((l) => ({
        po_id: poRow.id,
        line_number: l.line_number,
        sku_number: l.sku_number ? String(l.sku_number) : null,
        vendor_style_number: l.vendor_style_number || null,
        description: l.description || null,
        quantity: l.quantity,
        unit_price: l.unit_price,
        total_price: l.total_price,
        raw_data: l.raw_data,
      }));
      if (lineRows.length) {
        const { error: lineErr } = await supabase
          .from("running_line_po_items")
          .insert(lineRows);
        if (lineErr) throw lineErr;
      }

      onUploaded?.(poRow);

      // reset
      setFile(null);
      setParsed(null);
      setPoNumber("");
      setPoDate("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
      <div className="text-sm font-medium text-gray-700">Upload a PO</div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="input w-full"
          >
            <option value="A">A — single PO per sheet</option>
            <option value="B">B — multi-PO per sheet</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">File</label>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFile}
            className="block text-sm w-full"
          />
        </div>
      </div>

      {parsed && (
        <>
          <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
            <div>
              <span className="text-gray-500">Detected:</span>{" "}
              {format === "A"
                ? `1 PO, ${parsed.lineCount} line${parsed.lineCount === 1 ? "" : "s"}`
                : `${parsed.uniquePoCount} POs, ${parsed.lineCount} total lines`}
              {", total ≈ $"}
              {parsed.total.toFixed(2)}
            </div>
            {parsed.headerInfo?.merchant && (
              <div className="text-xs text-gray-500">
                Merchant: {parsed.headerInfo.merchant} · Division: {parsed.headerInfo.division ?? "—"}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                PO #
              </label>
              <input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                PO Date
              </label>
              <input
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Supplier
              </label>
              <input
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Tariff %
              </label>
              <input
                type="number"
                value={tariffPct}
                onChange={(e) => setTariffPct(e.target.value)}
                step="0.1"
                className="input w-full"
              />
            </div>
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save PO"}
          </button>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
