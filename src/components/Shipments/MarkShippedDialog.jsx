import React, { useState } from "react";
import { X } from "lucide-react";

// Two modes, same dialog:
//   mode="ship"   (Ordered → Hong Kong): stamps factory_shipped_at
//   mode="depart" (Hong Kong → In transit): a FRESH shipping event — Dominic's
//     consolidation going out. Stamps hk_departed_at with a new date, and this
//     is where the HK→warehouse tracking number goes.
// Boxes + per-PO notes come prefilled so they're editable either way.
export default function MarkShippedDialog({ rows, onCancel, onSave, busy, mode = "ship" }) {
  const depart = mode === "depart";
  const today = new Date().toISOString().slice(0, 10);
  const existingTracking = rows.find((r) => r.leg1_tracking)?.leg1_tracking;
  const [date, setDate] = useState(today);
  const [tracking, setTracking] = useState(existingTracking || "");
  const [boxes, setBoxes] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.carton_count ?? "";
    return m;
  });
  const [notes, setNotes] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.notes ?? "";
    return m;
  });

  function save() {
    const patches = {};
    for (const r of rows) {
      const p = depart ? { hk_departed_at: date } : { factory_shipped_at: date };
      if (tracking.trim()) p.leg1_tracking = tracking.trim();
      const c = parseInt(boxes[r.id], 10);
      if (Number.isFinite(c) && c > 0) p.carton_count = c;
      const noteText = (notes[r.id] ?? "").trim();
      if (noteText !== (r.notes ?? "")) p.notes = noteText || null;
      patches[r.id] = p;
    }
    onSave(patches);
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">{depart ? "Ship from Hong Kong → In transit" : "Mark shipped"}</div>
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
            <label className="block flex-1">
              <span className="text-sm text-gray-600">{depart ? "Tracking — HK → warehouse (optional, shared)" : "Tracking (optional, shared)"}</span>
              <input type="text" value={tracking} onChange={(e) => setTracking(e.target.value)}
                placeholder={depart ? "DHL / FedEx / UPS #" : "SF / DHL / UPS #"}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase">
                <th className="py-1">Vendor PO</th>
                <th className="py-1">Vendor</th>
                <th className="py-1">SO</th>
                <th className="py-1 w-20">Boxes</th>
                <th className="py-1">Note (prints on manifest)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 font-medium">{r.vendor_po}</td>
                  <td className="py-1.5">{r.vendor || "—"}</td>
                  <td className="py-1.5">{r.signet_po_number || "—"}</td>
                  <td className="py-1 pr-2">
                    <input type="number" min="0" value={boxes[r.id]}
                      onChange={(e) => setBoxes((m) => ({ ...m, [r.id]: e.target.value }))}
                      className="w-16 border rounded px-2 py-1 text-sm" />
                  </td>
                  <td className="py-1">
                    <input type="text" value={notes[r.id]}
                      onChange={(e) => setNotes((m) => ({ ...m, [r.id]: e.target.value }))}
                      placeholder="—"
                      className="w-full border rounded px-2 py-1 text-sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : depart ? `Ship ${rows.length} → In transit` : `Mark ${rows.length} shipped`}
          </button>
        </div>
      </div>
    </div>
  );
}
