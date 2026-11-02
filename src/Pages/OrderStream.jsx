import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, PackageCheck, Inbox } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import usePersistedState from "../Hooks/usePersistedState";

// OrderStream: Signet dropship orders synced from CommerceHub OrderStream by the
// bridge job (tools/orderstream-bridge) into dropship_jobs. Read-only for now.
//   New     = still needs work (new, labeled, error)
//   Shipped = cleared on OrderStream (shipped, invoiced, stock_updated, done) = archive

const NEW_STATUSES = ["new", "labeled", "error", "skipped"];
const DONE_STATUSES = ["shipped", "invoiced", "stock_updated", "done"];
const TABS = [
  { key: "new", label: "New", icon: Inbox, statuses: NEW_STATUSES },
  { key: "shipped", label: "Shipped", icon: PackageCheck, statuses: DONE_STATUSES },
];
const CHIP = {
  new: "bg-blue-100 text-blue-700 border-blue-300",
  labeled: "bg-indigo-100 text-indigo-700 border-indigo-300",
  shipped: "bg-emerald-100 text-emerald-700 border-emerald-300",
  invoiced: "bg-emerald-100 text-emerald-700 border-emerald-300",
  stock_updated: "bg-emerald-100 text-emerald-700 border-emerald-300",
  done: "bg-emerald-100 text-emerald-700 border-emerald-300",
  error: "bg-red-100 text-red-700 border-red-300",
  skipped: "bg-gray-100 text-gray-600 border-gray-300",
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "");
const fmtTime = (d) => (d ? new Date(d).toLocaleString() : "never");

export default function OrderStream() {
  const { supabase } = useSupabase();
  const [tab, setTab] = usePersistedState("orderstream.tab", "new", (v) => TABS.some((t) => t.key === v));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    const { data, error } = await supabase
      .from("dropship_jobs")
      .select("*")
      .order("first_seen_at", { ascending: false })
      .limit(1000);
    if (error) setErr(error.message);
    else setRows(data ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c = {};
    for (const t of TABS) c[t.key] = rows.filter((r) => t.statuses.includes(r.status)).length;
    return c;
  }, [rows]);

  const lastSync = useMemo(() => rows.reduce((m, r) => (r.first_seen_at > m ? r.first_seen_at : m), ""), [rows]);

  const shown = useMemo(() => {
    const statuses = TABS.find((t) => t.key === tab).statuses;
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => statuses.includes(r.status))
      .filter((r) => {
        if (!needle) return true;
        const hay = [
          r.po_number, r.order_id, r.tracking, r.invoice_number, r.ship_to?.name, r.ship_to?.city, r.ship_to?.zip,
          ...(r.items ?? []).flatMap((i) => [i.vendor_sku, i.merchant_sku]),
        ].join(" ").toLowerCase();
        return hay.includes(needle);
      });
  }, [rows, tab, q]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">OrderStream</h1>
        <span className="text-xs text-gray-500">Signet dropship orders. Newest order seen: {fmtTime(lastSync || null)}</span>
        <button onClick={load} className="ml-auto inline-flex items-center gap-1 rounded border px-2 py-1 text-sm hover:bg-gray-50">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1 rounded border px-3 py-1 text-sm ${tab === t.key ? "bg-gray-900 text-white" : "hover:bg-gray-50"}`}
          >
            <t.icon size={14} /> {t.label} <span className="opacity-70">({counts[t.key] ?? 0})</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2 top-2 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="PO, SKU, name, tracking"
            className="w-64 rounded border py-1 pl-7 pr-2 text-sm"
          />
        </div>
      </div>

      {err && <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{err}</div>}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-2">PO</th>
              <th className="p-2">Order date</th>
              <th className="p-2">Items</th>
              <th className="p-2">Ship to</th>
              <th className="p-2">Status</th>
              <th className="p-2">Tracking</th>
              <th className="p-2">Invoice</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.order_id} className="border-t align-top">
                <td className="p-2 font-medium">
                  {r.po_number}
                  <div className="text-xs font-normal text-gray-400">order {r.order_id}</div>
                </td>
                <td className="p-2">{fmtDate(r.order_date)}</td>
                <td className="p-2">
                  {(r.items ?? []).map((i) => (
                    <div key={i.item_id}>
                      {i.vendor_sku} <span className="text-gray-500">x{i.qty}</span>
                    </div>
                  ))}
                </td>
                <td className="p-2">
                  {r.ship_to?.name}
                  <div className="text-xs text-gray-500">
                    {[r.ship_to?.city, r.ship_to?.state, r.ship_to?.zip].filter(Boolean).join(", ")}
                  </div>
                </td>
                <td className="p-2">
                  <span className={`rounded border px-2 py-0.5 text-xs ${CHIP[r.status] ?? CHIP.new}`}>{r.status.replace("_", " ")}</span>
                  {r.error && <div className="mt-1 max-w-xs text-xs text-red-600">{r.error}</div>}
                  {r.problems?.length > 0 && <div className="mt-1 max-w-xs text-xs text-amber-700">Check: {r.problems.join("; ")}</div>}
                </td>
                <td className="p-2">{r.tracking}</td>
                <td className="p-2">{r.invoice_number}</td>
              </tr>
            ))}
            {!shown.length && !loading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-gray-500">
                  {tab === "new" ? "No new orders." : "Nothing shipped yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
