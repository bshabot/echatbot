import React, { useState } from "react";
import { X } from "lucide-react";

// The ONE inbound stamp. Stamp off whichever email you're looking at —
// vendor ship notice or Dominic's arrival confirm; it's just a date.
// Writes factory_shipped_at + per-PO box count + optional shared tracking
// + an optional note (applied to every selected PO; notes print on the
// warehouse manifest later).
export default function MarkShippedDialog({ rows, onCancel, onSave, busy }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");
  const [boxes, setBoxes] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.carton_count ?? "";
    return m;
  });

  function save() {
    const patches = {};
    const noteText = note.trim();
    for (const r of rows) {
      const p = { factory_shipped_at: date };
      if (tracking.trim()) p.leg1_tracking = tracking.trim();
      const c = parseInt(boxes[r.id], 10);
      if (Number.isFinite(c) && c > 0) p.carton_count = c;
      if (noteText) {
        // append, never clobber an existing note
        p.notes = r.notes ? `${r.notes}; ${noteText}` : noteText;
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
            <div className="font-semibold text-lg">Mark shipped</div>
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
              <span className="text-sm text-gray-600">Tracking (optional, shared)</span>
              <input type="text" value={tracking} onChange={(e) => setTracking(e.target.value)}
                placeholder="SF / DHL / UPS #"
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase">
                <th className="py-1">Vendor PO</th>
                <th className="py-1">Vendor</th>
                <th className="py-1">SO</th>
                <th className="py-1 w-24">Boxes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 font-medium">{r.vendor_po}</td>
                  <td className="py-1.5">{r.vendor || "—"}</td>
                  <td className="py-1.5">{r.signet_po_number || "—"}</td>
                  <td className="py-1">
                    <input type="number" min="0" value={boxes[r.id]}
                      onChange={(e) => setBoxes((m) => ({ ...m, [r.id]: e.target.value }))}
                      className="w-20 border rounded px-2 py-1 text-sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="block">
            <span className="text-sm text-gray-600">Note (optional — saved on every selected PO, prints on the manifest)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="e.g. partial — balance ships next week"
              className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : `Mark ${rows.length} shipped`}
          </button>
        </div>
      </div>
    </div>
  );
}
