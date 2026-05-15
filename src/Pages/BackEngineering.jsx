import React, { useEffect, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import POUploader from "../components/RunningLines/POUploader";

export default function BackEngineering() {
  const { supabase } = useSupabase();
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase
        .from("running_line_purchase_orders")
        .select("*")
        .eq("direction", "reverse")
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Back-Engineering</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a Signet PO. Decode the metal rate Signet used and flag any mispriced lines.
        </p>
      </div>

      <POUploader direction="reverse" onUploaded={(po) => setPos((prev) => [po, ...prev])} />

      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">
          Past uploads
        </div>
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : pos.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no Signet POs uploaded yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">PO #</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Lines</th>
                <th className="px-4 py-2">Tariff %</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pos.map((po) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono">{po.po_number || "—"}</td>
                  <td className="px-4 py-2">{po.po_date || "—"}</td>
                  <td className="px-4 py-2">{po.line_count ?? "—"}</td>
                  <td className="px-4 py-2">{po.tariff_percent ?? 0}%</td>
                  <td className="px-4 py-2 text-right">{dollar(po.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
