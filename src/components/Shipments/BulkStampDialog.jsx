import React, { useState } from "react";
import { X } from "lucide-react";

// One dialog, three stamps (decision #30: every stamp is bulk).
// kind: 'factory' | 'hk' | 'received'
// rows: selected shipments. onDone(patchesById) applies per-row patches.
const TITLES = {
  factory: "Factory shipped",
  hk: "Arrived at HK (Dominic)",
  received: "Received at warehouse",
};

export default function BulkStampDialog({ kind, rows, onCancel, onSave, busy }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [tracking, setTracking] = useState("");
  const [cartons, setCartons] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.carton_count ?? "";
    return m;
  });

  const title = TITLES[kind] || "Stamp";

  function save() {
    const patches = {};
    for (const r of rows) {
      const p = {};
      if (kind === "factory") {
        p.factory_shipped_at = date;
        if (tracking.trim()) p.leg1_tracking = tracking.trim();
        const c = parseInt(cartons[r.id], 10);
        if (Number.isFinite(c) && c > 0) p.carton_count = c;
      } else if (kind === "hk") {
        p.hk_arrived_at = date;
      } else if (kind === "received") {
        p.received_confirmed_at = date;
      }
      patches[r.id] = p;
    }
    onSave(patches);
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">{title}</div>
            <div className="text-sm text-gray-500">{rows.length} PO{rows.length === 1 ? "" : "s"} selected</div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="mt-1 block border rounded px-3 py-2 text-sm" />
            </label>
            {kind === "factory" && (
              <label className="block flex-1">
                <span className="text-sm text-gray-600">Tracking (SF# / courier) — shared</span>
                <input type="text" value={tracking} onChange={(e) => setTracking(e.target.value)}
                  placeholder="SF0216874221063"
                  className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
              </label>
            )}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase">
                <th className="py-1">Vendor PO</th>
                <th className="py-1">Vendor</th>
                <th className="py-1">SO</th>
                {kind === "factory" && <th className="py-1 w-24">Cartons</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 font-medium">{r.vendor_po}</td>
                  <td className="py-1.5">{r.vendor || "—"}</td>
                  <td className="py-1.5">{r.signet_po_number || "—"}</td>
                  {kind === "factory" && (
                    <td className="py-1">
                      <input type="number" min="0" value={cartons[r.id]}
                        onChange={(e) => setCartons((m) => ({ ...m, [r.id]: e.target.value }))}
                        className="w-20 border rounded px-2 py-1 text-sm" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : `Stamp ${rows.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
