import React, { useEffect, useState } from "react";
import { X, TriangleAlert, CheckCircle2, RefreshCw } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import { checkSoAgainstLivePos } from "../../utils/soLiveReconcile";

// PROTOTYPE — manual trigger only (Kevin 8/20: "lets not do schedule one
// just a prototype with manual loading"). Pulls REAL line items off every
// internal PO linked to this SO, live from QuickBooks via qb-connector, and
// sums actual quantities against the Signet SO's own item list. This is the
// accurate counterpart to the "N items missing" badge on the board (which
// guesses vendor responsibility from aliases, not real PO contents) — see
// utils/soLiveReconcile.js's header for why this can't just run on a
// schedule yet (the connector only answers on the QuickBooks machine/network).
export default function SoLiveCheckDialog({ soNumber, onClose }) {
  const { supabase } = useSupabase();
  const [state, setState] = useState({ loading: true, error: null, data: null });

  async function run() {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await checkSoAgainstLivePos(supabase, soNumber);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e?.message || String(e), data: null });
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soNumber]);

  const qty = (n) => Number(n || 0).toLocaleString();

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] max-md:max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">Live PO check — SO {soNumber}</div>
            <div className="text-sm text-gray-500">
              Real line items from QuickBooks vs. what the sales order calls for
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={run}
              disabled={state.loading}
              title="Re-check"
              className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${state.loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {state.loading && (
            <div className="text-sm text-gray-400 py-6 text-center">
              Pulling PO line items from QuickBooks — this calls the connector directly,
              so it needs QuickBooks open and reachable.
            </div>
          )}
          {state.error && (
            <div className="text-sm text-red-600 py-4">
              Couldn't complete the check: {state.error}
              <div className="text-xs text-gray-400 mt-1">
                Most likely the QuickBooks connector isn't reachable right now (QuickBooks
                needs to be open on the machine running it).
              </div>
            </div>
          )}

          {state.data && (
            <>
              <div className="text-xs text-gray-500 mb-3">
                Checked {state.data.checkedPos.length} internal PO
                {state.data.checkedPos.length === 1 ? "" : "s"}:{" "}
                {state.data.checkedPos.map((p, i) => (
                  <span key={p.refNumber} className="mr-2">
                    {p.refNumber}
                    {p.vendor ? ` (${p.vendor})` : ""}
                    {p.ok ? (
                      <CheckCircle2 className="w-3 h-3 inline ml-0.5 text-green-600" />
                    ) : (
                      <TriangleAlert className="w-3 h-3 inline ml-0.5 text-red-600" title={p.error} />
                    )}
                  </span>
                ))}
                {state.data.checkedPos.length === 0 && "none linked on the Shipments board yet."}
              </div>

              {!state.data.anyShort ? (
                <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Every item on this SO is fully covered by the linked internal PO(s).
                </div>
              ) : (
                <div className="border rounded overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 bg-gray-50">
                        <th className="p-2">SKU</th>
                        <th className="p-2">Style</th>
                        <th className="p-2">Description</th>
                        <th className="p-2 text-right">SO qty</th>
                        <th className="p-2 text-right">On PO(s)</th>
                        <th className="p-2 text-right">Short</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.lines
                        .filter((l) => l.short)
                        .map((l) => (
                          <tr key={l.sku} className="border-t border-red-100 bg-red-50">
                            <td className="p-2 whitespace-nowrap font-medium">{l.sku}</td>
                            <td className="p-2 whitespace-nowrap">{l.model}</td>
                            <td className="p-2 text-gray-600">{l.description || "—"}</td>
                            <td className="p-2 text-right">{qty(l.soQty)}</td>
                            <td className="p-2 text-right">{qty(l.poQty)}</td>
                            <td className="p-2 text-right text-red-700 font-medium">
                              {qty(l.soQty - l.poQty)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              <details className="mt-3">
                <summary className="text-[11px] text-gray-400 cursor-pointer select-none">
                  Show all {state.data.lines.length} SO lines (including fully covered)
                </summary>
                <div className="border rounded overflow-x-auto mt-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 bg-gray-50">
                        <th className="p-2">SKU</th>
                        <th className="p-2">Style</th>
                        <th className="p-2 text-right">SO qty</th>
                        <th className="p-2 text-right">On PO(s)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.lines.map((l) => (
                        <tr key={l.sku} className={`border-t border-gray-100 ${l.short ? "bg-red-50" : ""}`}>
                          <td className="p-2 whitespace-nowrap">{l.sku}</td>
                          <td className="p-2 whitespace-nowrap">{l.model}</td>
                          <td className="p-2 text-right">{qty(l.soQty)}</td>
                          <td className={`p-2 text-right ${l.short ? "text-red-700 font-medium" : ""}`}>
                            {qty(l.poQty)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
