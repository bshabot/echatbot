import React, { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";

// Fix a needs_link row: attach one OR MORE vendor POs to the Signet PO by hand.
// First entry replaces the placeholder row; extra entries become new sibling
// rows on the same Signet PO. Everything saved as link_source='manual' so the
// sync never overwrites the human's call.
export default function LinkSODialog({ row, onCancel, onSave, busy }) {
  const isPlaceholder = String(row.vendor_po || "").startsWith("PO ");
  const [entries, setEntries] = useState([
    { vendorPo: isPlaceholder ? "" : row.vendor_po, vendor: row.vendor || "" },
  ]);

  const setEntry = (i, field, value) =>
    setEntries((list) => list.map((e, j) => (j === i ? { ...e, [field]: value } : e)));
  const addEntry = () => setEntries((list) => [...list, { vendorPo: "", vendor: "" }]);
  const removeEntry = (i) => setEntries((list) => list.filter((_, j) => j !== i));

  const valid = entries.length > 0 && entries.every((e) => e.vendorPo.trim() && e.vendor);

  function save() {
    if (!valid) return;
    onSave({
      row,
      entries: entries.map((e) => ({ vendorPo: e.vendorPo.trim(), vendor: e.vendor })),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">Link PO ↔ SO</div>
            <div className="text-sm text-gray-500">
              Signet PO {row.signet_po_number || "—"}
              {row.memo_note ? <> · memo: <span className="italic">{row.memo_note}</span></> : null}
            </div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {entries.map((e, i) => (
            <div key={i} className="flex items-end gap-3">
              <label className="block flex-1">
                {i === 0 && <span className="text-sm text-gray-600">Vendor PO #</span>}
                <input type="text" value={e.vendorPo}
                  onChange={(ev) => setEntry(i, "vendorPo", ev.target.value)}
                  placeholder="12689" className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
              </label>
              <label className="block flex-1">
                {i === 0 && <span className="text-sm text-gray-600">Vendor</span>}
                <select value={e.vendor} onChange={(ev) => setEntry(i, "vendor", ev.target.value)}
                  className="mt-1 block w-full border rounded px-3 py-2 text-sm">
                  <option value="">— pick —</option>
                  <option>Aoxin</option>
                  <option>Amtai</option>
                  <option>CIJ</option>
                  <option>Inah</option>
                </select>
              </label>
              {entries.length > 1 ? (
                <button onClick={() => removeEntry(i)} title="Remove"
                  className="pb-2.5 text-gray-400 hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              ) : (
                <span className="w-4" />
              )}
            </div>
          ))}

          <button onClick={addEntry}
            className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
            <Plus size={14} /> add another vendor PO on this order
          </button>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy || !valid}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : entries.length > 1 ? `Link ${entries.length} POs` : "Link"}
          </button>
        </div>
      </div>
    </div>
  );
}
