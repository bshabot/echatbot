import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { RefreshCw, Search, Truck, Anchor, PackageCheck, Factory, Link2, Ship } from "lucide-react";
import {
  syncShipmentsFromPOs,
  computeFlag,
  isOnBoard,
  stageOf,
  STAGE_LABELS,
  FLAGS,
  daysUntil,
} from "../utils/shipmentsSync";
import BulkStampDialog from "../components/Shipments/BulkStampDialog";
import MasterDialog from "../components/Shipments/MasterDialog";
import LinkSODialog from "../components/Shipments/LinkSODialog";
import ShipOutDialog from "../components/Shipments/ShipOutDialog";

const FLAG_STYLE = {
  [FLAGS.LATE]: "bg-red-100 text-red-700 border-red-300",
  [FLAGS.NEED_EXTENSION]: "bg-orange-100 text-orange-700 border-orange-300",
  [FLAGS.NUDGE]: "bg-amber-100 text-amber-700 border-amber-300",
  [FLAGS.ON_TRACK]: "bg-green-50 text-green-700 border-green-200",
};
const FLAG_LABEL = {
  [FLAGS.LATE]: "LATE",
  [FLAGS.NEED_EXTENSION]: "Need extension",
  [FLAGS.NUDGE]: "Nudge factory",
  [FLAGS.ON_TRACK]: "On track",
};
const FLAG_ORDER = { [FLAGS.LATE]: 0, [FLAGS.NEED_EXTENSION]: 1, [FLAGS.NUDGE]: 2, [FLAGS.ON_TRACK]: 3 };

const STAGE_STYLE = {
  ordered: "bg-gray-100 text-gray-600",
  factory_shipped: "bg-blue-50 text-blue-700",
  at_hk: "bg-purple-50 text-purple-700",
  inbound: "bg-cyan-50 text-cyan-700",
  received: "bg-emerald-50 text-emerald-700",
  closed: "bg-gray-200 text-gray-500",
};

