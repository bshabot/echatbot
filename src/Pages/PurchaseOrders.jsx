import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import POUploader from "../components/RunningLines/POUploader";
import POLinesView from "../components/RunningLines/POLinesView";

// Consolidated PO page: both factory POs (forward — what we pay the factory,
// then mark up to bill Signet) and Signet POs (reverse — what Signet is paying
// us, used to decode the metal lock they used and verify line prices).
// Same math, same view, same uploader — just a direction toggle.

export default function PurchaseOrders() {
  const { supabase } = useSupabase();
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPo, setSelectedPo] = useState(null);
  const [filter, setFilter] = useState("all"); // all | forward | reverse
  const [uploadDirection, setUploadDirection] = useState("forward");

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase
        .from("running_line_purchase_orders")
        .select("*")
        .order("po_date", { ascending: false });
      if (error) console.error(error.message);
      setPos(data ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  const dollar = (n) =>
    n == null
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const filtered = useMemo(() => {
    if (filter === "all") return pos;
    return pos.filter((p) => p.direction === filter);
  }, [pos, filter]);

  const counts = useMemo(() => {
    let forward = 0, reverse = 0;
    for (const p of pos) {
      if (p.direction === "forward") forward++;
      else if (p.direction === "reverse") reverse++;
    }
    return { all: pos.length, forward, reverse };
  }, [pos]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Purchase Orders</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a factory PO to forward-bill Signet at any metal lock, or upload
          a Signet PO to decode the lock they used and verify the lines.
        </p>
      </div>

      {/* Upload section with direction toggle */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
        <div>
          <div className="text-xs font-medium text-gray-700 mb-1">PO type</div>
          <div className="flex gap-1 text-xs">
            <button
              onClick={() => setUploadDirection("forward")}
              className={`px-3 py-1.5 rounded border ${
                uploadDirection === "forward"
                  ? "bg-[#C5A572] text-white border-[#C5A572]"
                  : "bg-white text-gray-700 border-gray-300"
              }`}
            >
              Factory PO (we bill Signet)
            </button>
            <button
              onClick={() => setUploadDirection("reverse")}
              className={`px-3 py-1.5 rounded border ${
                uploadDirection === "reverse"
                  ? "bg-[#C5A572] text-white border-[#C5A572]"
                  : "bg-white text-gray-700 border-gray-300"
              }`}
            >
              Signet PO (verify)
            </button>
          </div>
        </div>
        <POUploader
          key={uploadDirection}
          direction={uploadDirection}
          onUploaded={(po) => setPos((prev) => [po, ...prev])}
        />
      </div>

      {/* Filter + list */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="text-sm font-medium text-gray-700">Past uploads</div>
          <div className="flex gap-1 text-xs">
            <button
              onClick={() => setFilter("all")}
              className={`px-2 py-1 rounded ${
                filter === "all" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              All ({counts.all})
            </button>
            <button
              onClick={() => setFilter("forward")}
              className={`px-2 py-1 rounded ${
                filter === "forward" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              Factory ({counts.forward})
            </button>
            <button
              onClick={() => setFilter("reverse")}
              className={`px-2 py-1 rounded ${
                filter === "reverse" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              Signet ({counts.reverse})
            </button>
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no purchase orders {filter === "all" ? "" : `in this view`}. upload one above to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">PO #</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Direction</th>
                <th className="px-4 py-2">Supplier</th>
                <th className="px-4 py-2">Lines</th>
                <th className="px-4 py-2">Tariff %</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((po) => (
                <tr
                  key={po.id}
                  onClick={() => setSelectedPo(po)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-2 font-mono">{po.po_number || "—"}</td>
                  <td className="px-4 py-2">{po.po_date || "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        po.direction === "forward"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {po.direction === "forward" ? "Factory → me" : "Signet → me"}
                    </span>
                  </td>
                  <td className="px-4 py-2">{po.supplier || "—"}</td>
                  <td className="px-4 py-2">{po.line_count ?? "—"}</td>
                  <td className="px-4 py-2">{po.tariff_percent ?? 0}%</td>
                  <td className="px-4 py-2 text-right">{dollar(po.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedPo && (
        <POLinesView po={selectedPo} onClose={() => setSelectedPo(null)} />
      )}
    </div>
  );
}
