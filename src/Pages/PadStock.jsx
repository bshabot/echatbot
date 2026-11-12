import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";

// Pad stock, kept simple: type the quantity you have once. "Left" = that count minus the pad
// units on every Signet PO dated on/after the day you entered it (see pad_stock_status).
// Typing a new count re-baselines from today (use it after a recount or a delivery).
const fmt = (n) => Number(n ?? 0).toLocaleString();

export default function PadStock() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (supabase) refresh();
  }, [supabase]);

  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase.from("pad_stock_status").select("*");
    if (error) showMessage(error.message, "error");
    setRows(data ?? []);
    setLoading(false);
  }

  async function saveCount(row, raw) {
    if (raw === "" || raw == null) return;
    const value = Math.max(0, parseInt(raw, 10) || 0);
    if (value === Number(row.counted ?? 0) && row.counted_at) return;
    const { error } = await supabase
      .from("pad_inventory")
      .update({ on_hand: value, counted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("pad_no", row.pad_no);
    if (error) return showMessage(error.message, "error");
    refresh();
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows
      .filter((r) => !f || `${r.pad_no} ${r.description ?? ""}`.toLowerCase().includes(f))
      .sort((a, b) => Number(a.remaining) - Number(b.remaining) || a.pad_no.localeCompare(b.pad_no));
  }, [rows, filter]);

  if (loading) return <Loading />;

  return (
    <div className="p-4 max-w-4xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-xl font-semibold">Pad Stock</h1>
        <input
          className="border rounded px-2 py-1 text-sm ml-auto"
          placeholder="Filter pad or description"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={refresh} className="p-1 border rounded" title="Refresh">
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Enter what you have on hand. Left = count minus pads on POs dated since the count.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-1">Pad</th>
            <th>Description</th>
            <th>Count</th>
            <th>Counted on</th>
            <th>Used on POs since</th>
            <th>Left</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.pad_no} className="border-b">
              <td className="py-1 font-medium">{r.pad_no}</td>
              <td>{r.description}</td>
              <td>
                <input
                  type="number"
                  min="0"
                  className="w-24 border rounded px-1"
                  placeholder="enter"
                  defaultValue={r.counted_at ? r.counted : ""}
                  key={`${r.pad_no}-${r.counted_at}-${r.counted}`}
                  onBlur={(e) => saveCount(r, e.target.value)}
                />
              </td>
              <td className="text-gray-500">
                {r.counted_at ? new Date(r.counted_at).toLocaleDateString() : "—"}
              </td>
              <td>{r.counted_at ? fmt(r.used_since_count) : "—"}</td>
              <td className={`font-semibold ${r.counted_at && Number(r.remaining) <= 0 ? "text-red-600" : ""}`}>
                {r.counted_at ? fmt(r.remaining) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="text-sm text-gray-500 mt-4">No pads match.</p>}
    </div>
  );
}
