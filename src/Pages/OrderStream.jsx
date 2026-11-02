import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, PackageCheck, Inbox, Tag, Printer, RotateCcw, Ban, Pause, Play } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import usePersistedState from "../Hooks/usePersistedState";
import { createOrderLabels, sandboxCheck, boxesFromStored, packSheetPdf, planBoxes, SERVICES } from "../utils/orderstreamLabels";

// OrderStream: Signet dropship orders synced from CommerceHub OrderStream by the
// bridge job (tools/orderstream-bridge) into dropship_jobs. Buttons: retry, void label, pause automation.
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
  const [sel, setSel] = useState(() => new Set());
  const [testMode, setTestMode] = useState(true); // UPS sandbox until switched off
  const [service, setService] = useState("03"); // 03 Ground, 13 Next Day Air Saver, 01 Next Day Air
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { kind: "ok" | "err", text }
  const [paused, setPaused] = useState(true); // dropship_settings.paused: the runner on Brian's box obeys this

  const loadPaused = useCallback(async () => {
    const { data } = await supabase.from("dropship_settings").select("value").eq("key", "paused").maybeSingle();
    setPaused(data ? data.value !== false : true);
  }, [supabase]);
  useEffect(() => { loadPaused(); }, [loadPaused]);

  async function togglePause() {
    const next = !paused;
    if (!next && !window.confirm("Resume automation? The runner will ship, invoice and clear labeled orders on OrderStream.")) return;
    const { error } = await supabase.from("dropship_settings").update({ value: next, updated_at: new Date().toISOString() }).eq("key", "paused");
    if (error) setNote({ kind: "err", text: error.message });
    else setPaused(next);
  }

  async function retry(r) {
    const back = r.prev_status ?? (r.tracking ? "labeled" : "new");
    const { error } = await supabase.from("dropship_jobs").update({ status: back, error: null, updated_at: new Date().toISOString() }).eq("order_id", r.order_id);
    if (error) setNote({ kind: "err", text: error.message }); else load();
  }

  async function voidLabel(r) {
    if (!window.confirm(`Void the UPS label ${r.tracking} for PO ${r.po_number}? The order goes back to New.`)) return;
    try {
      const { data: lab, error: e1 } = await supabase.from("ups_labels").select("shipment_ups_id").eq("tracking", r.tracking).is("voided_at", null).maybeSingle();
      if (e1 || !lab?.shipment_ups_id) throw new Error(e1?.message || "Stored label not found; void it in UPS.");
      const { data, error } = await supabase.functions.invoke("ups-ship", { body: { action: "void", shipmentId: lab.shipment_ups_id, test: false } });
      if (error || data?.error) throw new Error(error?.message || data.error);
      const { error: e3 } = await supabase.from("dropship_jobs").update({ status: "new", tracking: null, ship_method: null, error: null, updated_at: new Date().toISOString() }).eq("order_id", r.order_id);
      if (e3) throw new Error("Voided at UPS but status did not save: " + e3.message);
      setNote({ kind: "ok", text: `Label ${r.tracking} voided. PO ${r.po_number} is back to New.` });
      load();
    } catch (e) { setNote({ kind: "err", text: e.message }); }
  }

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

  const canLabel = (r) => r.status === "new" || (r.status === "error" && !r.tracking);
  const selectedRows = shown.filter((r) => sel.has(r.order_id) && canLabel(r));
  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function makeLabels() {
    setNote(null);
    try {
      const plan = planBoxes(selectedRows); // validates ship-to, packaging, parse problems
      const who = plan.map((b) => `${b.shipTo.name} (PO ${b.pos.join(", ")}, ${b.weightLbs} lb${b.unconfirmed ? ", UNCONFIRMED box size" : ""})`).join("\n");
      const svc = SERVICES.find((x) => x.code === service)?.label;
      setBusy(true);
      if (!testMode) {
        // same order as the Python script: sandbox every box first, abort on any failure, then ask
        await sandboxCheck(supabase, plan, service);
        const warn = plan.some((b) => b.unconfirmed) ? "\n\nWARNING: some box weights are unconfirmed with the team." : "";
        if (!window.confirm(`Sandbox OK for all boxes.\n\nBUY ${plan.length} REAL UPS label(s) (${svc}), billed to Zales Y81323:\n${who}${warn}\n\nThis cannot be undone except by voiding.`)) {
          setBusy(false);
          return;
        }
      }
      const res = await createOrderLabels(supabase, plan, { test: testMode, service });
      await packSheetPdf(res.boxes, `${testMode ? "TEST " : ""}Zales dropship pack sheets.pdf`);
      setSel(new Set());
      const tr = res.boxes.map((b) => b.tracking).join(", ");
      setNote({
        kind: res.jobUpdateErrors.length ? "err" : "ok",
        text: testMode
          ? `Test labels made for ${plan.length} box(es) (${tr}). Check the PDF layout. Nothing was billed, saved or changed.`
          : res.jobUpdateErrors.length
            ? `Labels bought (${tr}) but the order status did not save: ${res.jobUpdateErrors.join("; ")}. Do NOT buy again; reprint from the stored label.`
            : `Labels bought: ${tr}. Orders marked labeled. Next: Confirm Shipment in OrderStream for each PO.`,
      });
      if (!testMode) await load();
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function reprint(r) {
    setNote(null);
    try {
      const boxes = await boxesFromStored(supabase, [r]);
      await packSheetPdf(boxes, `OrderStream PO ${r.po_number}.pdf`);
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">OrderStream</h1>
        <span className="text-xs text-gray-500">Signet dropship orders. Newest order seen: {fmtTime(lastSync || null)}</span>
        <button
          onClick={togglePause}
          className={`ml-auto inline-flex items-center gap-1 rounded border px-2 py-1 text-sm ${paused ? "border-amber-400 bg-amber-50 text-amber-800" : "border-emerald-400 bg-emerald-50 text-emerald-800"}`}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Automation paused (resume)" : "Automation running (pause)"}
        </button>
        <button onClick={load} className="inline-flex items-center gap-1 inline-flex items-center gap-1 rounded border px-2 py-1 text-sm hover:bg-gray-50">
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

      {tab === "new" && (
        <div className="flex flex-wrap items-center gap-3 rounded border bg-gray-50 p-2 text-sm">
          <button
            onClick={makeLabels}
            disabled={busy || !selectedRows.length}
            className="inline-flex items-center gap-1 rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-40"
          >
            <Tag size={14} /> {busy ? "Working..." : `Make labels (${selectedRows.length})`}
          </button>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} /> Test mode (UPS sandbox)
          </label>
          <select value={service} onChange={(e) => setService(e.target.value)} className="rounded border px-1 py-0.5">
            {SERVICES.map((x) => (
              <option key={x.code} value={x.code}>{x.label}</option>
            ))}
          </select>
          {!testMode && <span className="text-red-600">LIVE: buys real labels billed to Zales</span>}
        </div>
      )}
      {note && (
        <div className={`rounded border p-2 text-sm ${note.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-700"}`}>
          {note.text}
        </div>
      )}

      {err && <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{err}</div>}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              {tab === "new" && <th className="w-8 p-2"></th>}
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
                {tab === "new" && (
                  <td className="p-2">
                    {canLabel(r) && <input type="checkbox" checked={sel.has(r.order_id)} onChange={() => toggle(r.order_id)} />}
                  </td>
                )}
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
                  {r.status === "error" && (
                    <button onClick={() => retry(r)} className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                      <RotateCcw size={12} /> Retry
                    </button>
                  )}
                  {r.problems?.length > 0 && <div className="mt-1 max-w-xs text-xs text-amber-700">Check: {r.problems.join("; ")}</div>}
                </td>
                <td className="p-2">
                  {r.tracking}
                  {r.status === "labeled" && (
                    <button onClick={() => reprint(r)} className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                      <Printer size={12} /> Reprint
                    </button>
                  )}
                  {r.status === "labeled" && (
                    <button onClick={() => voidLabel(r)} className="ml-2 inline-flex items-center gap-1 text-xs text-red-600 hover:underline">
                      <Ban size={12} /> Void
                    </button>
                  )}
                </td>
                <td className="p-2">{r.invoice_number}</td>
              </tr>
            ))}
            {!shown.length && !loading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-gray-500">
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
