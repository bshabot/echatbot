import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Search, PackageCheck, Inbox, Tag, Printer, RotateCcw, Ban, Pause, Play, AlertTriangle, CloudDownload, FileText } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useAlert } from "../components/Alerts/AlertContext";
import usePersistedState from "../Hooks/usePersistedState";
import { createOrderLabels, sandboxCheck, boxesFromStored, packSheetPdf, packetPdf, planBoxes, mergeKey, SERVICES } from "../utils/orderstreamLabels";

// OrderStream: Signet dropship orders synced from CommerceHub OrderStream by the
// bridge job (tools/orderstream-bridge) into dropship_jobs. Buttons: retry, void label, pause automation.
//   New     = still needs work (new, labeled, error)
//   Shipped = cleared on OrderStream (shipped, invoiced, stock_updated, done) = archive

const DONE_STATUSES = ["shipped", "invoiced", "stock_updated", "done"];
const TABS = [
  { key: "new", label: "New", icon: Inbox, statuses: ["new", "skipped"] },
  { key: "labeled", label: "Labeled", icon: Tag, statuses: ["labeled"] },
  { key: "attention", label: "Needs attention", icon: AlertTriangle, statuses: ["error"] },
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
const addrText = (a) => (a ? [a.name, ...(a.lines ?? []), [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join("\n") : "");

// All stored detail for one order (from the OrderStream order detail page).
function OrderDetail({ r }) {
  const d = r.detail ?? {};
  const Box = ({ title, children }) => (
    <div className="rounded border bg-white p-2">
      <div className="mb-1 text-xs font-semibold uppercase text-gray-500">{title}</div>
      {children}
    </div>
  );
  const kv = [
    ["PO number", r.po_number], ["OrderStream order id", r.order_id], ["Customer order number", r.customer_order_number],
    ["Order date", fmtDate(r.order_date)], ["Status", [r.os_status, r.os_substatus].filter(Boolean).join(" / ")],
    ["Shipping method", d.ship_method_label], ["Sales division", d.sales_division], ["Merchant", d.merchant ?? r.merchant], ["Vendor", d.vendor],
    ["Tracking", r.tracking], ["Invoice number", r.invoice_number],
    ["Order total", (() => { const t = (r.items ?? []).reduce((a, i) => a + (parseFloat(i.unit_cost) || 0) * (Number(i.qty) || 0), 0); return t ? `$${t.toFixed(2)}` : null; })()],
  ];
  return (
    <div className="grid gap-2 bg-gray-50 p-3 text-xs md:grid-cols-2">
      <Box title="Order summary">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-2 gap-y-0.5">
          {kv.filter(([, v]) => v).map(([k, v]) => (<Fragment key={k}><dt className="text-gray-500">{k}</dt><dd>{v}</dd></Fragment>))}
        </dl>
        {!r.detail && <div className="mt-2 text-amber-700">No OrderStream detail stored for this order yet.</div>}
      </Box>
      <Box title="Ship to">
        <div className="whitespace-pre-line">{addrText(r.ship_to)}</div>
        {r.ship_to?.phone && <div className="mt-1">Phone: {r.ship_to.phone}</div>}
      </Box>
      {d.bill_to && (
        <Box title="Bill to">
          <div className="whitespace-pre-line">{addrText(d.bill_to)}</div>
          {d.bill_to.phone && <div className="mt-1">Phone: {d.bill_to.phone}</div>}
          {d.bill_to.email && <div>Email: {d.bill_to.email}</div>}
        </Box>
      )}
      <Box title="Line items">
        <table className="w-full">
          <thead className="text-left text-gray-500"><tr><th>#</th><th>Merchant SKU</th><th>Vendor SKU</th><th>Description</th><th>Unit cost</th><th>Qty</th><th>Status</th><th>Exp. ship</th><th>Exp. delivery</th></tr></thead>
          <tbody>
            {(r.items ?? []).map((i, n) => (
              <Fragment key={n}>
                <tr className="border-t">
                  <td>{i.line}</td><td>{i.merchant_sku}</td><td>{i.vendor_sku}</td><td>{i.description}</td><td>{i.unit_cost}</td>
                  <td>{i.qty}</td><td>{i.status}</td><td>{i.expected_ship}</td><td>{i.expected_delivery}</td>
                </tr>
                {i.personalization && <tr><td></td><td colSpan={8} className="text-gray-600">Personalization: {i.personalization}</td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Box>
      <Box title="Shipments">
        {(d.shipments ?? []).length ? d.shipments.map((s, n) => (
          <div key={n}>{[s.carrier, s.service, s.tracking].filter(Boolean).join(" · ")}{s.note && <div className="text-gray-500">{s.note}</div>}</div>
        )) : <div className="text-gray-500">No shipments recorded.</div>}
      </Box>
      <Box title="Events">
        {(d.events ?? []).length ? (
          <table className="w-full">
            <tbody>
              {d.events.map((e, n) => (<tr key={n} className="border-t"><td className="pr-2">{e.event}</td><td className="pr-2 text-gray-600">{e.description}</td><td className="pr-2">{e.date}</td><td>{e.time}</td></tr>))}
            </tbody>
          </table>
        ) : <div className="text-gray-500">No events.</div>}
      </Box>
      {(d.messages ?? []).length > 0 && (
        <Box title="Messages"><pre className="whitespace-pre-wrap">{JSON.stringify(d.messages, null, 1)}</pre></Box>
      )}
      {d.source && <div className="text-gray-400 md:col-span-2">Source: {d.source}</div>}
    </div>
  );
}

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
  const [testMode, setTestMode] = useState(false); // live labels by default; tick Test mode for the UPS sandbox
  const [service, setService] = useState("03"); // 03 Ground, 13 Next Day Air Saver, 01 Next Day Air
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { kind: "ok" | "err", text }
  const [checking, setChecking] = useState(false);
  const [slips, setSlips] = useState([]); // packing slip files the bridge downloaded from OrderStream
  const [slipsOpen, setSlipsOpen] = useState(false);
  const [bridge, setBridge] = useState({}); // dropship_settings.bridge_status written by the cloud function
  const [open, setOpen] = useState(() => new Set()); // expanded order rows
  const [onlyMergeable, setOnlyMergeable] = useState(false);
  const { showConfirm } = useAlert();
  const toggleOpen = (id) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [paused, setPaused] = useState(true); // dropship_settings.paused: the runner on Brian's box obeys this

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

  const loadPaused = useCallback(async () => {
    const { data } = await supabase.from("dropship_settings").select("key, value").in("key", ["paused", "bridge_status"]);
    const get = (k) => data?.find((r) => r.key === k)?.value;
    setPaused(get("paused") !== false);
    setBridge(get("bridge_status") ?? {});
  }, [supabase]);
  useEffect(() => { loadPaused(); }, [loadPaused]);

  const loadSlips = useCallback(async () => {
    const { data } = await supabase.from("dropship_files").select("file_id, file_name, fetched_at, bytes, note").not("bytes", "is", null).order("fetched_at", { ascending: false }).limit(50);
    setSlips(data ?? []);
  }, [supabase]);
  useEffect(() => { loadSlips(); }, [loadSlips]);

  async function downloadSlip(f) {
    try {
      const { data, error } = await supabase.from("dropship_files").select("pdf_b64").eq("file_id", f.file_id).single();
      if (error || !data?.pdf_b64) throw new Error(error?.message || "No stored PDF for this file.");
      const bytes = Uint8Array.from(atob(data.pdf_b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.file_name || `${f.file_id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    }
  }

  // the list reloads itself; there is no Refresh button
  useEffect(() => {
    const t = setInterval(() => { load(); loadPaused(); }, 30000);
    return () => clearInterval(t);
  }, [load, loadPaused]);

  // asks the cloud function to pull new orders from OrderStream now (and finish labeled ones if automation is on)
  async function checkNow() {
    setChecking(true);
    setNote(null);
    try {
      const { data, error } = await supabase.functions.invoke("orderstream-bridge", { body: { action: "check" } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch { /* keep message */ }
        throw new Error(msg);
      }
      setNote({ kind: "ok", text: `Checked OrderStream: ${data.seen} open, ${data.inserted} new.${data.run?.processed ? ` ${data.run.processed} order step(s) completed.` : ""}` });
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    } finally {
      await Promise.all([load(), loadPaused(), loadSlips()]);
      setChecking(false);
    }
  }

  async function togglePause() {
    const next = !paused;
    if (!next && !(await showConfirm("Resume automation? The runner will ship, invoice and clear labeled orders on OrderStream.", { title: "Automation", confirmText: "Resume" }))) return;
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
    if (!(await showConfirm(`Void the UPS label ${r.tracking} for PO ${r.po_number}? The order goes back to New.`, { title: "Void label", confirmText: "Void" }))) return;
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


  const counts = useMemo(() => {
    const c = {};
    for (const t of TABS) c[t.key] = rows.filter((r) => t.statuses.includes(r.status)).length;
    return c;
  }, [rows]);

  
  // POs still to label that go to the same name + address: they can ship in one box.
  const mergeGroups = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!(r.status === "new" || (r.status === "error" && !r.tracking))) continue;
      const k = mergeKey(r); if (!k) continue;
      m.set(k, [...(m.get(k) || []), r]);
    }
    return [...m.entries()].filter(([, v]) => v.length > 1);
  }, [rows]);
  const mergeable = useMemo(() => new Map(mergeGroups.flatMap(([k, v], i) => v.map((r) => [r.order_id, { k, n: i + 1, size: v.length }]))), [mergeGroups]);

  const shown = useMemo(() => {
    const statuses = TABS.find((t) => t.key === tab).statuses;
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => statuses.includes(r.status))
      .filter((r) => !onlyMergeable || mergeable.has(r.order_id))
      .filter((r) => {
        if (!needle) return true;
        const hay = [
          r.po_number, r.order_id, r.tracking, r.invoice_number, r.ship_to?.name, r.ship_to?.city, r.ship_to?.zip,
          ...(r.items ?? []).flatMap((i) => [i.vendor_sku, i.merchant_sku]),
        ].join(" ").toLowerCase();
        return hay.includes(needle);
      });
  }, [rows, tab, q, onlyMergeable, mergeable]);

  const canLabel = (r) => r.status === "new" || (r.status === "error" && !r.tracking);
  const selectedRows = shown.filter((r) => sel.has(r.order_id) && canLabel(r));
  const selectable = shown.filter(canLabel);
  const allSelected = selectable.length > 0 && selectable.every((r) => sel.has(r.order_id));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(selectable.map((r) => r.order_id)));
  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function makeLabels() {
    setNote(null);
    let packNote = "";
    try {
      const plan = planBoxes(selectedRows); // validates ship-to, packaging, parse problems
      const who = plan.map((b) => `${b.shipTo.name} (PO ${b.pos.join(", ")}, ${b.weightLbs} lb${b.unconfirmed ? ", UNCONFIRMED box size" : ""})`).join("\n");
      const svc = SERVICES.find((x) => x.code === service)?.label;
      setBusy(true);
      if (!testMode) {
        // same order as the Python script: sandbox every box first, abort on any failure, then ask
        await sandboxCheck(supabase, plan, service);
        const warn = plan.some((b) => b.unconfirmed) ? "\n\nWARNING: some box weights are unconfirmed with the team." : "";
        if (!(await showConfirm(`Sandbox OK for all boxes.\n\nBUY ${plan.length} REAL UPS label(s) (${svc}), billed to Zales Y81323:\n${who}${warn}\n\nThis cannot be undone except by voiding.`, { title: "Buy UPS labels", confirmText: "Buy labels" }))) {
          setBusy(false);
          return;
        }
      }
      const res = await createOrderLabels(supabase, plan, { test: testMode, service });
      const pk = await packetPdf(supabase, res.boxes, `${testMode ? "TEST " : ""}Zales dropship print packet.pdf`);
      if (!testMode) await markPrinted(res.boxes.flatMap((b) => b.jobs));
      packNote = pk.missing.length ? ` Packing slip not found for PO ${pk.missing.join(", ")}: print those from OrderStream.` : "";
      setSel(new Set());
      const tr = res.boxes.map((b) => b.tracking).join(", ");
      setNote({
        kind: res.jobUpdateErrors.length ? "err" : "ok",
        text: testMode
          ? `Test labels made for ${plan.length} box(es) (${tr}). Check the PDF layout. Nothing was billed, saved or changed.${packNote}`
          : res.jobUpdateErrors.length
            ? `Labels bought (${tr}) but the order status did not save: ${res.jobUpdateErrors.join("; ")}. Do NOT buy again; reprint from the stored label.`
            : `Labels bought: ${tr}. Orders marked labeled. Print the packet (label + packing slip per box).${packNote}`,
      });
      if (!testMode) await load();
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  // Remember which orders had their packet printed (never in test mode) so the list can grey them out.
  async function markPrinted(jobs) {
    const ids = jobs.map((j) => j.order_id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("dropship_jobs").update({ printed_at: now }).in("order_id", ids);
    if (error) setErr("Printed, but could not save the printed mark: " + error.message);
    else setRows((prev) => prev.map((x) => (ids.includes(x.order_id) ? { ...x, printed_at: now } : x)));
  }

  async function reprint(r) {
    setNote(null);
    try {
      const boxes = await boxesFromStored(supabase, [r]);
      const pk = await packetPdf(supabase, boxes, `OrderStream PO ${r.po_number} print packet.pdf`);
      await markPrinted(boxes.flatMap((b) => b.jobs));
      if (pk.missing.length) setNote({ kind: "err", text: `Packing slip not found for PO ${pk.missing.join(", ")}.` });
    } catch (e) {
      setNote({ kind: "err", text: e.message });
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">OrderStream</h1>
        <span className="text-xs text-gray-500">
          Last checked OrderStream: {fmtTime(bridge.last_sync)}. Automation is {paused ? "off" : "on"}.
        </span>
        {bridge.needs_login && (
          <span className="rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-700">
            OrderStream login needed. {bridge.message}
          </span>
        )}
        <button
          onClick={togglePause}
          className={`ml-auto inline-flex items-center gap-1 rounded border px-2 py-1 text-sm ${paused ? "border-amber-400 bg-amber-50 text-amber-800" : "border-emerald-400 bg-emerald-50 text-emerald-800"}`}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Automation: Off (turn on)" : "Automation: On (turn off)"}
        </button>
        <button onClick={checkNow} disabled={checking} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-50">
          <CloudDownload size={14} className={checking ? "animate-pulse" : ""} /> {checking ? "Checking..." : "Check OrderStream now"}
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

      <div className="text-sm">
        <button onClick={() => setSlipsOpen((v) => !v)} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
          <FileText size={14} /> Packing slips ({slips.length})
        </button>
        {slipsOpen && (
          <div className="mt-1 rounded border bg-white p-2 text-xs">
            {slips.length ? slips.map((f) => (
              <div key={f.file_id} className="flex items-center gap-3 py-0.5">
                <span className="font-medium">{f.file_name}</span>
                <span className="text-gray-500">{fmtTime(f.fetched_at)} · {Math.round((f.bytes ?? 0) / 1024)} KB</span>
                <button onClick={() => downloadSlip(f)} className="text-blue-600 hover:underline">Download PDF</button>
              </div>
            )) : <div className="text-gray-500">No packing slips downloaded yet.</div>}
          </div>
        )}
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
          <button
            onClick={() => { setOnlyMergeable((v) => !v); if (!onlyMergeable) setSel(new Set(mergeGroups.flatMap(([, v]) => v.map((r) => r.order_id)))); else setSel(new Set()); }}
            disabled={!mergeGroups.length && !onlyMergeable}
            title={mergeGroups.length ? "Show customers with 2+ open POs to the same name and address, and select them to ship in one box" : "No customers have 2+ open POs to the same name and address right now"}
            className={`inline-flex items-center gap-1 rounded border px-3 py-1 ${onlyMergeable ? "border-purple-500 bg-purple-100 text-purple-800" : "hover:bg-white disabled:opacity-40"}`}
          >
            Mergeable ({mergeGroups.length})
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
      {tab === "new" && onlyMergeable && (
        <div className="space-y-2 rounded border border-purple-300 bg-purple-50 p-2 text-sm text-purple-900">
          <div>
            <b>Mergeable</b> shows customers with 2 or more open POs going to the same name and address. They can ship in one box with one UPS label and one tracking number.
            All of them are selected now. Click <b>Make labels</b> to combine each group, or use <b>Select only this group</b> to merge just one. Untick a PO to ship it on its own.
          </div>
          {mergeGroups.map(([k, v], i) => (
            <div key={k} className="flex flex-wrap items-center gap-2 rounded bg-white p-2">
              <span className="font-medium">Group {i + 1}: {v[0].ship_to?.name}</span>
              <span className="text-gray-500">{[...(v[0].ship_to?.lines ?? []), v[0].ship_to?.city, v[0].ship_to?.state, v[0].ship_to?.zip].filter(Boolean).join(", ")}</span>
              <span>POs {v.map((r) => r.po_number).join(" + ")}</span>
              <button onClick={() => setSel(new Set(v.map((r) => r.order_id)))} className="ml-auto text-purple-700 hover:underline">Select only this group</button>
            </div>
          ))}
        </div>
      )}
      {note && (
        <div className={`rounded border p-2 text-sm ${note.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-700"}`}>
          {note.text}
        </div>
      )}

      {tab === "labeled" && !!shown.length && (
        <div className="text-xs text-gray-500">With Automation on, these are shipped and invoiced on OrderStream for you. Void cancels the UPS label.</div>
      )}
      {err && <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{err}</div>}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              {tab === "new" && (
                <th className="w-8 p-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} title="Select all" />
                </th>
              )}
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
              <Fragment key={r.order_id}>
              <tr
                className={`border-t align-top cursor-pointer hover:bg-gray-50 ${open.has(r.order_id) ? "bg-gray-50" : ""} ${r.printed_at ? "opacity-50" : ""}`}
                onClick={(e) => { if (!e.target.closest("button, a, input, select")) toggleOpen(r.order_id); }}
              >
                {tab === "new" && (
                  <td className="p-2">
                    {canLabel(r) && <input type="checkbox" checked={sel.has(r.order_id)} onChange={() => toggle(r.order_id)} />}
                  </td>
                )}
                <td className="p-2 font-medium">
                  <button onClick={() => toggleOpen(r.order_id)} className="text-blue-700 hover:underline" title="Click for order details">
                    {r.po_number}
                  </button>
                  <div className="text-xs font-normal text-gray-400">order {r.order_id}</div>
                  {r.printed_at && (
                    <div className="mt-0.5 inline-block rounded bg-gray-200 px-1.5 text-xs font-normal text-gray-700" title="Packet already printed. Use Reprint to print again.">
                      Printed {fmtTime(r.printed_at)}
                    </div>
                  )}
                  {mergeable.has(r.order_id) && (
                    <div className="mt-0.5 inline-block rounded bg-purple-100 px-1.5 text-xs font-normal text-purple-800" title="Same name and address as another open PO">
                      Mergeable: group {mergeable.get(r.order_id).n} ({mergeable.get(r.order_id).size} POs)
                    </div>
                  )}
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
              {open.has(r.order_id) && (
                <tr className="border-t">
                  <td colSpan={tab === "new" ? 8 : 7} className="p-0"><OrderDetail r={r} /></td>
                </tr>
              )}
              </Fragment>
            ))}
            {!shown.length && !loading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-gray-500">
                  {{ new: "No new orders.", labeled: "Nothing waiting.", attention: "Nothing needs attention.", shipped: "Nothing shipped yet." }[tab]}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
