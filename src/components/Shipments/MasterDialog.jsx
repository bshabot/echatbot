import React, { useState } from "react";
import { X } from "lucide-react";

// Create an inbound master (HK consolidation or direct shipment) and attach the
// selected POs to it. Dominic ships via DHL by default (decision #31).
export default function MasterDialog({ rows, onCancel, onSave, busy }) {
  const today = new Date().toISOString().slice(0, 10);
  const allDirect = rows.length > 0 && rows.every((r) => r.route === "direct");
  const [origin, setOrigin] = useState(allDirect ? "inah_direct" : "grandways_hk");
  const [carrier, setCarrier] = useState("DHL");
  const [tracking, setTracking] = useState("");
  const [departed, setDeparted] = useState(today);
  const [eta, setEta] = useState("");
  const [boxCount, setBoxCount] = useState(() =>
    rows.reduce((n, r) => n + (r.carton_count || 0), 0) || ""
  );

  function save() {
    onSave({
      master: {
        origin,
        carrier,
        tracking: tracking.trim() || null,
        departed_at: departed || null,
        eta: eta || null,
        box_count: parseInt(boxCount, 10) || null,
        tracking_status: tracking.trim() ? "in_transit" : "untracked",
      },
      shipmentIds: rows.map((r) => r.id),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">Inbound shipment to warehouse</div>
            <div className="text-sm text-gray-500">{rows.length} PO{rows.length === 1 ? "" : "s"} on board</div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Origin</span>
              <select value={origin} onChange={(e) => setOrigin(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm">
                <option value="grandways_hk">Grandways HK (Dominic)</option>
                <option value="inah_direct">Inah direct (Vietnam)</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Carrier</span>
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm">
                <option>DHL</option>
                <option>FedEx</option>
                <option>UPS</option>
                <option>Titan</option>
                <option>Other</option>
              </select>
            </label>
            <label className="block col-span-2">
              <span className="text-sm text-gray-600">Tracking / AWB</span>
              <input type="text" value={tracking} onChange={(e) => setTracking(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Departed</span>
              <input type="date" value={departed} onChange={(e) => setDeparted(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">ETA (optional)</span>
              <input type="date" value={eta} onChange={(e) => setEta(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Boxes</span>
              <input type="number" min="0" value={boxCount} onChange={(e) => setBoxCount(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="text-sm text-gray-600">
            {rows.map((r) => r.vendor_po).join(", ")}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : "Create shipment"}
          </button>
        </div>
      </div>
    </div>
  );
}
