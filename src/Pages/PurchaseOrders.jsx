import React, { useEffect, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import POUploader from "../components/RunningLines/POUploader";
import POLinesView from "../components/RunningLines/POLinesView";
import { Trash2 } from "lucide-react";

export default function PurchaseOrders() {
  const { supabase } = useSupabase();
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPo, setSelectedPo] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

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

  async function deletePo(po) {
    if (!supabase) return;
    if (!confirm(`Delete PO ${po.po_number || po.id.slice(0, 8)}? This can't be undone.`)) return;
    setDeletingId(po.id);
    // Delete line items first, then the PO itself.
    const { error: e1 } = await supabase
      .from("running_line_po_items")
      .delete()
      .eq("po_id", po.id);
    if (e1) {
      console.error("delete items failed:", e1.message);
      alert("Failed to delete line items: " + e1.message);
      setDeletingId(null);
      return;
    }
    const { error: e2 } = await supabase
      .from("running_line_purchase_orders")
      .delete()
      .eq("id", po.id);
    if (e2) {
      console.error("delete PO failed:", e2.message);
      alert("Failed to delete PO: " + e2.message);
      setDeletingId(null);
      return;
    }
    setPos((prev) => prev.filter((p) => p.id !== po.id));
    setDeletingId(null);
  }

  async function updateTariff(po, newValue) {
    if (!supabase) return;
    const newTariff = Number(newValue);
    if (!Number.isFinite(newTariff)) return;
    if (newTariff === Number(po.tariff_percent)) return; // no change
    const { error } = await supabase
      .from("running_line_purchase_orders")
      .update({ tariff_percent: newTariff })
      .eq("id", po.id);
    if (error) {
      alert("Failed to update tariff: " + error.message);
      return;
    }
    setPos((prev) =>
      prev.map((p) => (p.id === po.id ? { ...p, tariff_percent: newTariff } : p))
    );
  }

  async function clearAll() {
    if (!supabase) return;
    if (!confirm(`Delete ALL ${pos.length} purchase orders? This can't be undone.`)) return;
    if (!confirm("Are you sure? This will wipe every PO and its line items.")) return;
    // Bulk delete: items first, then POs.
    const { error: e1 } = await supabase
      .from("running_line_po_items")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (e1) {
      alert("Failed to delete items: " + e1.message);
      return;
    }
    const { error: e2 } = await supabase
      .from("running_line_purchase_orders")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (e2) {
      alert("Failed to delete POs: " + e2.message);
      return;
    }
    setPos([]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Purchase Orders</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a PO. Reconcile against SSP data, decode the metal lock, and
          recompute at any rate.
        </p>
      </div>

      {/* Uploader — no direction toggle, everything defaults to forward */}
      <POUploader
        direction="forward"
        onUploaded={(po) => setPos((prev) => [po, ...prev])}
      />

      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="text-sm font-medium text-gray-700">
            Past uploads {pos.length > 0 && <span className="text-gray-400">({pos.length})</span>}
          </div>
          {pos.length > 0 && (
            <button
              onClick={clearAll}
              className="text-xs text-red-600 hover:text-red-700 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : pos.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no purchase orders yet. upload one above to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">PO #</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Supplier</th>
                <th className="px-4 py-2">Lines</th>
                <th className="px-4 py-2">Tariff %</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pos.map((po) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td
                    className="px-4 py-2 font-mono cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.po_number || "—"}
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.po_date || "—"}
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.supplier || "—"}
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.line_count ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      defaultValue={po.tariff_percent ?? 0}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => updateTariff(po, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      className="w-16 px-1 py-0.5 border border-gray-200 rounded text-sm focus:border-[#C5A572] focus:outline-none"
                      step="0.1"
                    />
                    <span className="text-gray-500 ml-1">%</span>
                  </td>
                  <td
                    className="px-4 py-2 text-right cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {dollar(po.total_amount)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deletePo(po)}
                      disabled={deletingId === po.id}
                      className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                      title="Delete PO"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedPo && (
        <POLinesView
          po={selectedPo}
          onClose={() => setSelectedPo(null)}
          onUpdate={(patch) => {
            // Sync any change made inside the modal (e.g. tariff edit) back
            // to the row in the list, in real-time.
            setPos((prev) =>
              prev.map((p) => (p.id === patch.id ? { ...p, ...patch } : p))
            );
            // Also keep selectedPo's local reference current so reopening
            // shows the latest value
            setSelectedPo((sp) => (sp && sp.id === patch.id ? { ...sp, ...patch } : sp));
          }}
        />
      )}
    </div>
  );
}
