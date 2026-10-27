import React, { useEffect, useMemo, useState } from "react";
import useEscapeKey from "../../Hooks/useEscapeKey";
import { X, Copy } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import { computeShipmentStats } from "../../utils/shipmentStats";

// Stats for the selected shipments: pieces by product type, with the average
// unit price and average piece weight of each type. See utils/shipmentStats.js
// for where each number comes from.
const money = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const num = (n) => Number(n || 0).toLocaleString();
const grams = (n) => (n == null ? "—" : Number(n).toFixed(2));

export default function ShipmentStatsDialog({ rows, title = "Shipment stats", onClose }) {
  useEscapeKey(onClose);
  const { supabase } = useSupabase();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let dead = false;
    computeShipmentStats(supabase, rows)
      .then((data) => !dead && setState({ loading: false, error: null, data }))
      .catch((e) => {
        console.error("ShipmentStatsDialog:", e);
        if (!dead) setState({ loading: false, error: e.message || String(e), data: null });
      });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const d = state.data;
  const tsv = useMemo(() => {
    if (!d?.totals) return "";
    const head = ["Type", "Qty", "Styles", "Avg cost", "Avg weight (g)", "Total cost"].join("\t");
    const body = d.types.map((t) =>
      [t.type, t.qty, t.styles,
        t.avgPrice == null ? "" : t.avgPrice.toFixed(2), t.avgWeight == null ? "" : t.avgWeight.toFixed(2),
        t.totalValue.toFixed(2)].join("\t"));
    const foot = ["Total", d.totals.qty, d.totals.styles,
      d.totals.avgPrice == null ? "" : d.totals.avgPrice.toFixed(2),
      d.totals.avgWeight == null ? "" : d.totals.avgWeight.toFixed(2),
      d.totals.totalValue.toFixed(2)].join("\t");
    return [head, ...body, foot].join("\n");
  }, [d]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy failed", e);
    }
  }

  const n = d?.notes;
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] max-md:max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">{title}</div>
            <div className="text-sm text-gray-500">
              {rows.length} PO{rows.length === 1 ? "" : "s"}
              {d?.totals ? ` · ${num(d.totals.qty)} pcs · ${money(d.totals.totalValue)}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4">
          {state.loading && <div className="text-sm text-gray-500 py-8 text-center">Reading PO lines…</div>}
          {state.error && <div className="text-sm text-red-600 py-4">Couldn't build the report: {state.error}</div>}
          {d && !d.totals && (
            <div className="text-sm text-gray-500 py-6 text-center">
              None of the selected POs are linked to a Signet SO, so there are no lines to report on.
            </div>
          )}
          {d?.totals && (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase">
                    <th className="py-1">Type</th>
                    <th className="py-1 text-right">Qty</th>
                    <th className="py-1 text-right">Styles</th>
                    <th className="py-1 text-right">Avg cost</th>
                    <th className="py-1 text-right">Avg weight (g)</th>
                    <th className="py-1 text-right">Total cost</th>
                  </tr>
                </thead>
                <tbody>
                  {d.types.map((t) => (
                    <tr key={t.type} className="border-t">
                      <td className="py-1.5 font-medium">{t.type}</td>
                      <td className="py-1.5 text-right">{num(t.qty)}</td>
                      <td className="py-1.5 text-right text-gray-500">{t.styles}</td>
                      <td className="py-1.5 text-right">{money(t.avgPrice)}</td>
                      <td className="py-1.5 text-right">{grams(t.avgWeight)}</td>
                      <td className="py-1.5 text-right">{money(t.totalValue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-1.5">Total</td>
                    <td className="py-1.5 text-right">{num(d.totals.qty)}</td>
                    <td className="py-1.5 text-right">{d.totals.styles}</td>
                    <td className="py-1.5 text-right">{money(d.totals.avgPrice)}</td>
                    <td className="py-1.5 text-right">{grams(d.totals.avgWeight)}</td>
                    <td className="py-1.5 text-right">{money(d.totals.totalValue)}</td>
                  </tr>
                </tfoot>
              </table>

              <div className="mt-4 text-xs text-gray-500 space-y-1">
                {n.noWeightPcs > 0 && <div className="text-amber-700">{num(n.noWeightPcs)} pcs have no weight on file and are left out of the weight averages.</div>}
                {n.noPricePcs > 0 && <div className="text-amber-700">{num(n.noPricePcs)} pcs have no cost on file and are left out of the cost averages.</div>}
                {n.cancelled > 0 && <div>{num(n.cancelled)} cancelled pcs are not counted.</div>}
                {n.unmatched > 0 && <div className="text-amber-700">{num(n.unmatched)} pcs on these SOs couldn't be matched to any vendor and are not counted.</div>}
                {n.dupePos.length > 0 && <div>{n.dupePos.join(", ")} share a vendor and SO with another selected PO, so their lines are counted once.</div>}
                {n.noSo.length > 0 && <div className="text-amber-700">No Signet SO linked, so not included: {n.noSo.join(", ")}.</div>}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          {d?.totals && (
            <button onClick={copy} className="flex items-center gap-1.5 px-4 py-2 text-sm rounded border hover:bg-gray-100">
              <Copy size={14} /> {copied ? "Copied" : "Copy for Excel"}
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black">Close</button>
        </div>
      </div>
    </div>
  );
}
