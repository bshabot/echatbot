import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";

// Pad stock, kept simple: type the quantity you have once. "Left" = that count minus the pad
// units on every Signet PO dated on/after the day you entered it (see pad_stock_status).
// Typing a new count re-baselines from today (use it after a recount or a delivery).
const fmt = (n) => Number(n ?? 0).toLocaleString();
// "How long will it last" at the recent usage rate (weeks_left comes from the view).
function lasts(w) {
  if (w == null) return "—";
  w = Number(w);
  if (w < 1) return "< 1 week";
  if (w < 13) return `${Math.round(w)} wk${Math.round(w) === 1 ? "" : "s"}`;
  if (w < 104) return `${Math.round(w / 4.345)} months`;
  return "2+ years";
}

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
      .sort((a, b) => {
        const wa = a.weeks_left == null ? Infinity : Number(a.weeks_left);
        const wb = b.weeks_left == null ? Infinity : Number(b.weeks_left);
        return wa - wb || Number(a.remaining) - Number(b.remaining) || a.pad_no.localeCompare(b.pad_no);
      });
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
        Left = what you set, minus pads on POs written since. Lasts about = Left at the last 26 weeks' usage; red means under ~7 weeks. To reset a pad (recount or new delivery), type the new total.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-1">Pad</th>
            <th>Description</th>
            <th className="text-right">Left</th>
            <th className="pl-6">Lasts about</th>
            <th className="pl-6">Set count</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.pad_no} className="border-b">
              <td className="py-1.5 font-medium">{r.pad_no}</td>
              <td>{r.description}</td>
              <td
                className={`text-right text-base font-semibold ${
                  r.counted_at && Number(r.remaining) <= 0 ? "text-red-600" : ""
                }`}
                title={r.counted_at ? `Counted ${fmt(r.counted)} on ${new Date(r.counted_at).toLocaleDateString()}, ${fmt(r.used_since_count)} used on POs since` : "No count entered yet"}
              >
                {r.counted_at ? fmt(r.remaining) : "—"}
              </td>
              <td
                className={`pl-6 ${r.weeks_left != null && Number(r.weeks_left) < 7 ? "text-red-600 font-semibold" : ""}`}
                title={r.weekly_usage ? `Using about ${fmt(r.weekly_usage)} per week (last 26 weeks of POs)` : "No PO usage in the last 26 weeks"}
              >
                {lasts(r.weeks_left)}
                {r.runout_date && Number(r.weeks_left) < 104 && (
                  <span className="text-gray-400 font-normal text-xs ml-2">
                    {new Date(r.runout_date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </td>
              <td className="pl-6">
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
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="text-sm text-gray-500 mt-4">No pads match.</p>}
    </div>
  );
}
