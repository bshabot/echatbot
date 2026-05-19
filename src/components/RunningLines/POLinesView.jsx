import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import {
  backEngineerMetalRate,
  recomputeSignetBill,
  rebillFromActualPrice,
  resolveMetal,
} from "../../utils/runningLinesMath";
import { AlertTriangle, CheckCircle2, Download } from "lucide-react";

const MISMATCH_THRESHOLD = 0.01; // 1% per Brian's spec

// Round to nearest 10¢ then take the most-common value (mode) across implied rates
function detectModeRate(impliedRates) {
  const valid = impliedRates.filter((r) => r != null && Number.isFinite(r) && r > 0);
  if (valid.length === 0) return null;
  const buckets = new Map();
  for (const r of valid) {
    const key = Math.round(r * 10) / 10;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let modeKey = null;
  let modeCount = 0;
  for (const [k, c] of buckets) {
    if (c > modeCount) {
      modeCount = c;
      modeKey = k;
    }
  }
  // Within the mode bucket, return the average for precision
  const inBucket = valid.filter((r) => Math.round(r * 10) / 10 === modeKey);
  return inBucket.reduce((s, x) => s + x, 0) / inBucket.length;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadAsCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function POLinesView({ po, onClose }) {
  const { supabase } = useSupabase();
  const prices = useMetalPriceStore((s) => s.prices);

  // Re-bill inputs (default to today's spot + 4% upcharge per Brian)
  const [newSilver, setNewSilver] = useState(prices?.silver?.price ?? 30);
  const [newGold, setNewGold] = useState(prices?.gold?.price ?? 2400);
  const [upchargePct, setUpchargePct] = useState(4);
  const [baselineMode, setBaselineMode] = useState("signet"); // 'signet' | 'ssp'

  const [lines, setLines] = useState([]);
  const [skuById, setSkuById] = useState(new Map());
  const [componentsBySsp, setComponentsBySsp] = useState(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase || !po) return;
    (async () => {
      setLoading(true);
      const { data: lineRows } = await supabase
        .from("running_line_po_items")
        .select("*")
        .eq("po_id", po.id)
        .order("line_number", { ascending: true });
      setLines(lineRows ?? []);

      const skuNumbers = [...new Set((lineRows ?? []).map((l) => l.sku_number).filter(Boolean))];
      const vsns = [...new Set((lineRows ?? []).map((l) => l.vendor_style_number).filter(Boolean))];

      const { data: skuRows } = await supabase
        .from("running_line_skus")
        .select("*")
        .or(
          [
            skuNumbers.length ? `sku_number.in.(${skuNumbers.join(",")})` : null,
            vsns.length ? `vendor_style_number.in.(${vsns.join(",")})` : null,
          ]
            .filter(Boolean)
            .join(",")
        );

      const map = new Map();
      for (const s of skuRows ?? []) {
        if (s.sku_number) map.set(`sku:${s.sku_number}`, s);
        if (s.vendor_style_number) map.set(`vsn:${s.vendor_style_number}`, s);
      }
      setSkuById(map);

      const sspList = (skuRows ?? []).map((s) => s.ssp_number);
      if (sspList.length) {
        const [
          { data: matRows },
          { data: findRows },
          { data: chainRows },
        ] = await Promise.all([
          supabase
            .from("running_line_materials")
            .select(
              "ssp_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight,metal_base_price,metal_loss_percent"
            )
            .in("ssp_number", sspList),
          supabase
            .from("running_line_findings")
            .select(
              "ssp_number,finding_net_weight,metal_purity,metal_base_price,metal_loss_percent"
            )
            .in("ssp_number", sspList),
          supabase
            .from("running_line_chains")
            .select(
              "ssp_number,chain_net_weight,metal_purity,metal_karat,metal_base_price,metal_loss_percent"
            )
            .in("ssp_number", sspList),
        ]);
        const m = new Map();
        const push = (rows) => {
          for (const r of rows ?? []) {
            if (!m.has(r.ssp_number)) m.set(r.ssp_number, []);
            m.get(r.ssp_number).push(r);
          }
        };
        push(matRows);
        push(findRows);
        push(chainRows);
        setComponentsBySsp(m);
      }
      setLoading(false);
    })();
  }, [supabase, po]);

  // Step 1: Match each line to its SKU + materials and compute implied rate
  const enriched = useMemo(() => {
    const tariffPct = Number(po.tariff_percent ?? 0);
    const upchargeAtPo = Number(po.upcharge_percent ?? 0);
    return lines.map((line) => {
      const sku =
        (line.sku_number && skuById.get(`sku:${line.sku_number}`)) ||
        (line.vendor_style_number && skuById.get(`vsn:${line.vendor_style_number}`)) ||
        null;
      const components = sku ? componentsBySsp.get(sku.ssp_number) || [] : [];
      const metal = sku ? resolveMetal(components) : null;

      const impliedRate = sku
        ? backEngineerMetalRate(line, sku, components, { tariffPct, upchargePct: upchargeAtPo })
        : null;

      return { line, sku, materials: components, metal, impliedRate };
    });
  }, [lines, skuById, componentsBySsp, po]);

  // Step 2: Detect the PO's metal lock (mode across all implied rates)
  const lock = useMemo(() => detectModeRate(enriched.map((e) => e.impliedRate)), [enriched]);

  // Step 3: Per-line reconciliation + new-bill computation
  const reconciled = useMemo(() => {
    const oldTariff = Number(po.tariff_percent ?? 0);
    const oldUpcharge = Number(po.upcharge_percent ?? 0);
    const newTariff = Number(po.tariff_percent ?? 0); // keep tariff from original PO
    const isReverseDir = po.direction === "reverse";

    return enriched.map((e) => {
      const reconcile =
        lock != null && e.impliedRate != null
          ? Math.abs(e.impliedRate - lock) / lock < MISMATCH_THRESHOLD
          : null;

      // Predicted price at the detected PO lock, using OUR SSP data.
      // If our data agrees with signet, this should ≈ line.unit_price.
      // If it doesn't, we have a data-quality discrepancy.
      let predictedAtLock = null;
      if (e.sku && e.materials.length > 0 && lock != null) {
        // Use the PO lock as both silver and gold input (only the matching one will be used)
        predictedAtLock = recomputeSignetBill(e.sku, e.materials, {
          silver: lock,
          gold: lock,
          tariffPct: oldTariff,
          upchargePct: oldUpcharge,
        });
      }
      const signetVsOurs =
        predictedAtLock != null && e.line.unit_price
          ? Number(e.line.unit_price) - predictedAtLock
          : null;

      // newBill: depends on baselineMode and direction
      let newBill = null;
      if (e.sku && e.materials.length > 0) {
        const useSignetBaseline =
          baselineMode === "signet" && isReverseDir && lock && e.line.unit_price;
        if (useSignetBaseline) {
          newBill = rebillFromActualPrice(e.line, e.sku, e.materials, {
            oldTariffPct: oldTariff,
            oldUpchargePct: oldUpcharge,
            oldLockRate: e.impliedRate || lock,
            newSilver,
            newGold,
            newTariffPct: newTariff,
            newUpchargePct: upchargePct,
          });
        } else {
          newBill = recomputeSignetBill(e.sku, e.materials, {
            silver: newSilver,
            gold: newGold,
            tariffPct: newTariff,
            upchargePct,
          });
        }
      }

      const newExtension =
        newBill != null && e.line.quantity ? newBill * Number(e.line.quantity) : null;
      const deltaPerUnit =
        newBill != null && e.line.unit_price != null
          ? newBill - Number(e.line.unit_price)
          : null;
      const deltaTotal =
        deltaPerUnit != null && e.line.quantity != null
          ? deltaPerUnit * Number(e.line.quantity)
          : null;

      return {
        ...e,
        reconcile,
        predictedAtLock,
        signetVsOurs,
        newBill,
        newExtension,
        deltaPerUnit,
        deltaTotal,
      };
    });
  }, [enriched, lock, po, newSilver, newGold, upchargePct, baselineMode]);

  // PO-level reconciliation summary
  const summary = useMemo(() => {
    let matched = 0,
      mismatched = 0,
      unmatched = 0;
    let oldTotal = 0,
      newTotal = 0;
    let dollarGap = 0;
    for (const r of reconciled) {
      if (!r.sku) unmatched++;
      else if (r.reconcile === true) matched++;
      else if (r.reconcile === false) mismatched++;
      oldTotal += Number(r.line.total_price ?? r.line.unit_price * (r.line.quantity || 1)) || 0;
      newTotal += Number(r.newExtension) || 0;
      if (r.signetVsOurs != null && r.line.quantity) {
        dollarGap += Math.abs(r.signetVsOurs) * Number(r.line.quantity);
      }
    }
    return {
      matched,
      mismatched,
      unmatched,
      total: reconciled.length,
      oldTotal,
      newTotal,
      delta: newTotal - oldTotal,
      dollarGap,
    };
  }, [reconciled]);

  const handleDownloadCSV = () => {
    const metalLabel = `silver=$${newSilver}/oz gold=$${newGold}/oz upcharge=${upchargePct}% baseline=${baselineMode}`;
    const header = [
      `# PO ${po.po_number || ""} re-bill — ${metalLabel} — tariff ${po.tariff_percent ?? 0}% — detected lock ${lock ? "$" + lock.toFixed(2) : "—"}`,
    ];
    const cols = [
      "SKU",
      "Style #",
      "Description",
      "Metal",
      "Qty",
      "Signet Unit",
      "Predicted (ours)",
      "Signet vs Ours",
      "Implied $/oz",
      "Reconcile",
      "New Unit",
      "New Extension",
      "Delta Per Unit",
      "Delta Total",
    ];
    const rows = reconciled.map((r) => [
      r.line.sku_number || "",
      r.line.vendor_style_number || "",
      r.line.description || "",
      r.metal ? `${r.metal.metalType} ${r.metal.karat || ""}`.trim() : "",
      r.line.quantity ?? "",
      r.line.unit_price ?? "",
      r.predictedAtLock != null ? r.predictedAtLock.toFixed(2) : "",
      r.signetVsOurs != null ? r.signetVsOurs.toFixed(2) : "",
      r.impliedRate ? r.impliedRate.toFixed(2) : "",
      r.reconcile === true ? "OK" : r.reconcile === false ? "MISMATCH" : r.sku ? "" : "NO SSP MATCH",
      r.newBill != null ? r.newBill.toFixed(2) : "",
      r.newExtension != null ? r.newExtension.toFixed(2) : "",
      r.deltaPerUnit != null ? r.deltaPerUnit.toFixed(2) : "",
      r.deltaTotal != null ? r.deltaTotal.toFixed(2) : "",
    ]);
    const filename = `PO_${po.po_number || po.id.slice(0, 8)}_rebill.csv`;
    downloadAsCSV(filename, [header, [], cols, ...rows]);
  };

  const dollar = (n) =>
    n == null || !Number.isFinite(Number(n))
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const pct = (n) => (n == null ? "—" : `${n.toFixed(2)}%`);

  const isReverse = po.direction === "reverse";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl max-w-7xl w-full my-8">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              PO {po.po_number || po.id.slice(0, 8)} ·{" "}
              {isReverse ? "Signet → me (reverse)" : "Factory → me (forward)"}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {po.po_date || "—"} · {po.supplier || "—"} · {po.line_count ?? lines.length} lines ·
              tariff {po.tariff_percent ?? 0}%
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-2">
            ×
          </button>
        </div>

        {/* PO-level summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b bg-gray-50">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Detected metal lock</div>
            <div className="text-xl font-semibold text-gray-900">
              {lock ? `$${lock.toFixed(2)}/oz` : "—"}
            </div>
            <div className="text-xs text-gray-500">mode across lines</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Data confidence</div>
            <div className="text-xl font-semibold text-gray-900">
              {summary.matched} / {summary.total} <span className="text-sm text-gray-500">agree</span>
            </div>
            <div className="text-xs text-gray-500">
              {summary.mismatched} mismatch · {summary.unmatched} no SSP · ±${summary.dollarGap.toFixed(2)} total gap
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Original total</div>
            <div className="text-xl font-semibold text-gray-900">{dollar(summary.oldTotal)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">New total</div>
            <div className="text-xl font-semibold text-gray-900">{dollar(summary.newTotal)}</div>
            <div
              className={`text-xs ${
                summary.delta >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {summary.delta >= 0 ? "+" : ""}
              {dollar(summary.delta)} vs original
            </div>
          </div>
        </div>

        {/* Re-bill controls */}
        <div className="p-4 border-b flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">New silver $/oz</label>
            <input
              type="number"
              value={newSilver}
              onChange={(e) => setNewSilver(Number(e.target.value) || 0)}
              className="input w-32"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">New gold $/oz</label>
            <input
              type="number"
              value={newGold}
              onChange={(e) => setNewGold(Number(e.target.value) || 0)}
              className="input w-32"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Upcharge %</label>
            <input
              type="number"
              value={upchargePct}
              onChange={(e) => setUpchargePct(Number(e.target.value) || 0)}
              className="input w-24"
              step="0.1"
            />
          </div>
          {isReverse && (
            <div>
              <label className="block text-xs text-gray-600 mb-1">Rebill baseline</label>
              <div className="flex gap-1 text-xs">
                <button
                  onClick={() => setBaselineMode("signet")}
                  className={`px-2 py-1.5 rounded border ${
                    baselineMode === "signet"
                      ? "bg-[#C5A572] text-white border-[#C5A572]"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  Signet's price
                </button>
                <button
                  onClick={() => setBaselineMode("ssp")}
                  className={`px-2 py-1.5 rounded border ${
                    baselineMode === "ssp"
                      ? "bg-[#C5A572] text-white border-[#C5A572]"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  Our SSP data
                </button>
              </div>
            </div>
          )}
          <div className="ml-auto">
            <button
              onClick={handleDownloadCSV}
              className="px-4 py-2 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          </div>
        </div>

        {/* Lines table */}
        {loading ? (
          <div className="p-8 text-center text-gray-500">loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Style #</th>
                  <th className="px-3 py-2">Metal</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Signet Unit</th>
                  <th className="px-3 py-2 text-right">Predicted (ours)</th>
                  <th className="px-3 py-2 text-right">Signet vs Ours</th>
                  <th className="px-3 py-2 text-right">Implied $/oz</th>
                  <th className="px-3 py-2 text-center">Reconcile</th>
                  <th className="px-3 py-2 text-right">New Unit</th>
                  <th className="px-3 py-2 text-right">Δ Unit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reconciled.map((r) => {
                  const impliedPct =
                    lock != null && r.impliedRate != null
                      ? ((r.impliedRate - lock) / lock) * 100
                      : null;
                  return (
                    <tr key={r.line.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono">{r.line.sku_number || "—"}</td>
                      <td className="px-3 py-2 font-mono">{r.line.vendor_style_number || "—"}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.metal ? `${r.metal.metalType} ${r.metal.karat ?? ""}`.trim() : "?"}
                      </td>
                      <td className="px-3 py-2 text-right">{r.line.quantity ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{dollar(r.line.unit_price)}</td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {dollar(r.predictedAtLock)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          r.signetVsOurs == null
                            ? ""
                            : Math.abs(r.signetVsOurs) < 0.05
                            ? "text-gray-500"
                            : r.signetVsOurs > 0
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {r.signetVsOurs == null
                          ? "—"
                          : `${r.signetVsOurs >= 0 ? "+" : ""}${dollar(r.signetVsOurs)}`}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.impliedRate ? `$${r.impliedRate.toFixed(2)}` : "—"}
                        {impliedPct != null && Math.abs(impliedPct) > 0.01 && (
                          <span
                            className={`block text-xs ${
                              Math.abs(impliedPct) < 1 ? "text-gray-500" : "text-red-500"
                            }`}
                          >
                            {impliedPct >= 0 ? "+" : ""}
                            {pct(impliedPct)} vs lock
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {!r.sku ? (
                          <span className="text-xs text-amber-600 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> no match
                          </span>
                        ) : r.reconcile === true ? (
                          <span className="text-xs text-green-600 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> ok
                          </span>
                        ) : (
                          <span className="text-xs text-red-600 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> mismatch
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{dollar(r.newBill)}</td>
                      <td
                        className={`px-3 py-2 text-right ${
                          r.deltaPerUnit == null
                            ? ""
                            : r.deltaPerUnit > 0
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {r.deltaPerUnit == null
                          ? "—"
                          : `${r.deltaPerUnit >= 0 ? "+" : ""}${dollar(r.deltaPerUnit)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="p-4 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