const TABS = [
  { key: "board", label: "Board" },
  { key: "hk", label: "Staged at HK" },
  { key: "inbound", label: "Inbound" },
  { key: "received", label: "Received" },
  { key: "needs_link", label: "Needs link" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

function trackingUrl(carrier, tracking) {
  if (!tracking) return null;
  const t = encodeURIComponent(tracking);
  const c = String(carrier || "").toLowerCase();
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${t}`;
  if (String(tracking).toUpperCase().startsWith("SF")) return `https://www.sf-express.com/us/en/dynamic_function/waybill/#search/bill-number/${t}`;
  return null;
}

const fmtDate = (d) => {
  if (!d) return "—";
  const p = String(d).slice(0, 10).split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}/${p[0].slice(2)}` : d;
};
const dollar = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function Shipments() {
  const { supabase } = useSupabase();
  const [rows, setRows] = useState([]);
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [tab, setTab] = useState("board");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null); // {type:'factory'|'hk'|'received'|'master'|'shipout'} | {type:'link', row}
  const [busy, setBusy] = useState(false);

  async function load() {
    const [{ data: s, error: e1 }, { data: m, error: e2 }] = await Promise.all([
      supabase.from("shipments").select("*").order("due_date", { ascending: true }),
      supabase.from("inbound_masters").select("*").order("departed_at", { ascending: false }),
    ]);
    if (e1) console.error("shipments load:", e1.message);
    if (e2) console.error("masters load:", e2.message);
    setRows(s ?? []);
    setMasters(m ?? []);
    setLoading(false);
  }

  useEffect(() => {
    if (!supabase) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  async function runSync() {
    setSyncing(true);
    setSyncMsg("");
    const res = await syncShipmentsFromPOs(supabase);
    const bits = [`${res.scanned} POs scanned`, `${res.created} new`, `${res.updated} refreshed`];
    if (res.needsLink.length) bits.push(`${res.needsLink.length} need linking`);
    if (res.errors.length) bits.push(`${res.errors.length} errors (console)`);
    if (res.errors.length) console.error("sync errors:", res.errors);
    setSyncMsg(bits.join(" · "));
    setSyncing(false);
    await load();
  }

  const mastersById = useMemo(() => new Map(masters.map((m) => [m.id, m])), [masters]);

  const enriched = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        _flag: computeFlag(r),
        _stage: stageOf(r),
        _master: r.inbound_master_id ? mastersById.get(r.inbound_master_id) : null,
      })),
    [rows, mastersById]
  );

  const filtered = useMemo(() => {
    let list = enriched;
    if (tab === "board") list = list.filter((r) => isOnBoard(r) && r.link_source !== "needs_link");
    else if (tab === "hk") list = list.filter((r) => r.status === "open" && r._stage === "at_hk");
    else if (tab === "inbound") list = list.filter((r) => r.status === "open" && r._stage === "inbound");
    else if (tab === "received") list = list.filter((r) => r.status === "open" && r._stage === "received");
    else if (tab === "needs_link") list = list.filter((r) => r.link_source === "needs_link");
    else if (tab === "closed") list = list.filter((r) => r.status === "closed");
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (r) =>
          String(r.vendor_po).toLowerCase().includes(q) ||
          String(r.signet_po_number || "").toLowerCase().includes(q) ||
          String(r.vendor || "").toLowerCase().includes(q)
      );
    // sort: flag priority, then $ desc (decision #14: big dollars first)
    return [...list].sort((a, b) => {
      const fa = FLAG_ORDER[a._flag] ?? 4;
      const fb = FLAG_ORDER[b._flag] ?? 4;
      if (fa !== fb) return fa - fb;
      return (Number(b.amount) || 0) - (Number(a.amount) || 0);
    });
  }, [enriched, tab, search]);

  const selectedRows = useMemo(() => filtered.filter((r) => selected.has(r.id)), [filtered, selected]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const ids = filtered.map((r) => r.id);
      const all = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  async function applyPatches(patches) {
    setBusy(true);
    for (const [id, patch] of Object.entries(patches)) {
      const { error } = await supabase
        .from("shipments")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) console.error("stamp failed", id, error.message);
    }
    setBusy(false);
    setDialog(null);
    setSelected(new Set());
    await load();
  }

  async function createMaster({ master, shipmentIds }) {
    setBusy(true);
    const { data, error } = await supabase.from("inbound_masters").insert(master).select().single();
    if (error) {
      console.error("master insert:", error.message);
      alert("Failed: " + error.message);
      setBusy(false);
      return;
    }
    for (const id of shipmentIds) {
      const { error: e } = await supabase
        .from("shipments")
        .update({ inbound_master_id: data.id, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (e) console.error("attach failed", id, e.message);
    }
    setBusy(false);
    setDialog(null);
    setSelected(new Set());
    await load();
  }

  async function linkRow({ row, entries }) {
    setBusy(true);
    // entry 1 replaces the row itself; extras become sibling rows on the same Signet PO
    const [first, ...rest] = entries;
    const { error } = await supabase
      .from("shipments")
      .update({
        vendor_po: first.vendorPo,
        vendor: first.vendor,
        route: first.vendor === "Inah" ? "direct" : "hk",
        link_source: "manual",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) {
      console.error("link failed:", error.message);
      alert("Failed: " + error.message);
      setBusy(false);
      return;
    }
    for (const e of rest) {
      const { error: e2 } = await supabase.from("shipments").insert({
        vendor_po: e.vendorPo,
        signet_po_id: row.signet_po_id,
        signet_po_number: row.signet_po_number,
        vendor: e.vendor,
        ship_date: row.ship_date,
        due_date: row.due_date,
        amount: row.amount,
        route: e.vendor === "Inah" ? "direct" : "hk",
        link_source: "manual",
        memo_note: row.memo_note,
      });
      if (e2) {
        console.error("sibling insert failed:", e2.message);
        alert(`Linked ${first.vendorPo}, but ${e.vendorPo} failed: ` + e2.message);
      }
    }
    setBusy(false);
    setDialog(null);
    await load();
  }

  async function shipOut({ batch, boxList, invoiceMode, batchInvoice, perPoInvoice }) {
    setBusy(true);
    try {
      // 1) batch
      const { data: b, error: e1 } = await supabase
        .from("outbound_batches")
        .insert({
          carrier: batch.carrier,
          master_tracking: batch.masterTracking,
          shipped_date: batch.shippedDate,
          pickup_window: batch.pickupWindow,
          declared_value: batch.declaredValue,
        })
        .select()
        .single();
      if (e1) throw new Error("batch: " + e1.message);

      // 2) invoices (distinct non-empty numbers)
      const numbers = new Set();
      if (invoiceMode === "batch" && batchInvoice) numbers.add(batchInvoice);
      if (invoiceMode === "per_po") Object.values(perPoInvoice).forEach((v) => v && v.trim() && numbers.add(v.trim()));
      const invoiceIdByNumber = new Map();
      for (const num of numbers) {
        const { data: inv, error: eInv } = await supabase
          .from("invoices")
          .insert({ invoice_number: num })
          .select()
          .single();
        if (eInv) throw new Error("invoice: " + eInv.message);
        invoiceIdByNumber.set(num, inv.id);
      }

      // 3) boxes + contents
      const shipmentIds = new Set(boxList.map((x) => x.shipmentId));
      for (const box of boxList) {
        const { data: ob, error: e2 } = await supabase
          .from("outbound_boxes")
          .insert({ batch_id: b.id, box_number: box.boxNumber, per_box_tracking: box.tracking || null })
          .select()
          .single();
        if (e2) throw new Error("box: " + e2.message);
        const invId = box.invoiceNumber ? invoiceIdByNumber.get(box.invoiceNumber) ?? null : null;
        const { error: e3 } = await supabase
          .from("box_contents")
          .insert({ box_id: ob.id, shipment_id: box.shipmentId, invoice_id: invId });
        if (e3) throw new Error("contents: " + e3.message);
      }

      // 4) invoice<->shipment links
      for (const box of boxList) {
        if (!box.invoiceNumber) continue;
        const invId = invoiceIdByNumber.get(box.invoiceNumber);
        if (!invId) continue;
        await supabase
          .from("shipment_invoices")
          .upsert({ invoice_id: invId, shipment_id: box.shipmentId }, { onConflict: "invoice_id,shipment_id" });
      }

      // 5) close
      for (const id of shipmentIds) {
        const { error: e4 } = await supabase
          .from("shipments")
          .update({ status: "closed", updated_at: new Date().toISOString() })
          .eq("id", id);
        if (e4) throw new Error("close: " + e4.message);
      }
    } catch (err) {
      console.error("ship-out failed:", err.message);
      alert("Ship-out failed: " + err.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setDialog(null);
    setSelected(new Set());
    await load();
  }

  async function reopenSelected() {
    setBusy(true);
    for (const r of selectedRows) {
      const { error } = await supabase
        .from("shipments")
        .update({ status: "open", updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) console.error("reopen failed", r.vendor_po, error.message);
    }
    setBusy(false);
    setSelected(new Set());
    await load();
  }

  const counts = useMemo(() => {
    const c = { late: 0, ext: 0, nudge: 0, hk: 0, needsLink: 0 };
    for (const r of enriched) {
      if (r.status !== "open") continue;
      if (r.link_source === "needs_link") { c.needsLink++; continue; }
      if (r._flag === FLAGS.LATE) c.late++;
      else if (r._flag === FLAGS.NEED_EXTENSION) c.ext++;
      else if (r._flag === FLAGS.NUDGE) c.nudge++;
      if (r._stage === "at_hk") c.hk++;
    }
    return c;
  }, [enriched]);

  if (loading) return <div className="p-8 text-gray-500">Loading shipments…</div>;

  return (
    <div className="max-w-full">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Shipments</h1>
          <div className="text-sm text-gray-500 mt-0.5">
            <span className="text-red-600 font-medium">{counts.late} late</span>
            {" · "}
            <span className="text-orange-600">{counts.ext} need extension</span>
            {" · "}
            <span className="text-amber-600">{counts.nudge} to nudge</span>
            {" · "}
            <span className="text-purple-600">{counts.hk} at HK</span>
            {counts.needsLink > 0 && <> · <span>{counts.needsLink} need linking</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
          <button onClick={runSync} disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : "Refresh from POs"}
          </button>
        </div>
      </div>

      {/* tabs + search */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => { setTab(t.key); setSelected(new Set()); }}
            className={`px-3 py-1.5 text-sm rounded-full border ${tab === t.key ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-50"}`}>
            {t.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={15} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PO / SO / vendor"
            className="pl-8 pr-3 py-2 border rounded text-sm w-56" />
        </div>
      </div>

      {/* bulk action bar */}
      {selectedRows.length > 0 && (
        <div className="sticky top-0 z-40 flex flex-wrap items-center gap-2 bg-gray-900 text-white rounded-lg px-4 py-2.5 mb-3">
          <span className="text-sm font-medium">{selectedRows.length} selected</span>
          <div className="flex flex-wrap gap-2 ml-auto">
            {selectedRows.some((r) => r.status === "closed") && (
              <button onClick={reopenSelected} disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-amber-500/90 hover:bg-amber-400 font-medium">
                <RefreshCw size={13} /> Reopen
              </button>
            )}
            <button onClick={() => setDialog({ type: "factory" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20">
              <Factory size={13} /> Factory shipped
            </button>
            <button onClick={() => setDialog({ type: "hk" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20">
              <Anchor size={13} /> At HK
            </button>
            <button onClick={() => setDialog({ type: "master" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20">
              <Ship size={13} /> To warehouse…
            </button>
            <button onClick={() => setDialog({ type: "received" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20">
              <PackageCheck size={13} /> Received
            </button>
            <button onClick={() => setDialog({ type: "shipout" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-emerald-500 hover:bg-emerald-400 font-medium">
              <Truck size={13} /> Ship out
            </button>
          </div>
        </div>
      )}

      {/* table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase bg-gray-50">
              <th className="px-3 py-2 w-8">
                <input type="checkbox" onChange={toggleAll}
                  checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))} />
              </th>
              <th className="px-3 py-2">Vendor PO</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">SO / Signet PO</th>
              <th className="px-3 py-2">Ship</th>
              <th className="px-3 py-2">Cancel</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">Flag</th>
              <th className="px-3 py-2">Tracking</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const master = r._master;
              const url =
                (master && trackingUrl(master.carrier, master.tracking)) ||
                trackingUrl(null, r.leg1_tracking);
              const dd = daysUntil(r.due_date);
              return (
                <tr key={r.id} className={`border-t hover:bg-gray-50 ${selected.has(r.id) ? "bg-blue-50/40" : ""}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {r.vendor_po}
                    {r.memo_note && <span className="ml-1 text-xs text-gray-400" title={r.memo_note}>*</span>}
                  </td>
                  <td className="px-3 py-2">{r.vendor || "—"}</td>
                  <td className="px-3 py-2">{r.signet_po_number || "—"}</td>
                  <td className="px-3 py-2">{fmtDate(r.ship_date || r.target_ship_date)}</td>
                  <td className="px-3 py-2">
                    {fmtDate(r.due_date)}
                    {r.status === "open" && dd != null && dd <= 7 && (
                      <span className={`ml-1 text-xs ${dd < 0 ? "text-red-600 font-semibold" : "text-orange-600"}`}>
                        {dd < 0 ? `${-dd}d over` : `${dd}d`}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{dollar(r.amount)}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${STAGE_STYLE[r._stage]}`}>
                      {STAGE_LABELS[r._stage]}
                      {r._stage === "at_hk" && r.hk_arrived_at && (
                        <> · {Math.max(0, -daysUntil(r.hk_arrived_at))}d</>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.status === "open" && r._flag && r._flag !== FLAGS.ON_TRACK && (
                      <span className={`px-2 py-0.5 rounded border text-xs font-medium ${FLAG_STYLE[r._flag]}`}>
                        {FLAG_LABEL[r._flag]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                        {master ? `${master.carrier} ↗` : "track ↗"}
                      </a>
                    ) : master ? (
                      master.carrier
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.link_source === "needs_link" && (
                      <button onClick={() => setDialog({ type: "link", row: r })}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                        <Link2 size={12} /> link
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-gray-400">
                  Nothing here. {tab === "board" ? "Hit “Refresh from POs” to pull the live pipeline." : ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* dialogs */}
      {dialog?.type === "factory" && (
        <BulkStampDialog kind="factory" rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "hk" && (
        <BulkStampDialog kind="hk" rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "received" && (
        <BulkStampDialog kind="received" rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "master" && (
        <MasterDialog rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onSave={createMaster} />
      )}
      {dialog?.type === "link" && (
        <LinkSODialog row={dialog.row} busy={busy}
          onCancel={() => setDialog(null)} onSave={linkRow} />
      )}
      {dialog?.type === "shipout" && (
        <ShipOutDialog rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onConfirm={shipOut} />
      )}
    </div>
  );
}
