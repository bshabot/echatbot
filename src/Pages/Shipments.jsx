import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { RefreshCw, Search, Truck, Link2, StickyNote, Upload, PackagePlus } from "lucide-react";
import {
  syncShipmentsFromPOs,
  computeFlag,
  stageOf,
  shippedDateOf,
  FLAGS,
  daysUntil,
  shipDateOf,
  dueDateOf,
  amountOf,
} from "../utils/shipmentsSync";
import { importQbPos } from "../utils/qbPoImport";
import MarkShippedDialog from "../components/Shipments/MarkShippedDialog";
import ShipOutDialog from "../components/Shipments/ShipOutDialog";
import LinkSODialog from "../components/Shipments/LinkSODialog";

// ─── Shipments v2 — the simple one (7/2/26) ────────────────────────────────
// One row per open SALES ORDER, its vendor POs nested. Two buttons:
// Mark shipped (date + boxes + optional tracking) and Ship out (invoices +
// manifest + pickup doc + CLOSED). Three tabs. Everything else is plumbing.

const FLAG_ORDER = { [FLAGS.LATE]: 0, [FLAGS.NEED_EXTENSION]: 1, [FLAGS.NUDGE]: 2, [FLAGS.ON_TRACK]: 3 };
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

const TABS = [
  { key: "open", label: "Open" },
  { key: "attention", label: "Needs attention" },
  { key: "closed", label: "Closed" },
];

