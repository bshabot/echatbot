import React, { useState } from "react";
import { X } from "lucide-react";

// Fix a needs_link row: set the real vendor PO number + vendor by hand.
// Sets link_source='manual' so sync never overwrites the human's call.
export default function LinkSODialog({ row, onCancel, onSave, busy }) {
  const isPlaceholder = String(row.vendor_po || "").startsWith("PO ");
  const [vendorPo, setVendorPo] = useState(isPlaceholder ? "" : row.vendor_po);
  const [vendor, setVendor] = useState(row.vendor || "");

  function save() {
    if (!vendorPo.trim() || !vendor) return;
    onSave({
      id: row.id,
      patch: {
        vendor_po: vendorPo.trim(),
        vendor,
        link_source: "manual",
      },
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

        <div className="px-5 py-4 grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Vendor PO #</span>
            <input type="text" value={vendorPo} onChange={(e) => setVendorPo(e.target.value)}
              placeholder="12689" className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Vendor</span>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}
              className="mt-1 block w-full border rounded px-3 py-2 text-sm">
              <option value="">— pick —</option>
              <option>Aoxin</option>
              <option>Amtai</option>
              <option>CIJ</option>
              <option>Inah</option>
            </select>
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy || !vendorPo.trim() || !vendor}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : "Link"}
          </button>
        </div>
      </div>
    </div>
  );
}
