import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { useMetalPriceStore } from "../../store/MetalPrices";
import {
  backEngineerMetalRate,
  recomputeSignetBill,
  resolveMetal,
} from "../../utils/runningLinesMath";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

// Shows per-line analysis for a PO.
//   direction === 'reverse'  →  back-engineering view (implied metal rate vs spot)
//   direction === 'forward'  →  forward-bill view (what to charge Signet at current spot)
export default function POLinesView({ po, onClose }) {
  const { supabase } = useSupabase();
  const prices = useMetalPriceStore((s) => s.prices);
  const [silverInput, setSilverInput] = useState(prices?.silver?.price ?? 30);
  const [goldInput, setGoldInput] = useState(prices?.gold?.price ?? 2400);
  const [lines, setLines] = useState([]);
  const [skuById, setSkuById] = useState(new Map());
  const [matBySsp, setMatBySsp] = useState(new Map());
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

      // Join: find matching running_line_skus by sku_number OR vendor_style_number
      const skuNumbers = [
        ...new Set((lineRows ?? []).map((l) => l.sku_number).filter(Boolean)),
      ];
      const vsns = [
        ...new Set((lineRows ?? []).map((l) => l.vendor_style_number).filter(Boolean)),
      ];

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
        const { data: matRows } = await supabase
          .from("running_line_materials")
          .select("ssp_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight")
          .in("ssp_number", sspList);
        const m = new Map();
        for (const r of matRows ?? []) {
          if (!m.has(r.ssp_number)) m.set(r.ssp_number, []);
          m.get(r.ssp_number).push(r);
        }
        setMatBySsp(m);
      }
      setLoading(false);
    })();
  }, [supabase, po]);

  const enriched = useMemo(() => {
    const out = [];
    for (const line of lines) {
      const sku =
        (line.sku_number && skuById.get(`sku:${line.sku_number}`)) ||
        (line.vendor_style_number && skuById.get(`vsn:${line.vendor_style_number}`)) ||
        null;
      const metal = sku ? resolveMetal(matBySsp.get(sku.ssp_number) || []) : null;
      const skuWithMetal = sku ? { ...sku, metal } : null;

      const direction = po.direction;
      const tariffPct = Number(po.tariff_percent ?? 0);
      const upchargePct = Number(po.upcharge_percent ?? 0);

      let impliedRate = null;
      let spotRate = null;
      let rateGap = null;
      let signetBill = null;

      if (skuWithMetal) {
        if (direction === "reverse") {
          impliedRate = backEngineerMetalRate(line, skuWithMetal, {
            tariffPct,
            upchargePct,
          });
          spotRate =
            metal.metalType === "Gold" ? goldInput : metal.metalType === "Brass" ? null : silverInput;
          if (impliedRate != null && spotRate != null) {
            rateGap = impliedRate - spotRate;
          }
        } else {
          signetBill = recomputeSignetBill(skuWithMetal, {
            silver: silverInput,
            gold: goldInput,
            tariffPct,
            upchargePct,
          });
        }
      }

      out.push({ line, sku: skuWithMetal, metal, impliedRate, spotRate, rateGap, signetBill });
    }
    return out;
  }, [lines, skuById, matBySsp, po, silverInput, goldInput]);

  const dollar = (n) =>
    n == null || !Number.isFinite(Number(n))
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const isReverse = po.direction === "reverse";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full my-8">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              PO {po.po_number || po.id.slice(0, 8)} ·{" "}
              {isReverse ? "Back-engineering" : "Forward-bill"}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {po.po_date || "—"} · {po.line_count ?? lines.length} lines · tariff {po.tariff_percent ?? 0}%
              {po.upcharge_percent ? ` · upcharge ${po.upcharge_percent}%` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-2">
            ×
          </button>
        </div>

        {/* Spot-rate inputs */}
        <div className="p-4 border-b bg-gray-50 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Silver spot $/oz</label>
            <input
              type="number"
              value={silverInput}
              onChange={(e) => setSilverInput(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Gold spot $/oz</label>
            <input
              type="number"
              value={goldInput}
              onChange={(e) => setGoldInput(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.01"
            />
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
                  <th className="px-3 py-2 text-right">Unit Price</th>
                  {isReverse ? (
                    <>
                      <th className="px-3 py-2 text-right">Implied $/oz</th>
                      <th className="px-3 py-2 text-right">Spot $/oz</th>
                      <th className="px-3 py-2 text-right">Gap</th>
                      <th className="px-3 py-2 text-center">Status</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-right">Should bill</th>
                      <th className="px-3 py-2 text-right">Δ</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {enriched.map(({ line, sku, metal, impliedRate, spotRate, rateGap, signetBill }) => {
                  const gapPct =
                    spotRate && rateGap != null ? (rateGap / spotRate) * 100 : null;
                  const status =
                    !sku
                      ? "no-ssp-match"
                      : gapPct == null
                      ? "—"
                      : Math.abs(gapPct) < 3
                      ? "ok"
                      : rateGap > 0
                      ? "overbilled"
                      : "underbilled";
                  const billDelta =
                    signetBill != null && line.unit_price
                      ? signetBill - Number(line.unit_price)
                      : null;
                  return (
                    <tr key={line.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono">{line.sku_number || "—"}</td>
                      <td className="px-3 py-2 font-mono">{line.vendor_style_number || "—"}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {metal ? `${metal.metalType} ${metal.karat ?? ""}`.trim() : "?"}
                      </td>
                      <td className="px-3 py-2 text-right">{line.quantity ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{dollar(line.unit_price)}</td>
                      {isReverse ? (
                        <>
                          <td className="px-3 py-2 text-right">{dollar(impliedRate)}</td>
                          <td className="px-3 py-2 text-right">{dollar(spotRate)}</td>
                          <td
                            className={`px-3 py-2 text-right ${
                              rateGap == null
                                ? ""
                                : rateGap > 0
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {rateGap == null
                              ? "—"
                              : `${rateGap >= 0 ? "+" : ""}${dollar(rateGap)} (${gapPct?.toFixed(1)}%)`}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {status === "no-ssp-match" ? (
                              <span className="text-xs text-amber-600 inline-flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> no match
                              </span>
                            ) : status === "ok" ? (
                              <span className="text-xs text-green-600 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> ok
                              </span>
                            ) : (
                              <span
                                className={`text-xs inline-flex items-center gap-1 ${
                                  status === "underbilled" ? "text-red-600" : "text-green-700"
                                }`}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {status}
                              </span>
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right">{dollar(signetBill)}</td>
                          <td
                            className={`px-3 py-2 text-right ${
                              billDelta == null
                                ? ""
                                : billDelta > 0
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {billDelta == null
                              ? "—"
                              : `${billDelta >= 0 ? "+" : ""}${dollar(billDelta)}`}
                          </td>
                        </>
                      )}
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