function trackingUrl(carrier, tracking) {
  if (!tracking) return null;
  const t = encodeURIComponent(tracking);
  const c = String(carrier || "").toLowerCase();
  const up = String(tracking).toUpperCase();
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes("ups") || up.startsWith("1Z")) return `https://www.ups.com/track?tracknum=${t}`;
  if (up.startsWith("SF")) return `https://www.sf-express.com/us/en/dynamic_function/waybill/#search/bill-number/${t}`;
  if (/^\d{10}$/.test(tracking)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
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
  const [outbound, setOutbound] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [qbBusy, setQbBusy] = useState(false);
  const [tab, setTab] = useState("open");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [{ data: s, error: e1 }, { data: bc, error: e2 }, { data: si, error: e3 }] = await Promise.all([
      supabase.from("shipments").select("*").order("due_date", { ascending: true }),
      supabase
        .from("box_contents")
        .select("shipment_id, invoices(invoice_number), outbound_boxes(per_box_tracking, outbound_batches(carrier, master_tracking, shipped_date))"),
      supabase.from("shipment_invoices").select("shipment_id, invoices(invoice_number)"),
    ]);
    if (e1) console.error("shipments load:", e1.message);
    if (e2) console.error("outbound load:", e2.message);
    if (e3) console.error("invoice links load:", e3.message);
    setRows(s ?? []);
    const ob = new Map();
    for (const row of bc ?? []) {
      const cur = ob.get(row.shipment_id) || { invoices: new Set(), trackings: new Set(), carrier: null };
      if (row.invoices?.invoice_number) cur.invoices.add(row.invoices.invoice_number);
      const box = row.outbound_boxes;
      const batch = box?.outbound_batches;
      if (batch?.carrier) cur.carrier = batch.carrier;
      const trk = box?.per_box_tracking || batch?.master_tracking;
      if (trk) cur.trackings.add(trk);
      ob.set(row.shipment_id, cur);
    }
    for (const row of si ?? []) {
      if (!row.invoices?.invoice_number) continue;
      const cur = ob.get(row.shipment_id) || { invoices: new Set(), trackings: new Set(), carrier: null };
      cur.invoices.add(row.invoices.invoice_number);
      ob.set(row.shipment_id, cur);
    }
    setOutbound(ob);
    setLoading(false);
  }

  async function runSync(silent) {
    setSyncing(true);
    const res = await syncShipmentsFromPOs(supabase);
    if (!silent || res.created > 0 || res.errors.length > 0) {
      const bits = [`${res.scanned} POs`, `${res.created} new`, `${res.updated} refreshed`];
      if (res.errors.length) { bits.push(`${res.errors.length} errors`); console.error(res.errors); }
      setSyncMsg(bits.join(" · "));
    }
    setSyncing(false);
    await load();
  }

  useEffect(() => {
    if (!supabase) return;
    load().then(() => runSync(true)); // paint fast, sync quietly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const enriched = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        _flag: computeFlag(r),
        _stage: stageOf(r),
        _out: outbound.get(r.id),
      })),
    [rows, outbound]
  );

  // ── group by sales order ──
  const groups = useMemo(() => {
    const bySO = new Map();
    for (const r of enriched) {
      const key = r.signet_po_number || "no-so";
      if (!bySO.has(key)) bySO.set(key, []);
      bySO.get(key).push(r);
    }
    const out = [];
    for (const [so, pos] of bySO) {
      const open = pos.filter((p) => p.status === "open");
      const flags = open.map((p) => p._flag).filter(Boolean);
      const worst = flags.length ? flags.reduce((a, b) => (FLAG_ORDER[a] <= FLAG_ORDER[b] ? a : b)) : null;
      const linkIssue = pos.some((p) => p.link_source === "needs_link" || String(p.memo_note || "").includes("⚠"));
      // SO dollars: exact per-PO QB amounts when all present, else the parent total once
      let soAmount;
      if (pos.every((p) => p.qb_amount != null)) soAmount = pos.reduce((n, p) => n + Number(p.qb_amount || 0), 0);
      else soAmount = Math.max(...pos.map((p) => Number(p.amount) || 0), 0) || null;
      out.push({
        so: so === "no-so" ? null : so,
        pos: pos.sort((a, b) => String(a.vendor_po).localeCompare(String(b.vendor_po))),
        ship: pos.map(shipDateOf).filter(Boolean).sort()[0] || null,
        due: pos.map(dueDateOf).filter(Boolean).sort()[0] || null,
        amount: soAmount,
        flag: worst,
        linkIssue,
        openCount: open.length,
        shippedCount: pos.filter((p) => p._stage !== "ordered").length,
        allClosed: pos.length > 0 && pos.every((p) => p.status === "closed"),
      });
    }
    return out;
  }, [enriched]);

  const filtered = useMemo(() => {
    let list = groups;
    if (tab === "open") list = list.filter((g) => !g.allClosed);
    else if (tab === "attention")
      list = list.filter(
        (g) => !g.allClosed && (g.linkIssue || (g.flag && g.flag !== FLAGS.ON_TRACK))
      );
    else if (tab === "closed") list = list.filter((g) => g.allClosed);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          String(g.so || "").toLowerCase().includes(q) ||
          g.pos.some(
            (p) =>
              String(p.vendor_po).toLowerCase().includes(q) ||
              String(p.vendor || "").toLowerCase().includes(q) ||
              [...(p._out?.invoices ?? [])].some((i) => i.toLowerCase().includes(q))
          )
      );
    }
    return [...list].sort((a, b) => {
      const fa = a.flag ? FLAG_ORDER[a.flag] : 4;
      const fb = b.flag ? FLAG_ORDER[b.flag] : 4;
      if (fa !== fb) return fa - fb;
      return (Number(b.amount) || 0) - (Number(a.amount) || 0);
    });
  }, [groups, tab, search]);

  const selectedRows = useMemo(() => enriched.filter((r) => selected.has(r.id)), [enriched, selected]);

  function togglePo(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleSO(g) {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = g.pos.filter((p) => p.status === "open").map((p) => p.id);
      const all = ids.length > 0 && ids.every((id) => next.has(id));
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

  async function linkRow({ row, entries }) {
    setBusy(true);
    const [first, ...rest] = entries;
    const cleanedNote =
      String(row.memo_note || "")
        .split(";")
        .map((s2) => s2.trim())
        .filter((s2) => s2 && !s2.includes("⚠"))
        .join("; ") || null;
    const { error } = await supabase
      .from("shipments")
      .update({
        vendor_po: first.vendorPo,
        vendor: first.vendor,
        route: first.vendor === "Inah" ? "direct" : "hk",
        link_source: "manual",
        memo_note: cleanedNote,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) {
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
      });
      if (e2) alert(`Linked ${first.vendorPo}, but ${e.vendorPo} failed: ` + e2.message);
    }
    setBusy(false);
    setDialog(null);
    await load();
  }

  async function shipOut({ batch, boxList, invoiceMode, batchInvoice, perPoInvoice }) {
    setBusy(true);
    try {
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

      const numbers = new Set();
      if (invoiceMode === "batch" && batchInvoice) numbers.add(batchInvoice);
      if (invoiceMode === "per_po") Object.values(perPoInvoice).forEach((v) => v && v.trim() && numbers.add(v.trim()));
      const invoiceIdByNumber = new Map();
      for (const num of numbers) {
        const { data: existing } = await supabase.from("invoices").select("id").eq("invoice_number", num).limit(1);
        if (existing?.length) {
          invoiceIdByNumber.set(num, existing[0].id);
        } else {
          const { data: inv, error: eInv } = await supabase.from("invoices").insert({ invoice_number: num }).select().single();
          if (eInv) throw new Error("invoice: " + eInv.message);
          invoiceIdByNumber.set(num, inv.id);
        }
      }

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
      for (const box of boxList) {
        if (!box.invoiceNumber) continue;
        const invId = invoiceIdByNumber.get(box.invoiceNumber);
        if (!invId) continue;
        await supabase
          .from("shipment_invoices")
          .upsert({ invoice_id: invId, shipment_id: box.shipmentId }, { onConflict: "invoice_id,shipment_id" });
      }
      for (const id of shipmentIds) {
        const { error: e4 } = await supabase
          .from("shipments")
          .update({ status: "closed", updated_at: new Date().toISOString() })
          .eq("id", id);
        if (e4) throw new Error("close: " + e4.message);
      }
    } catch (err) {
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
    for (const r of selectedRows.filter((x) => x.status === "closed")) {
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
    const c = { late: 0, ext: 0, nudge: 0, link: 0 };
    for (const g of groups) {
      if (g.allClosed) continue;
      if (g.flag === FLAGS.LATE) c.late++;
      else if (g.flag === FLAGS.NEED_EXTENSION) c.ext++;
      else if (g.flag === FLAGS.NUDGE) c.nudge++;
      if (g.linkIssue) c.link++;
    }
    return c;
  }, [groups]);

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
            {counts.link > 0 && <> · <span>{counts.link} need linking</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-xs text-gray-400">{syncMsg}</span>}
          <label className="flex items-center gap-2 px-3 py-2 text-sm rounded border hover:bg-gray-50 cursor-pointer" title="Import the QB purchase orders export">
            <Upload size={14} />
            {qbBusy ? "Importing…" : "QB import"}
            <input type="file" accept=".xlsx,.xls" className="hidden" disabled={qbBusy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setQbBusy(true);
                try {
                  const res = await importQbPos(supabase, await f.arrayBuffer());
                  const bits = [`QB: ${res.updated} updated`, `${res.inserted} new`];
                  if (res.conflicts.length) bits.push(`${res.conflicts.length} conflicts → Needs attention`);
                  if (res.errors.length) { bits.push(`${res.errors.length} errors`); console.error(res.errors); }
                  setSyncMsg(bits.join(" · "));
                } catch (err) {
                  setSyncMsg("QB import failed: " + (err?.message || err));
                }
                setQbBusy(false);
                await load();
              }} />
          </label>
          <button onClick={() => runSync(false)} disabled={syncing} title="Re-pull from the PO table"
            className="flex items-center gap-2 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* tabs + search */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm rounded-full border ${tab === t.key ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-50"}`}>
            {t.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={15} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SO / PO / vendor / invoice"
            className="pl-8 pr-3 py-2 border rounded text-sm w-64" />
        </div>
      </div>

      {/* action bar */}
      {selectedRows.length > 0 && (
        <div className="sticky top-0 z-40 flex flex-wrap items-center gap-3 bg-gray-900 text-white rounded-lg px-4 py-2.5 mb-3">
          <span className="text-sm font-medium">{selectedRows.length} PO{selectedRows.length === 1 ? "" : "s"}</span>
          <button onClick={() => setSelected(new Set())} className="text-xs text-white/60 hover:text-white underline">
            clear
          </button>
          <div className="flex flex-wrap gap-2 ml-auto">
            {selectedRows.some((r) => r.status === "closed") && (
              <button onClick={reopenSelected} disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-amber-500/90 hover:bg-amber-400 font-medium">
                <RefreshCw size={13} /> Reopen
              </button>
            )}
            <button onClick={() => setDialog({ type: "shipped" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20 font-medium">
              <PackagePlus size={13} /> Mark shipped
            </button>
            <button onClick={() => setDialog({ type: "shipout" })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-emerald-500 hover:bg-emerald-400 font-medium">
              <Truck size={13} /> Ship out
            </button>
          </div>
        </div>
      )}

      {/* the list */}
      <div className="bg-white rounded-lg border divide-y">
        {filtered.map((g) => {
          const dd = daysUntil(g.due);
          return (
            <div key={g.so || "no-so"} className="py-1">
              {/* SO row */}
              <div className="flex items-center gap-3 px-4 py-2">
                <input type="checkbox"
                  checked={g.pos.filter((p) => p.status === "open").length > 0 &&
                    g.pos.filter((p) => p.status === "open").every((p) => selected.has(p.id))}
                  onChange={() => toggleSO(g)} />
                <span className="font-semibold">{g.so ? `SO ${g.so}` : "No sales order"}</span>
                <span className="text-sm text-gray-500">
                  {fmtDate(g.ship)} → {fmtDate(g.due)}
                  {!g.allClosed && dd != null && dd <= 7 && (
                    <span className={`ml-1 font-medium ${dd < 0 ? "text-red-600" : "text-orange-600"}`}>
                      {dd < 0 ? `${-dd}d over` : `${dd}d left`}
                    </span>
                  )}
                </span>
                <span className="text-sm text-gray-600">{dollar(g.amount)}</span>
                <span className="text-xs text-gray-400">{g.shippedCount}/{g.pos.length} shipped</span>
                <span className="ml-auto">
                  {g.allClosed ? (
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-500">CLOSED</span>
                  ) : g.flag && g.flag !== FLAGS.ON_TRACK ? (
                    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${FLAG_STYLE[g.flag]}`}>
                      {FLAG_LABEL[g.flag]}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded border text-xs bg-green-50 text-green-700 border-green-200">on track</span>
                  )}
                </span>
              </div>
              {/* PO lines */}
              {g.pos.map((p) => {
                const o = p._out;
                const invs = o ? [...o.invoices] : [];
                const outTrks = o ? [...o.trackings] : [];
                const inUrl = trackingUrl(null, p.leg1_tracking);
                return (
                  <div key={p.id}
                    className={`flex items-center gap-3 pl-12 pr-4 py-1.5 text-sm hover:bg-gray-50 ${selected.has(p.id) ? "bg-blue-50/40" : ""}`}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => togglePo(p.id)} />
                    <span className="font-medium w-20">{p.vendor_po}</span>
                    <span className="w-16 text-gray-600">{p.vendor || "—"}</span>
                    <span className="flex-1 text-gray-600">
                      {p.status === "closed" ? (
                        <span className="text-gray-500">
                          ✓ closed{invs.length > 0 && <> · inv <b>{invs.join(", ")}</b></>}
                          {outTrks.length > 0 && (
                            <>
                              {" · "}
                              {outTrks.map((t, i) => {
                                const u = trackingUrl(o?.carrier, t);
                                return (
                                  <span key={t}>
                                    {i > 0 && ", "}
                                    {u ? <a href={u} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{o?.carrier || "track"} ↗</a> : t}
                                  </span>
                                );
                              })}
                            </>
                          )}
                        </span>
                      ) : p._stage === "shipped" ? (
                        <span>
                          shipped {fmtDate(shippedDateOf(p))}
                          {p.carton_count ? ` · ${p.carton_count} box${p.carton_count === 1 ? "" : "es"}` : ""}
                          {p.leg1_tracking && (
                            <>
                              {" · "}
                              {inUrl ? (
                                <a href={inUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">track ↗</a>
                              ) : (
                                p.leg1_tracking
                              )}
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-400">not shipped</span>
                      )}
                    </span>
                    {String(p.memo_note || "").includes("⚠") && (
                      <span className="text-xs text-red-600 font-bold" title={p.memo_note}>⚠</span>
                    )}
                    <button onClick={() => setDialog({ type: "notes", row: p })} title={p.notes || "Add note"}
                      className={p.notes ? "text-amber-500 hover:text-amber-600" : "text-gray-300 hover:text-gray-500"}>
                      <StickyNote size={14} />
                    </button>
                    {p.link_source === "needs_link" && (
                      <button onClick={() => setDialog({ type: "link", row: p })}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                        <Link2 size={12} /> link
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-400">
            Nothing here.{tab === "open" ? " The board fills itself from the PO table on load." : ""}
          </div>
        )}
      </div>

      {/* dialogs */}
      {dialog?.type === "shipped" && (
        <MarkShippedDialog rows={selectedRows.filter((r) => r.status === "open")} busy={busy}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "shipout" && (
        <ShipOutDialog rows={selectedRows} busy={busy}
          onCancel={() => setDialog(null)} onConfirm={shipOut} />
      )}
      {dialog?.type === "link" && (
        <LinkSODialog row={dialog.row} busy={busy}
          onCancel={() => setDialog(null)} onSave={linkRow} />
      )}
      {dialog?.type === "notes" && (
        <NotesDialog row={dialog.row} busy={busy}
          onCancel={() => setDialog(null)}
          onSave={async (text) => {
            setBusy(true);
            const { error } = await supabase
              .from("shipments")
              .update({ notes: text || null, updated_at: new Date().toISOString() })
              .eq("id", dialog.row.id);
            if (error) alert("Failed: " + error.message);
            setBusy(false);
            setDialog(null);
            await load();
          }} />
      )}
    </div>
  );
}

function NotesDialog({ row, onCancel, onSave, busy }) {
  const [text, setText] = useState(row.notes || "");
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b">
          <div className="font-semibold text-lg">Note — PO {row.vendor_po}</div>
          <div className="text-sm text-gray-500">{row.vendor || "—"} · SO {row.signet_po_number || "—"}</div>
        </div>
        <div className="px-5 py-4">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus
            placeholder="e.g. remove samples from box 2, ship with 12771…"
            className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={() => onSave(text.trim())} disabled={busy}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50">
            {busy ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}
