import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  downloadManifestPdf,
  downloadManifestExcel,
  downloadPickupRequestPdf,
} from "../../utils/shipmentDocs";
import { getWritableDocFolder } from "../../utils/docFolder";

// Ship out to Signet (decisions #8, #12, #24, #25):
// multi-select POs -> invoices typed from QB (one-for-batch OR per-PO) ->
// carrier + tracking (master OR per-box) -> manifest PDF + Excel + Titan pickup
// request -> rows flip CLOSED.
export default function ShipOutDialog({ rows, onCancel, onConfirm, busy }) {
  const today = new Date().toISOString().slice(0, 10);
  // Pre-entry (Ezra 7/20): out_invoice / out_tracking typed ahead of time on
  // the In transit tab land here as defaults — everything stays editable.
  const anyPreTracking = rows.some((r) => r.out_tracking);
  const [carrier, setCarrier] = useState("Titan");
  const [trackingMode, setTrackingMode] = useState(anyPreTracking ? "per_box" : "master"); // master | per_box
  const [masterTracking, setMasterTracking] = useState("");
  // Kevin 7/6: invoices are ALWAYS per PO — no batch invoice option.
  const invoiceMode = "per_po";
  const batchInvoice = "";
  const [perPoInvoice, setPerPoInvoice] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.out_invoice || "";
    return m;
  });
  const [boxes, setBoxes] = useState(() => {
    const m = {};
    for (const r of rows) m[r.id] = r.carton_count || 1;
    return m;
  });
  const [perBoxTracking, setPerBoxTracking] = useState(() => {
    // "shipmentId:boxIdx" -> tracking; a pre-entered PO # fills all its boxes
    const m = {};
    for (const r of rows) {
      if (!r.out_tracking) continue;
      const count = Math.max(1, parseInt(r.carton_count, 10) || 1);
      for (let i = 0; i < count; i++) m[`${r.id}:${i}`] = r.out_tracking;
    }
    return m;
  });
  const [shipDate, setShipDate] = useState(today);
  const [pickupWindow, setPickupWindow] = useState("");
  // Declared value (Brian 7/2): NEVER count a sales order's dollars twice.
  // Per SO group: if every vendor PO has a QB per-PO amount, sum those (exact).
  // Otherwise fall back to the Signet order total counted ONCE for the whole
  // group — mildly over-declares if a sibling PO isn't in this batch, which is
  // the safe direction for an insured pickup. Field stays editable.
  const autoValue = useMemo(() => {
    const groups = new Map();
    const solo = [];
    for (const r of rows) {
      if (!r.signet_po_number) { solo.push(r); continue; }
      const g = groups.get(r.signet_po_number) || [];
      g.push(r);
      groups.set(r.signet_po_number, g);
    }
    let total = 0;
    for (const r of solo) total += Number(r.qb_amount ?? r.amount) || 0;
    for (const g of groups.values()) {
      if (g.every((r) => r.qb_amount != null)) {
        for (const r of g) total += Number(r.qb_amount) || 0;
      } else {
        total += Number(g[0].amount ?? g[0].qb_amount) || 0; // once per SO
      }
    }
    return total;
  }, [rows]);
  const [declaredValue, setDeclaredValue] = useState(() => Math.round(autoValue));
  const [makePickupDoc, setMakePickupDoc] = useState(true);

  // sortable grid: Vendor PO / SO / Vendor
  const [sort, setSort] = useState({ key: "po", dir: "asc" });
  const clickSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const sortArrow = (key) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const sortedRows = useMemo(() => {
    const val = (r) => {
      switch (sort.key) {
        case "po": { const n = parseInt(r.vendor_po, 10); return Number.isFinite(n) ? n : null; }
        case "so": { const n = parseInt(r.signet_po_number, 10); return Number.isFinite(n) ? n : null; }
        case "vendor": return r.vendor || null;
        default: return null;
      }
    };
    return [...rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? c : -c;
    });
  }, [rows, sort]);

  const totalBoxes = useMemo(
    () => rows.reduce((n, r) => n + Math.max(1, parseInt(boxes[r.id], 10) || 1), 0),
    [rows, boxes]
  );

  // Build the flat per-box list the manifest + DB write both use.
  // Follows the on-screen sort so the manifest box order matches the grid.
  function buildBoxList() {
    const list = [];
    let boxNumber = 0;
    for (const r of sortedRows) {
      // every PO going out is at least one physical box — a blank/0 count would
      // silently produce an empty manifest, so floor it at 1
      const count = Math.max(1, parseInt(boxes[r.id], 10) || 1);
      const invoice = invoiceMode === "batch" ? batchInvoice.trim() : (perPoInvoice[r.id] || "").trim();
      for (let i = 0; i < count; i++) {
        boxNumber += 1;
        list.push({
          boxNumber,
          shipmentId: r.id,
          invoiceNumber: invoice,
          vendorPo: r.vendor_po,
          signetPo: r.signet_po_number || "",
          tracking: trackingMode === "per_box" ? (perBoxTracking[`${r.id}:${i}`] || "").trim() : "",
          note: r.notes || "",
        });
      }
    }
    return list;
  }

  const invoicesMissing =
    invoiceMode === "batch"
      ? !batchInvoice.trim()
      : rows.some((r) => !(perPoInvoice[r.id] || "").trim());

  async function confirm(generateDocs) {
    // resolve the docs folder FIRST — the permission prompt needs the click
    // gesture fresh, and the DB writes below take a couple seconds
    const docDir = generateDocs ? await getWritableDocFolder() : null;
    const boxList = buildBoxList();
    const batch = {
      carrier,
      masterTracking: trackingMode === "master" ? masterTracking.trim() || null : null,
      shippedDate: shipDate,
      totalBoxes,
      pickupWindow: pickupWindow.trim() || null,
      declaredValue: Number(declaredValue) || null,
    };
    await onConfirm({ batch, boxList, invoiceMode, batchInvoice: batchInvoice.trim(), perPoInvoice });
    if (generateDocs) {
      await downloadManifestPdf(batch, boxList, docDir);
      await downloadManifestExcel(batch, boxList, docDir);
      if (makePickupDoc && carrier === "Titan") {
        await downloadPickupRequestPdf(
          {
            pickupDate: shipDate,
            windowText: pickupWindow,
            totalBoxes,
            declaredValue: Number(declaredValue) || null,
            reference: rows.map((r) => r.vendor_po).join(", "),
          },
          docDir
        );
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] max-md:max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">Ship out to Signet</div>
            <div className="text-sm text-gray-500">
              {rows.length} PO{rows.length === 1 ? "" : "s"} · {totalBoxes} box{totalBoxes === 1 ? "" : "es"} · ${Number(declaredValue || 0).toLocaleString()}
            </div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* carrier + tracking */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Carrier</span>
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm">
                <option>Titan</option>
                <option>UPS</option>
                <option>FedEx</option>
                <option>Other</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Tracking</span>
              <select value={trackingMode} onChange={(e) => setTrackingMode(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm">
                <option value="master">One master #</option>
                <option value="per_box">Per box</option>
              </select>
            </label>
            {trackingMode === "master" && (
              <label className="block col-span-2">
                <span className="text-sm text-gray-600">Master tracking / Titan Pro # (can add later)</span>
                <input type="text" value={masterTracking} onChange={(e) => setMasterTracking(e.target.value)}
                  className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
              </label>
            )}
            <label className="block">
              <span className="text-sm text-gray-600">Ship date</span>
              <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)}
                className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
            </label>
            {carrier === "Titan" && (
              <>
                <label className="block">
                  <span className="text-sm text-gray-600">Pickup window</span>
                  <input type="text" value={pickupWindow} onChange={(e) => setPickupWindow(e.target.value)}
                    placeholder="3PM-5PM" className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Declared value (auto-summed)</span>
                  <input type="number" value={declaredValue} onChange={(e) => setDeclaredValue(e.target.value)}
                    className="mt-1 block w-full border rounded px-3 py-2 text-sm" />
                </label>
                <label className="flex items-end gap-2 pb-2">
                  <input type="checkbox" checked={makePickupDoc} onChange={(e) => setMakePickupDoc(e.target.checked)} />
                  <span className="text-sm text-gray-600">Generate pickup request</span>
                </label>
              </>
            )}
          </div>

          {/* invoices */}
          <div>
            <div className="flex items-center gap-4 mb-2">
              <span className="text-sm font-medium">Invoice # per PO (from QuickBooks)</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase select-none">
                  <th className="py-1 cursor-pointer" onClick={() => clickSort("po")}>Vendor PO{sortArrow("po")}</th>
                  <th className="py-1 cursor-pointer" onClick={() => clickSort("so")}>SO{sortArrow("so")}</th>
                  <th className="py-1 cursor-pointer" onClick={() => clickSort("vendor")}>Vendor{sortArrow("vendor")}</th>
                  <th className="py-1 w-24">Boxes</th>
                  {invoiceMode === "per_po" && <th className="py-1 w-32">Invoice #</th>}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr className="border-t">
                      <td className="py-1.5 font-medium">{r.vendor_po}</td>
                      <td className="py-1.5">{r.signet_po_number || "—"}</td>
                      <td className="py-1.5">{r.vendor || "—"}</td>
                      <td className="py-1">
                        <input type="number" min="1" value={boxes[r.id]}
                          onChange={(e) => setBoxes((m) => ({ ...m, [r.id]: e.target.value }))}
                          className="w-20 border rounded px-2 py-1 text-sm" />
                      </td>
                      {invoiceMode === "per_po" && (
                        <td className="py-1">
                          <input type="text" value={perPoInvoice[r.id]}
                            onChange={(e) => setPerPoInvoice((m) => ({ ...m, [r.id]: e.target.value }))}
                            placeholder="692245" className="w-28 border rounded px-2 py-1 text-sm" />
                        </td>
                      )}
                    </tr>
                    {trackingMode === "per_box" &&
                      Array.from({ length: parseInt(boxes[r.id], 10) || 0 }).map((_, i) => (
                        <tr key={`${r.id}:${i}`}>
                          <td></td>
                          <td colSpan={2} className="py-1 text-xs text-gray-500 text-right pr-2">
                            box {i + 1} tracking
                          </td>
                          <td colSpan={2} className="py-1">
                            <input type="text" value={perBoxTracking[`${r.id}:${i}`] || ""}
                              onChange={(e) =>
                                setPerBoxTracking((m) => ({ ...m, [`${r.id}:${i}`]: e.target.value }))}
                              placeholder="1Z71A562..." className="w-full border rounded px-2 py-1 text-xs" />
                          </td>
                        </tr>
                      ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {invoicesMissing && (
              <div className="text-xs text-amber-600 mt-1">
                Invoice # missing — you can still close and add it later from the batch.
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center px-5 py-4 border-t bg-gray-50 rounded-b-lg max-md:flex-col max-md:items-stretch max-md:gap-2 max-md:px-3">
          <div className="text-xs text-gray-500">Closes {rows.length} PO{rows.length === 1 ? "" : "s"} — they drop off the open board.</div>
          <div className="flex gap-2 max-md:justify-end">
            <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
            <button onClick={() => confirm(true)} disabled={busy}
              className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
              {busy ? "Working…" : "Ship out + print docs"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
