import React, { useCallback, useEffect, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

// Automation + QuickBooks sync history (dropship_events). Shows what the bridge and the QB sync did, newest first.
export default function OrderStreamActivityCard() {
  const { supabase } = useSupabase();
  const open = true;
  const [filter, setFilter] = useState("all");
  const [showResolved, setShowResolved] = useState(false);
  const [ev, setEv] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    let q = supabase.from("dropship_events").select("id, created_at, step, outcome, po_number, invoice_number, response_status, response_excerpt").order("id", { ascending: false }).limit(200);
    if (filter === "qb") q = q.eq("step", "qb_invoice");
    if (filter === "errors") q = q.eq("outcome", "error");
    const { data } = await q;
    let rows = data ?? [];
    if (filter === "errors" && !showResolved && rows.length) {
      // An error is "resolved" once its order finished (done) with no error left on it.
      const pos = [...new Set(rows.map((e) => e.po_number).filter(Boolean))];
      const { data: jobs } = await supabase.from("dropship_jobs").select("po_number, status, error").in("po_number", pos);
      const fixed = new Set((jobs ?? []).filter((j) => j.status === "done" && !j.error).map((j) => j.po_number));
      rows = rows.filter((e) => !fixed.has(e.po_number));
    }
    setEv(rows);
    setBusy(false);
  }, [supabase, filter, showResolved]);
  useEffect(() => { load(); }, [load]);
  const chip = { ok: "text-green-700", error: "text-red-700", skipped: "text-amber-700" };
  return (
    <div className="rounded border">
      <div className="p-2 text-sm font-medium">Activity log (automation + QuickBooks sync)</div>
      {open && (
        <div className="border-t p-2 text-xs">
          <div className="mb-2 flex items-center gap-2">
            {[["all", "All"], ["qb", "QuickBooks sync"], ["errors", "Errors only"]].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded border px-2 py-0.5 ${filter === k ? "bg-gray-900 text-white" : "hover:bg-gray-50"}`}>{l}</button>
            ))}
            {filter === "errors" && (
              <label className="ml-2 inline-flex items-center gap-1 text-gray-600">
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
              </label>
            )}
            <button onClick={load} className="ml-auto text-blue-600 hover:underline">{busy ? "Loading..." : "Refresh"}</button>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-gray-50 text-left text-gray-500"><tr><th className="p-1">When</th><th className="p-1">Step</th><th className="p-1">Result</th><th className="p-1">PO</th><th className="p-1">Invoice</th><th className="p-1">Detail</th></tr></thead>
              <tbody>
                {ev.map((e) => (
                  <tr key={e.id} className="border-t align-top">
                    <td className="p-1 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                    <td className="p-1">{e.step === "qb_invoice" ? "QB sync" : e.step}</td>
                    <td className={`p-1 font-medium ${chip[e.outcome] ?? ""}`}>{e.outcome}</td>
                    <td className="p-1">{e.po_number}</td>
                    <td className="p-1">{e.invoice_number}</td>
                    <td className="p-1 max-w-md break-words text-gray-600">{e.response_excerpt}</td>
                  </tr>
                ))}
                {!ev.length && !busy && <tr><td colSpan={6} className="p-3 text-center text-gray-500">No events.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
