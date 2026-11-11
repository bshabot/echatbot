import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";

// Pad stock: on hand vs units committed on Signet POs (via sku_pad_map).
// Counts, on-order and reorder point are entered here; committed units come
// from the pad_stock_status view.
const EDIT_FIELDS = ["on_hand", "on_order", "reorder_point", "lead_time_days"];

export default function PadStock() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [onlyOrderNow, setOnlyOrderNow] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (supabase) refresh();
  }, [supabase]);

  async function refresh() {
    setLoading(true);
    const [{ data: status, error }, { data: inv }] = await Promise.all([
      supabase.from("pad_stock_status").select("*"),
      supabase.from("pad_inventory").select("pad_no, lead_time_days, pads_per_unit, counted_at"),
    ]);
    if (error) showMessage(error.message, "error");
    const invMap = Object.fromEntries((inv ?? []).map((i) => [i.pad_no, i]));
    setRows((status ?? []).map((s) => ({ ...s, ...invMap[s.pad_no] })));
    setLoading(false);
  }

  async function saveField(row, field, raw) {
    const value = Math.max(0, parseInt(raw, 10) || 0);
    if (value === (row[field] ?? 0)) return;
    const patch = { [field]: value, updated_at: new Date().toISOString() };
    if (field === "on_hand") patch.counted_at = new Date().toISOString();
    const { error } = await supabase.from("pad_inventory").update(patch).eq("pad_no", row.pad_no);
    if (error) return showMessage(error.message, "error");
    if (field === "on_hand") {
      await supabase.from("pad_transactions").insert({
        pad_no: row.pad_no,
        kind: "count",
        qty: value,
        note: `Count changed from ${row.on_hand ?? 0}`,
      });
    }
    refresh();
  }

  async function receive(row) {
    const qty = parseInt(window.prompt(`Pads received for ${row.pad_no}?`, ""), 10);
    if (!qty || qty < 0) return;
    const { error } = await supabase
      .from("pad_inventory")
      .update({
        on_hand: (row.on_hand ?? 0) + qty,
        on_order: Math.max(0, (row.on_order ?? 0) - qty),
        updated_at: new Date().toISOString(),
      })
      .eq("pad_no", row.pad_no);
    if (error) return showMessage(error.message, "error");
    await supabase.from("pad_transactions").insert({ pad_no: row.pad_no, kind: "received", qty });
    refresh();
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows
      .filter((r) => !onlyOrderNow || r.order_now)
      .filter((r) => !f || `${r.pad_no} ${r.description ?? ""}`.toLowerCase().includes(f))
      .sort((a, b) => Number(b.order_now) - Number(a.order_now) || a.projected_balance - b.projected_balance);
  }, [rows, onlyOrderNow, filter]);

  if (loading) return <Loading />;
  const alertCount = rows.filter((r) => r.order_now).length;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-semibold">Pad Stock</h1>
        {alertCount > 0 && (
          <span className="flex items-center gap-1 text-sm text-red-600">
            <TriangleAlert size={16} /> {alertCount} to order
          </span>
        )}
        <input
          className="border rounded px-2 py-1 text-sm ml-auto"
          placeholder="Filter pad or description"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={onlyOrderNow} onChange={(e) => setOnlyOrderNow(e.target.checked)} />
          Order now only
        </label>
        <button onClick={refresh} className="p-1 border rounded" title="Refresh">
          <RefreshCw size={16} />
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-1">Pad</th>
            <th>Description</th>
            <th>On hand</th>
            <th>On order</th>
            <th>Committed (POs)</th>
            <th>Projected</th>
            <th>Reorder at</th>
            <th>Lead (days)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.pad_no} className={`border-b ${r.order_now ? "bg-red-50" : ""}`}>
              <td className="py-1 font-medium">{r.pad_no}</td>
              <td>{r.description}</td>
              {["on_hand", "on_order"].map((f) => (
                <td key={f}>
                  <input
                    type="number"
                    min="0"
                    className="w-20 border rounded px-1"
                    defaultValue={r[f] ?? 0}
                    key={`${r.pad_no}-${f}-${r[f]}`}
                    onBlur={(e) => saveField(r, f, e.target.value)}
                  />
                </td>
              ))}
              <td>{Number(r.committed ?? 0).toLocaleString()}</td>
              <td className={r.order_now ? "text-red-600 font-semibold" : ""}>
                {Number(r.projected_balance ?? 0).toLocaleString()}
              </td>
              {["reorder_point", "lead_time_days"].map((f) => (
                <td key={f}>
                  <input
                    type="number"
                    min="0"
                    className="w-20 border rounded px-1"
                    defaultValue={r[f] ?? 0}
                    key={`${r.pad_no}-${f}-${r[f]}`}
                    onBlur={(e) => saveField(r, f, e.target.value)}
                  />
                </td>
              ))}
              <td>
                <button className="text-blue-600 text-xs underline" onClick={() => receive(r)}>
                  Receive
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="text-sm text-gray-500 mt-4">No pads match.</p>}
    </div>
  );
}
