import React, { useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import * as XLSX from "xlsx";
import { Upload, AlertTriangle } from "lucide-react";

// PO uploader — auto-detects format A (single-PO HTML export) vs format B
// (binary xls/xlsx with one row per line, possibly multi-PO grouped by column A).
// For multi-PO files, splits into one DB record per unique PO Number.

export default function POUploader({ direction = "forward", onUploaded }) {
  const { supabase } = useSupabase();
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null); // { format, pos: [{ poNumber, poDate, lines, total }] }
  const [supplier, setSupplier] = useState("");
  const [tariffPct, setTariffPct] = useState(10);
  const [upchargePct, setUpchargePct] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Convert Excel serial date (e.g. 46114) to ISO yyyy-mm-dd
  function excelSerialToISO(v) {
    if (v == null || v === "") return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      // Maybe already a date string in another format
      const d = new Date(v);
      return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    // Excel epoch: 1899-12-30 (accounts for leap year bug). Days × ms-per-day.
    const ms = (n - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  const handleFile = async (e) => {
    setError("");
    setParsed(null);
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    try {
      // Auto-detect: HTML export = format A. Binary xls/xlsx = format B.
      const text = await f.text();
      const isHtml = /<html/i.test(text.slice(0, 500));

      if (isHtml) {
        await parseFormatA(f, text);
      } else {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf);
        await parseFormatB(wb);
      }
    } catch (e) {
      setError(`Failed to parse: ${e.message}`);
    }
  };

  // -------- Format A: HTML export, single PO --------
  async function parseFormatA(f, text) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const allTables = Array.from(doc.querySelectorAll("table"));
    const tableRows = (t) =>
      Array.from(t.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td,th")).map((c) =>
          (c.textContent || "").replace(/ /g, " ").trim()
        )
      );

    const allCells = [];
    for (const t of allTables) for (const r of tableRows(t)) allCells.push(r);
    const findCell = (label) => {
      for (const row of allCells) {
        for (let j = 0; j < row.length; j++) {
          if (row[j] === label) return row[j + 1];
        }
      }
      return null;
    };
    const poNumber = String(findCell("Purchase Order Number") || "").trim();
    const poDateRaw = findCell("Order Date");
    const poDate = poDateRaw ? excelSerialToISO(poDateRaw) : null;

    const detailTable = allTables.find((t) => {
      const rows = tableRows(t);
      return rows[0] && rows[0].some((c) => /^PODETAIL$/i.test(c));
    });
    if (!detailTable) throw new Error("Couldn't find PODETAIL block in HTML export");
    const detailRows = tableRows(detailTable);
    const cols = detailRows[1] || [];
    const idx = (label) => cols.findIndex((c) => c.toLowerCase() === label.toLowerCase());
    const iSku = idx("SKU");
    const iModel = idx("Manufacturer's Model #");
    const iDesc = idx("Merchandise Description");
    const iQty = idx("Order QTY");
    const iUnit = idx("Unit Cost($)");
    const iTotal = idx("Cost Extension($)");
    if (iSku === -1) throw new Error("Couldn't find SKU column in PODETAIL");

    const lines = [];
    for (let i = 2; i < detailRows.length; i++) {
      const r = detailRows[i];
      const skuVal = r[iSku];
      if (!skuVal || /total\s*qty/i.test(r[2] || "")) continue;
      lines.push({
        line_number: lines.length + 1,
        sku_number: String(skuVal),
        vendor_style_number: iModel >= 0 ? r[iModel] || null : null,
        description: iDesc >= 0 ? r[iDesc] || null : null,
        quantity: iQty >= 0 ? Number(r[iQty]) || null : null,
        unit_price: iUnit >= 0 ? Number(r[iUnit]) || null : null,
        total_price:
          iTotal >= 0 ? Number(String(r[iTotal] || "").replace(/,/g, "")) || null : null,
        raw_data: Object.fromEntries(cols.map((c, j) => [c, r[j]])),
      });
    }
    const total = lines.reduce((s, l) => s + (Number(l.total_price) || 0), 0);
    const pos = [{ poNumber: poNumber || null, poDate, lines, total, detectedTariff: null }];
    await detectTariffsForPOs(pos);
    setParsed({ format: "A", pos });
  }

  // -------- Format B: binary xls/xlsx, one row per line, multi-PO --------
  async function parseFormatB(wb) {
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
    if (rows.length === 0) throw new Error("Sheet is empty");

    const sample = rows[0];
    const keys = Object.keys(sample);
    const find = (re) => keys.find((k) => re.test(k));
    const kPo = find(/^po\s*number$/i) || find(/^po\.?\s*num/i);
    const kDate = find(/^order\s*date$/i) || find(/^po\s*date$/i);
    const kSku = find(/^sku$/i);
    const kModel = find(/manufacturer.*model/i) || find(/^model/i);
    const kDesc = find(/description/i);
    const kQty = find(/^order\s*qty$/i) || find(/^qty$|quantity/i);
    const kUnit = find(/unit\s*cost/i);
    const kTotal = find(/cost\s*extension|^extension/i);

    if (!kPo) throw new Error("Couldn't find 'PO Number' column (expected in column A)");
    if (!kSku) throw new Error("Couldn't find 'SKU' column");

    // Group rows by PO Number
    const groups = new Map();
    for (const r of rows) {
      const po = r[kPo];
      if (po == null || r[kSku] == null) continue;
      const key = String(po);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const pos = [];
    for (const [poNumber, groupRows] of groups) {
      const lines = groupRows.map((r, i) => ({
        line_number: i + 1,
        sku_number: String(r[kSku]),
        vendor_style_number: kModel ? String(r[kModel] ?? "") || null : null,
        description: kDesc ? String(r[kDesc] ?? "") || null : null,
        quantity: kQty ? Number(r[kQty]) || null : null,
        unit_price: kUnit ? Number(r[kUnit]) || null : null,
        total_price:
          kTotal ? Number(String(r[kTotal] ?? "").replace(/,/g, "")) || null : null,
        raw_data: r,
      }));
      const total = lines.reduce((s, l) => s + (Number(l.total_price) || 0), 0);
      const firstDate = kDate ? groupRows[0][kDate] : null;
      pos.push({
        poNumber,
        poDate: excelSerialToISO(firstDate),
        lines,
        total,
        detectedTariff: null, // filled in below
      });
    }

    // Auto-detect tariff per PO by comparing unit_price to SSP piece_cost_subtotal
    await detectTariffsForPOs(pos);

    setParsed({ format: "B", pos });
  }

  // Back-engineer tariff by ratio of line.unit_price to piece_cost_subtotal.
  // Tests {0%, 10%, 20%} × {0%, 4% upcharge} and picks the candidate with
  // most matching lines (60%+ majority wins). Falls back to 2nd-highest-ratio
  // anchor when no clean majority emerges (metal drift on older POs).
  //
  // IMPROVED 2026-05-20: if metal_lock_history has an entry for po.po_date,
  // adjust each SSP piece_cost_subtotal back to that historical lock before
  // computing the ratio. Removes metal drift entirely.
  async function detectTariffsForPOs(pos) {
    // Collect all sku_numbers across all POs
    const allSkus = new Set();
    for (const po of pos) {
      for (const l of po.lines) {
        if (l.sku_number) allSkus.add(String(l.sku_number));
      }
    }
    if (allSkus.size === 0) return;

    // Fetch SSP rows including total_material_cost so we can back out piece-at-historical-lock
    const { data: sspRows, error } = await supabase
      .from("running_line_skus")
      .select("sku_number, piece_cost_subtotal, total_material_cost")
      .in("sku_number", [...allSkus]);
    if (error) {
      console.warn("[tariff detection] SSP lookup failed:", error.message);
      return;
    }
    const sspBySku = new Map();
    for (const r of sspRows || []) sspBySku.set(String(r.sku_number), r);

    // Fetch metal_lock_history for the dates we'll look up: po_date + 3 days
    // (the Signet billing lag). Used by the historical-lock fallback path.
    // Weekends + holidays are forward-filled in the table so exact-match works.
    const lockLookupDates = [...new Set(
      pos
        .map((p) => {
          if (!p.poDate) return null;
          const d = new Date(p.poDate);
          d.setDate(d.getDate() + 3);
          return d.toISOString().slice(0, 10);
        })
        .filter(Boolean)
    )];
    const lockByDate = new Map();
    if (lockLookupDates.length > 0) {
      const { data: lockRows } = await supabase
        .from("metal_lock_history")
        .select("date, silver_lock, gold_lock")
        .in("date", lockLookupDates);
      for (const r of lockRows || []) lockByDate.set(r.date, r);
    }
    // Canonical "matrix" lock the stored material costs were computed at.
    // SSP data uses $90 silver / $4500 gold as the default matrix for most SKUs.
    // For SKUs with non-standard matrix bases, this approximation introduces a
    // few percent error, but the dominant SKUs in any PO use these defaults.
    const MATRIX_SILVER = 90;
    const MATRIX_GOLD = 4500;
    function pieceAtHistoricalLock(ssp, hist) {
      if (!hist || (!hist.silver_lock && !hist.gold_lock)) return Number(ssp.piece_cost_subtotal);
      const piece = Number(ssp.piece_cost_subtotal) || 0;
      const material = Number(ssp.total_material_cost) || 0;
      if (material === 0) return piece;
      // Scale material portion by historical_lock / matrix_lock. We don't know
      // per-SKU whether it's silver or gold without joining the materials
      // table per query, so we use a blended assumption: most SKUs in any
      // given PO are one metal type. Pick the lock that produces the smaller
      // adjustment magnitude as the most likely match.
      const silverScale = hist.silver_lock ? hist.silver_lock / MATRIX_SILVER : null;
      const goldScale = hist.gold_lock ? hist.gold_lock / MATRIX_GOLD : null;
      // Use whichever scale is closer to 1.0 (probably the relevant metal for this SKU).
      // Better: caller can know the SKU's metal, but we don't have it here.
      // For v1: use silver scale as default (most SKUs are silver in Brian's running lines).
      const scale = silverScale != null ? silverScale : goldScale != null ? goldScale : 1;
      return piece - material + material * scale;
    }

    const CANDIDATES = [0, 10, 20]; // tariff %
    const PENNY_TOLERANCE = 0.03; // a line "matches" a candidate if predicted within $0.03 of actual
    const HIST_LOCK_LAG_DAYS = 3; // historical lock lookup is po_date + 3 days (Signet billing lag)
    const HIST_LOCK_MIN_LINES = 4; // historical-lock fallback only triggers for POs with ≤4 lines

    // Run the penny-close-match algorithm. Returns the tariff candidate whose
    // predicted unit_price hits within $0.03 on the most lines. Optional
    // `pieceFn` lets us recompute piece at a historical lock instead of today's.
    // No upcharge in the multiplier — detection is pure (1 + tariff/100).
    //
    // If NO candidate has any penny-close lines, falls back to picking the
    // candidate with the smallest total absolute error across all lines.
    // Always returns a tariff (never null) as long as there's at least one
    // matched line with SSP data + unit_price.
    function detectByPennyMatch(lines, pieceFn) {
      let bestT = null;
      let bestN = 0;
      let matchedTotal = 0;
      // Track total absolute error per candidate for tie-break / fallback
      let bestErrT = null;
      let bestErrTotal = Infinity;
      for (const t of CANDIDATES) {
        const mult = 1 + t / 100;
        let n = 0;
        let errSum = 0;
        let errCount = 0;
        for (const l of lines) {
          const ssp = sspBySku.get(String(l.sku_number));
          if (!ssp || !l.unit_price) continue;
          const piece = pieceFn ? pieceFn(ssp) : Number(ssp.piece_cost_subtotal);
          if (!piece) continue;
          const err = Math.abs(Number(l.unit_price) - piece * mult);
          errSum += err;
          errCount++;
          if (err <= PENNY_TOLERANCE) n++;
        }
        if (n > bestN) { bestN = n; bestT = t; }
        if (errCount > 0 && errSum < bestErrTotal) {
          bestErrTotal = errSum;
          bestErrT = t;
        }
      }
      for (const l of lines) {
        const ssp = sspBySku.get(String(l.sku_number));
        if (ssp && l.unit_price) matchedTotal++;
      }
      // If no candidate had penny-close lines, fall back to lowest-total-error
      const tariff = bestN > 0 ? bestT : bestErrT;
      return { tariff, matches: bestN, matched: matchedTotal, usedErrorFallback: bestN === 0 && bestErrT != null };
    }

    // Compute the lookup date for historical lock: po_date + 3 days
    function lockLookupDate(poDate) {
      if (!poDate) return null;
      const d = new Date(poDate);
      d.setDate(d.getDate() + HIST_LOCK_LAG_DAYS);
      return d.toISOString().slice(0, 10);
    }

    // Main loop: detect tariff for each PO.
    for (const po of pos) {
      // PRIMARY: penny-match against today's piece_cost_subtotal. Returns
      // candidate with most lines within $0.03; if no candidate hits any line,
      // falls back to lowest-total-error candidate (always returns a value).
      const primary = detectByPennyMatch(po.lines, null);
      let detected = primary.tariff;
      po.usedHistoricalLock = false;
      po.tariffUsedErrorFallback = primary.usedErrorFallback;

      // HISTORICAL FALLBACK: only for small POs (≤4 lines). Use the lock from
      // po_date+3 days (Signet billing lag), recompute pieces at that lock,
      // re-run penny-match. If it produces MORE penny-close matches than
      // primary, prefer it.
      if (po.lines.length <= HIST_LOCK_MIN_LINES && po.poDate) {
        const lookupDate = lockLookupDate(po.poDate);
        const hist = lookupDate ? lockByDate.get(lookupDate) : null;
        if (hist && (hist.silver_lock || hist.gold_lock)) {
          const histResult = detectByPennyMatch(po.lines, (ssp) =>
            pieceAtHistoricalLock(ssp, hist),
          );
          if (histResult.matches > primary.matches) {
            detected = histResult.tariff;
            po.usedHistoricalLock = true;
            po.histLockDate = lookupDate;
            po.tariffUsedErrorFallback = histResult.usedErrorFallback;
          }
        }
      }

      po.detectedTariff = detected;
      po.tariffMatchedLines = primary.matched;
      po.tariffPennyMatches = primary.matches;
    }
  }

  const save = async () => {
    if (!parsed || !parsed.pos.length) return;
    setSaving(true);
    setError("");
    try {
      const created = [];
      let replacedCount = 0;
      for (const po of parsed.pos) {
        // Dedupe: if a PO with the same po_number already exists, delete it +
        // its items first. Brian's preference — re-uploads replace, not duplicate.
        if (po.poNumber) {
          const { data: existing, error: existErr } = await supabase
            .from("running_line_purchase_orders")
            .select("id")
            .eq("po_number", String(po.poNumber));
          if (existErr) throw existErr;
          if (existing && existing.length > 0) {
            const ids = existing.map((e) => e.id);
            const { error: delItemsErr } = await supabase
              .from("running_line_po_items")
              .delete()
              .in("po_id", ids);
            if (delItemsErr) throw delItemsErr;
            const { error: delPoErr } = await supabase
              .from("running_line_purchase_orders")
              .delete()
              .in("id", ids);
            if (delPoErr) throw delPoErr;
            replacedCount += existing.length;
          }
        }

        // Use detected tariff if available, otherwise fall back to user input
        const effectiveTariff =
          po.detectedTariff != null ? po.detectedTariff : Number(tariffPct) || 0;
        const { data: poRow, error: poErr } = await supabase
          .from("running_line_purchase_orders")
          .insert({
            direction,
            po_number: po.poNumber || null,
            po_date: po.poDate || null,
            supplier: supplier || null,
            file_format: parsed.format,
            file_name: file?.name || null,
            tariff_percent: effectiveTariff,
            upcharge_percent: Number(upchargePct) || 0,
            line_count: po.lines.length,
            total_amount: po.total,
            raw_data: { sheetName: file?.name, sample: po.lines.slice(0, 3) },
          })
          .select()
          .single();
        if (poErr) throw poErr;

        const lineRows = po.lines.map((l) => ({
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
        created.push(poRow);
      }

      // Notify parent for each created PO (newest first)
      for (const po of created.slice().reverse()) {
        onUploaded?.(po);
      }

      // reset
      setFile(null);
      setParsed(null);
      if (replacedCount > 0) {
        console.log(`[PO upload] replaced ${replacedCount} existing PO(s) with matching po_number`);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const totalLines = parsed?.pos.reduce((s, p) => s + p.lines.length, 0) ?? 0;
  const grandTotal = parsed?.pos.reduce((s, p) => s + (p.total || 0), 0) ?? 0;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
      <div className="text-sm font-medium text-gray-700">Upload a PO</div>

      <div>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
          className="block text-sm w-full"
        />
        <div className="text-xs text-gray-500 mt-1">
          Single-PO HTML exports and multi-PO binary xls files both supported.
          For multi-PO files, each unique PO Number becomes its own record.
        </div>
      </div>

      {parsed && (
        <>
          <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
            <div>
              <span className="text-gray-500">Detected:</span>{" "}
              <strong>{parsed.pos.length}</strong>{" "}
              PO{parsed.pos.length === 1 ? "" : "s"}, {totalLines} total lines,
              total ≈ ${grandTotal.toFixed(2)}
            </div>
            {(() => {
              // Summarize detected tariffs across the batch
              const tariffs = parsed.pos.map(p => p.detectedTariff).filter(t => t != null);
              const undetected = parsed.pos.length - tariffs.length;
              const counts = {};
              for (const t of tariffs) counts[t] = (counts[t] || 0) + 1;
              const summary = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([t, c]) => `${t}% (${c})`)
                .join(", ");
              if (!summary && !undetected) return null;
              return (
                <div className="text-xs text-gray-600 mt-1">
                  <span className="text-gray-500">Detected tariffs:</span>{" "}
                  {summary || "—"}
                  {undetected > 0 && (
                    <span className="text-amber-600"> · {undetected} couldn't detect (fallback to input)</span>
                  )}
                </div>
              );
            })()}
            {parsed.pos.length > 1 && (
              <div className="max-h-32 overflow-y-auto text-xs text-gray-600 mt-2 border-t pt-2">
                {parsed.pos.map((p, i) => (
                  <div key={i} className="flex justify-between py-0.5 gap-2">
                    <span className="font-mono">{p.poNumber || "—"}</span>
                    <span>{p.poDate || "—"}</span>
                    <span>{p.lines.length} lines</span>
                    <span
                      className={
                        p.detectedTariff != null
                          ? "text-green-700 font-medium"
                          : "text-amber-600"
                      }
                      title={
                        p.detectedTariff != null
                          ? `Detected from ${p.tariffMatchedLines} matched lines`
                          : "No SSP match — using fallback"
                      }
                    >
                      {p.detectedTariff != null ? `${p.detectedTariff}%` : "?%"}
                    </span>
                    <span>${p.total.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Supplier
              </label>
              <input
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="input w-full"
                placeholder="(optional)"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Fallback tariff %
              </label>
              <input
                type="number"
                value={tariffPct}
                onChange={(e) => setTariffPct(e.target.value)}
                step="0.1"
                className="input w-full"
              />
              <div className="text-xs text-gray-500 mt-1">
                Used only for POs where auto-detect can't find SSP matches.
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Upcharge %
              </label>
              <input
                type="number"
                value={upchargePct}
                onChange={(e) => setUpchargePct(e.target.value)}
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
            {saving
              ? `Saving ${parsed.pos.length} PO${parsed.pos.length === 1 ? "" : "s"}...`
              : `Save ${parsed.pos.length} PO${parsed.pos.length === 1 ? "" : "s"}`}
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
