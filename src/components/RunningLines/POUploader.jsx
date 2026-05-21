import React, { useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import * as XLSX from "xlsx";
import { Upload, AlertTriangle } from "lucide-react";
import {
  recomputeSignetBill,
  backEngineerMetalRate,
  resolveMetal,
} from "../../utils/runningLinesMath";

// Mirror of POLinesView's detectModeRate — round implied rates to 10¢ then
// pick the modal value. One line is enough to seed a lock.
function detectModeRate(impliedRates) {
  const valid = impliedRates.filter((r) => r != null && Number.isFinite(r) && r > 0);
  if (valid.length === 0) return null;
  const buckets = new Map();
  for (const r of valid) {
    const rounded = Math.round(r * 10) / 10;
    buckets.set(rounded, (buckets.get(rounded) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [val, count] of buckets) {
    if (count > bestCount) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

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

  // Per-tariff back-engineered lock detection (2026-05-21).
  //
  // For each candidate tariff t in {0, 10, 20}:
  //   1. For every line: backEngineerMetalRate(line, sku, components, { t })
  //      → implied $/oz per line (silver/gold lock if t were correct)
  //   2. Group implied rates by metal type, take detectModeRate → back-engineered
  //      silver lock + gold lock for this PO under hypothesis "tariff = t"
  //   3. Predict every line: recomputeSignetBill(sku, components, {silver, gold, t})
  //   4. Diff = |predicted - signet unit_price|
  //   5. confidence = max(0, 100 - mismatchCount × 5 - min(50, maxMismatch × 5))
  //
  // Whichever tariff scores highest wins. Same scoring formula POLinesView uses
  // to render the per-PO confidence on the list — so the upload-time number
  // matches what shows after clicking in.
  //
  // No brass-priority shortcut needed (back-engineering naturally skips brass
  // components). No historical-lock fallback needed (the lock IS back-engineered
  // per candidate).
  async function detectTariffsForPOs(pos) {
    // Collect all sku_numbers across all POs
    const allSkus = new Set();
    for (const po of pos) {
      for (const l of po.lines) {
        if (l.sku_number) allSkus.add(String(l.sku_number));
      }
    }
    if (allSkus.size === 0) return;

    // Load full SKU rows — need duty_rate, piece_cost_subtotal,
    // discount_piece_cost_subtotal, labor_delta, weight_delta for the math
    const { data: sspRows, error } = await supabase
      .from("running_line_skus")
      .select("*")
      .in("sku_number", [...allSkus]);
    if (error) {
      console.warn("[tariff detection] SSP lookup failed:", error.message);
      return;
    }
    const sspBySku = new Map();
    for (const r of sspRows || []) sspBySku.set(String(r.sku_number), r);

    const sspNumbers = [...new Set((sspRows || []).map((r) => r.ssp_number).filter(Boolean))];
    if (sspNumbers.length === 0) return;

    // Load materials + findings + chains for the components-per-SKU map
    const [{ data: matRows }, { data: findRows }, { data: chainRows }] = await Promise.all([
      supabase
        .from("running_line_materials")
        .select(
          "ssp_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight,metal_base_price,metal_loss_percent",
        )
        .in("ssp_number", sspNumbers),
      supabase
        .from("running_line_findings")
        .select(
          "ssp_number,finding_net_weight,metal_purity,metal_base_price,metal_loss_percent",
        )
        .in("ssp_number", sspNumbers),
      supabase
        .from("running_line_chains")
        .select(
          "ssp_number,chain_net_weight,metal_purity,metal_karat,metal_base_price,metal_loss_percent",
        )
        .in("ssp_number", sspNumbers),
    ]);
    const componentsBySsp = new Map();
    const pushRows = (rows) => {
      for (const r of rows || []) {
        if (!componentsBySsp.has(r.ssp_number)) componentsBySsp.set(r.ssp_number, []);
        componentsBySsp.get(r.ssp_number).push(r);
      }
    };
    pushRows(matRows);
    pushRows(findRows);
    pushRows(chainRows);

    const CANDIDATES = [0, 10, 20];
    const PENNY_TOLERANCE = 0.03;

    // Score one candidate tariff against one PO. Returns:
    //   { confidence, lock: { silver, gold }, matches, evaluated, errSum }
    function scoreCandidate(po, t) {
      // 1. Per-line: enrich with sku + components + metal type + impliedRate@t
      const enriched = po.lines.map((line) => {
        const sku = sspBySku.get(String(line.sku_number)) || null;
        const components = sku ? componentsBySsp.get(sku.ssp_number) || [] : [];
        const metal = sku && components.length > 0 ? resolveMetal(components) : null;
        const impliedRate =
          sku && components.length > 0
            ? backEngineerMetalRate(line, sku, components, {
                tariffPct: t,
                upchargePct: 0,
              })
            : null;
        return { line, sku, components, metal, impliedRate };
      });

      // 2. Back-engineer the silver + gold lock at this candidate tariff
      const silverImplied = [];
      const goldImplied = [];
      for (const e of enriched) {
        if (e.impliedRate == null || !e.metal) continue;
        if (e.metal.metalType === "Silver") silverImplied.push(e.impliedRate);
        else if (e.metal.metalType === "Gold") goldImplied.push(e.impliedRate);
      }
      const silverLock = detectModeRate(silverImplied);
      const goldLock = detectModeRate(goldImplied);

      // 3. Predict each line at the back-engineered lock, diff vs signet
      const diffs = [];
      for (const e of enriched) {
        if (!e.sku || e.components.length === 0 || !e.line.unit_price) continue;
        const lineLock =
          e.metal?.metalType === "Gold"
            ? goldLock
            : e.metal?.metalType === "Silver"
              ? silverLock
              : null;
        const predicted = recomputeSignetBill(e.sku, e.components, {
          silver: silverLock ?? lineLock ?? 0,
          gold: goldLock ?? lineLock ?? 0,
          tariffPct: t,
          upchargePct: 0, // Signet doesn't add upcharge — that's Brian's, not theirs
        });
        diffs.push(Math.abs(Number(e.line.unit_price) - predicted));
      }
      if (diffs.length === 0) {
        return {
          confidence: null,
          lock: { silver: silverLock, gold: goldLock },
          matches: 0,
          evaluated: 0,
          errSum: 0,
        };
      }

      // 4. Confidence (same formula as POLinesView)
      const mismatched = diffs.filter((d) => d > PENNY_TOLERANCE);
      const mismatchCount = mismatched.length;
      const maxMismatch = mismatched.length ? Math.max(...mismatched) : 0;
      const countPenalty = mismatchCount * 5;
      const sizePenalty = Math.min(50, maxMismatch * 5);
      const confidence = Math.max(0, 100 - countPenalty - sizePenalty);
      return {
        confidence,
        lock: { silver: silverLock, gold: goldLock },
        matches: diffs.filter((d) => d <= PENNY_TOLERANCE).length,
        evaluated: diffs.length,
        errSum: diffs.reduce((s, d) => s + d, 0),
      };
    }

    // Main loop: try each candidate, pick highest confidence
    for (const po of pos) {
      let bestT = null;
      let bestConfidence = -1;
      let bestErrSum = Infinity;
      let bestResult = null;
      const scores = {};
      const lockByTariff = {};
      for (const t of CANDIDATES) {
        const result = scoreCandidate(po, t);
        scores[t] = result.confidence != null ? Math.round(result.confidence) : null;
        lockByTariff[t] = result.lock;
        if (result.confidence == null) continue;
        const better =
          result.confidence > bestConfidence ||
          (result.confidence === bestConfidence && result.errSum < bestErrSum);
        if (better) {
          bestT = t;
          bestConfidence = result.confidence;
          bestErrSum = result.errSum;
          bestResult = result;
        }
      }
      po.detectedTariff = bestT;
      po.detectedConfidence = bestConfidence >= 0 ? bestConfidence : null;
      po.detectedScores = scores;
      po.detectedLock = bestResult?.lock || null;
      po.detectedLockByTariff = lockByTariff;
      po.tariffMatchedLines = bestResult?.evaluated || 0;
      po.tariffPennyMatches = bestResult?.matches || 0;
      // Cleared from old algorithm — no longer relevant
      po.usedHistoricalLock = false;
      po.tariffUsedBrassOnly = false;
      po.tariffBrassLineCount = 0;
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
            confidence_score:
              po.detectedConfidence != null
                ? Math.round(po.detectedConfidence)
                : null,
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
                          ? `Confidence: ${p.detectedConfidence ?? "—"}%\nScores: ${
                              p.detectedScores
                                ? Object.entries(p.detectedScores)
                                    .map(([t, s]) => `${t}%=${s ?? "—"}`)
                                    .join(" ")
                                : ""
                            }\nBack-engineered lock: silver $${
                              p.detectedLock?.silver?.toFixed(2) ?? "—"
                            } / gold $${p.detectedLock?.gold?.toFixed(2) ?? "—"}\n${
                              p.tariffMatchedLines
                            } matched lines`
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
