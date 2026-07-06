import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useAlert } from "../components/Alerts/AlertContext";
import { RefreshCw, Search, Truck, Link2, StickyNote, Upload, X } from "lucide-react";
import {
  SHIPMENTS_TABLE,
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
import LinkSODialog from "../components/Shipments/LinkSODialog";

// ─── Shipments v3 — receivings first (7/6/26) ───────────────────────────────
// Flat table, one row per vendor PO (the PurchaseOrders vibe). This iteration
// does TWO jobs only:
//   1. Receive shipping notices: multiselect → Mark shipped (date + boxes +
//      optional tracking + note).
//   2. Import the weekly QuickBooks PO export to link vendor POs → sales
//      orders (SO = Signet PO number; QB per-PO $ + dates as fallback).
// Ship-out (invoices → manifest → closed) comes next iteration.

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

// Two views, two jobs:
//   ARRIVING TO US   = vendor-facing inbound: mark shipped, boxes, notes, QB import.
//   SHIPPING TO SIGNET = SO status: each sales order with its POs, n/m shipped,
//                        and a loud callout when a PO isn't shipped near its ship date.
const MODES = [
  { key: "receiving", label: "Arriving to us" },
  { key: "so", label: "Shipping to Signet" },
];
const SUBTABS = {
  receiving: [
    { key: "open", label: "Open" },
    { key: "attention", label: "Needs attention" },
    { key: "closed", label: "Closed" },
  ],
  so: [
    { key: "open", label: "Open" },
    { key: "closed", label: "Shipped / closed" },
  ],
};

function trackingUrl(tracking) {
  if (!tracking) return null;
  const t = encodeURIComponent(tracking);
  const up = String(tracking).toUpperCase();
  if (up.startsWith("1Z")) return `https://www.ups.com/track?tracknum=${t}`;
  if (up.startsWith("SF")) return `https://www.sf-express.com/us/en/dynamic_function/waybill/#search/bill-number/${t}`;
  if (/^\d{10}$/.test(tracking)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
  if (/^\d{12}$/.test(tracking)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
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
  const { showAlert } = useAlert();
  const fileRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [qbBusy, setQbBusy] = useState(false);
  const [mode, setMode] = useState("receiving");
  const [tab, setTab] = useState("open"); // subfilter within the current mode
  const [sort, setSort] = useState({ key: "priority", dir: "asc" }); // priority = flag then $
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase
      .from(SHIPMENTS_TABLE)
      .select("*")
      .order("due_date", { ascending: true })
      .limit(5000);
    if (error) {
      console.error("shipments load:", error.message);
      showAlert("Couldn't load shipments: " + error.message, { variant: "error" });
    }
    setRows(data ?? []);
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

  async function onQbFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setQbBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await importQbPos(supabase, buf);
      const lines = [
        `${res.parsed} POs in file · ${res.updated} updated · ${res.inserted} added`,
      ];
      if (res.conflicts.length) {
        lines.push("", `⚠ ${res.conflicts.length} conflict${res.conflicts.length === 1 ? "" : "s"} (flagged, not overwritten):`);
        lines.push(...res.conflicts.slice(0, 10).map((c) => "· " + c));
        if (res.conflicts.length > 10) lines.push(`…and ${res.conflicts.length - 10} more — see Needs attention`);
      }
      if (res.errors.length) {
        lines.push("", `${res.errors.length} error${res.errors.length === 1 ? "" : "s"}:`);
        lines.push(...res.errors.slice(0, 5).map((c) => "· " + c));
        console.error(res.errors);
      }
      await showAlert(lines.join("\n"), {
        title: "QuickBooks import",
        variant: res.errors.length ? "error" : res.conflicts.length ? "warning" : "success",
      });
    } catch (err) {
      console.error("qb import:", err);
      await showAlert("Import failed: " + err.message, { variant: "error" });
    }
    setQbBusy(false);
    await load();
  }

  const enriched = useMemo(
    () => rows.map((r) => ({ ...r, _flag: computeFlag(r), _stage: stageOf(r) })),
    [rows]
  );

  const filtered = useMemo(() => {
    let list = enriched;
    if (tab === "closed") list = list.filter((r) => r.status === "closed");
    else if (tab === "attention")
      list = list.filter(
        (r) =>
          r.status === "open" &&
          (r.link_source === "needs_link" ||
            String(r.memo_note || "").includes("⚠") ||
            (r._flag && r._flag !== FLAGS.ON_TRACK))
      );
    else list = list.filter((r) => r.status === "open");
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (r) =>
          String(r.vendor_po).toLowerCase().includes(q) ||
          String(r.signet_po_number || "").toLowerCase().includes(q) ||
          String(r.vendor || "").toLowerCase().includes(q) ||
          String(r.notes || "").toLowerCase().includes(q)
      );
    const sortVal = (r) => {
      switch (sort.key) {
        case "po": { const n = parseInt(r.vendor_po, 10); return Number.isFinite(n) ? n : null; }
        case "vendor": return r.vendor || null;
        case "so": { const n = parseInt(r.signet_po_number, 10); return Number.isFinite(n) ? n : null; }
        case "ship": return shipDateOf(r);
        case "cancel": return dueDateOf(r);
        case "amount": return Number(amountOf(r)) || 0;
        case "status": return r.status === "closed" ? "zz-closed" : shippedDateOf(r) || "";
        default: return null;
      }
    };
    return [...list].sort((a, b) => {
      if (sort.key === "priority") {
        const fa = FLAG_ORDER[a._flag] ?? 4;
        const fb = FLAG_ORDER[b._flag] ?? 4;
        if (fa !== fb) return fa - fb;
        return (Number(amountOf(b)) || 0) - (Number(amountOf(a)) || 0);
      }
      const av = sortVal(a);
      const bv = sortVal(b);
      const aNull = av == null || av === "";
      const bNull = bv == null || bv === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1; // nulls last regardless of direction
      if (bNull) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? c : -c;
    });
  }, [enriched, tab, search, sort]);

  function clickSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  const sortArrow = (key) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  function switchMode(m) {
    setMode(m);
    setTab("open");
  }

  // ── Sales-order view: group the filtered rows by SO ──
  // "shipped" = any signal goods left the factory. A PO still sitting at the
  // factory close to its ship date is the thing this view exists to surface.
  const soGroups = useMemo(() => {
    if (mode !== "so") return [];
    const bySO = new Map();
    for (const r of filtered) {
      const key = r.signet_po_number || "No SO";
      if (!bySO.has(key)) bySO.set(key, []);
      bySO.get(key).push(r);
    }
    const groups = [...bySO.entries()].map(([so, pos]) => {
      const shippedCount = pos.filter((p) => p._stage !== "ordered").length;
      const flags = pos.map((p) => p._flag).filter(Boolean);
      const worst = flags.length ? flags.reduce((a, b) => (FLAG_ORDER[a] <= FLAG_ORDER[b] ? a : b)) : null;
      const ship = pos.map(shipDateOf).filter(Boolean).sort()[0] || null;
      const cancel = pos.map(dueDateOf).filter(Boolean).sort()[0] || null;
      const total = pos.reduce((s, p) => s + (Number(amountOf(p)) || 0), 0);
      // not shipped + close to (or past) the ship date → callout
      const risks = pos
        .filter((p) => p.status === "open" && p._stage === "ordered" && p._flag && p._flag !== FLAGS.ON_TRACK)
        .map((p) => ({ row: p, days: daysUntil(shipDateOf(p)) }))
        .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
      return { so, pos, shippedCount, worst, ship, cancel, total, risks };
    });
    return groups.sort(
      (a, b) =>
        (FLAG_ORDER[a.worst] ?? 4) - (FLAG_ORDER[b.worst] ?? 4) ||
        String(a.ship || "9999").localeCompare(String(b.ship || "9999"))
    );
  }, [filtered, mode]);

  const selectedRows = useMemo(() => enriched.filter((r) => selected.has(r.id)), [enriched, selected]);
  const hiddenSelectedCount = useMemo(() => {
    const visible = new Set(filtered.map((r) => r.id));
    return selectedRows.filter((r) => !visible.has(r.id)).length;
  }, [filtered, selectedRows]);

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
    const fails = [];
    for (const [id, patch] of Object.entries(patches)) {
      const { error } = await supabase
        .from(SHIPMENTS_TABLE)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) { console.error("stamp failed", id, error.message); fails.push(error.message); }
    }
    setBusy(false);
    setDialog(null);
    setSelected(new Set());
    if (fails.length) showAlert(`${fails.length} update${fails.length === 1 ? "" : "s"} failed — see console.`, { variant: "error" });
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
      .from(SHIPMENTS_TABLE)
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
      showAlert("Failed: " + error.message, { variant: "error" });
      setBusy(false);
      return;
    }
    for (const e of rest) {
      const { error: e2 } = await supabase.from(SHIPMENTS_TABLE).insert({
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
      if (e2) showAlert(`Linked ${first.vendorPo}, but ${e.vendorPo} failed: ` + e2.message, { variant: "error" });
    }
    setBusy(false);
    setDialog(null);
    await load();
  }

  async function saveNote(row, text) {
    const { error } = await supabase
      .from(SHIPMENTS_TABLE)
      .update({ notes: text || null, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) showAlert("Note failed: " + error.message, { variant: "error" });
    setDialog(null);
    await load();
  }

  const openSelected = selectedRows.filter((r) => r.status === "open");

  const counts = useMemo(() => {
    const c = { attention: 0 };
    for (const r of enriched) {
      if (r.status !== "open") continue;
      if (
        r.link_source === "needs_link" ||
        String(r.memo_note || "").includes("⚠") ||
        (r._flag && r._flag !== FLAGS.ON_TRACK)
      )
        c.attention++;
    }
    return c;
  }, [enriched]);

  function renderRow(r) {
    const inUrl = trackingUrl(r.leg1_tracking);
    const dd = daysUntil(dueDateOf(r));
    const needsLink = r.link_source === "needs_link" || String(r.memo_note || "").includes("⚠");
    return (
      <tr key={r.id} className={`border-t hover:bg-gray-50 ${selected.has(r.id) ? "bg-blue-50/40" : ""}`}>
        <td className="px-3 py-2">
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
        </td>
        <td className="px-3 py-2 font-medium">
          {r.vendor_po}
          {r.memo_note &&
            (r.memo_note.includes("⚠") ? (
              <span className="ml-1 text-xs text-red-600 font-bold" title={r.memo_note}>⚠</span>
            ) : (
              <span className="ml-1 text-xs text-gray-400" title={r.memo_note}>*</span>
            ))}
        </td>
        <td className="px-3 py-2">{r.vendor || "—"}</td>
        <td className="px-3 py-2">{r.signet_po_number || "—"}</td>
        <td className="px-3 py-2">
          {fmtDate(shipDateOf(r))}
          {!r.ship_date && r.qb_ship_date && <span className="ml-1 text-[10px] text-gray-400">QB</span>}
        </td>
        <td className="px-3 py-2">
          {fmtDate(dueDateOf(r))}
          {r.status === "open" && dd != null && dd <= 7 && (
            <span className={`ml-1 text-xs ${dd < 0 ? "text-red-600 font-semibold" : "text-orange-600"}`}>
              {dd < 0 ? `${-dd}d over` : `${dd}d`}
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right">{dollar(amountOf(r))}</td>
        <td className="px-3 py-2 text-xs">
          {r.status === "closed" ? (
            <span className="px-2 py-0.5 rounded bg-gray-200 text-gray-500">CLOSED</span>
          ) : r._stage === "shipped" ? (
            <span className="text-blue-700">
              shipped {fmtDate(shippedDateOf(r))}
              {r.carton_count ? ` · ${r.carton_count} bx` : ""}
              {r.leg1_tracking &&
                (inUrl ? (
                  <a href={inUrl} target="_blank" rel="noreferrer" className="ml-1 underline">{r.leg1_tracking}</a>
                ) : (
                  <span className="ml-1">{r.leg1_tracking}</span>
                ))}
            </span>
          ) : (
            <span className="text-gray-400">not shipped</span>
          )}
        </td>
        <td className="px-3 py-2">
          {r.status === "open" && r._flag && r._flag !== FLAGS.ON_TRACK && (
            <span className={`px-2 py-0.5 rounded border text-xs font-medium ${FLAG_STYLE[r._flag]}`}>
              {FLAG_LABEL[r._flag]}
            </span>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setDialog({ type: "notes", row: r })} title={r.notes || "Add note"}
              className={r.notes ? "text-amber-500 hover:text-amber-600" : "text-gray-300 hover:text-gray-500"}>
              <StickyNote size={15} />
            </button>
            {needsLink && (
              <button onClick={() => setDialog({ type: "link", row: r })} title="Link PO ↔ SO"
                className="text-blue-500 hover:text-blue-700">
                <Link2 size={15} />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="p-6">
      {/* header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Truck size={24} /> Shipments
          </h1>
          {syncMsg && <div className="text-xs text-gray-500 mt-0.5">{syncMsg}</div>}
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onQbFile} />
          <button onClick={() => fileRef.current?.click()} disabled={qbBusy}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <Upload size={15} /> {qbBusy ? "Importing…" : "Import QB file"}
          </button>
          <button onClick={() => runSync(false)} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} /> Refresh from POs
          </button>
        </div>
      </div>

      {/* views + tabs + search */}
      <div className="flex items-center gap-2 mb-3">
        {MODES.map((m) => (
          <button key={m.key} onClick={() => switchMode(m.key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg border ${mode === m.key ? "bg-gray-900 text-white border-gray-900" : "bg-white hover:bg-gray-50 text-gray-700"}`}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex gap-1">
          {SUBTABS[mode].map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-full ${tab === t.key ? "bg-gray-900 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
              {t.label}
              {t.key === "attention" && counts.attention > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-red-500 text-white">{counts.attention}</span>
              )}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="PO, SO, vendor, note…"
            className="pl-8 pr-3 py-2 text-sm border rounded w-64" />
        </div>
      </div>

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded">
          <span className="text-sm font-medium">
            {selected.size} selected
            {hiddenSelectedCount > 0 && (
              <span className="text-gray-500 font-normal"> ({hiddenSelectedCount} not shown by this filter)</span>
            )}
          </span>
          {openSelected.length > 0 && (
            <button onClick={() => setDialog({ type: "shipped", rows: openSelected })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-gray-900 text-white hover:bg-black">
              <Truck size={14} /> Mark shipped ({openSelected.length})
            </button>
          )}
          <button onClick={() => setSelected(new Set())}
            className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-500 hover:text-gray-800 ml-auto">
            <X size={14} /> Clear
          </button>
        </div>
      )}

      {/* table */}
      {loading ? (
        <div className="text-gray-400 py-16 text-center">Loading…</div>
      ) : mode === "so" ? (
        <div className="space-y-4">
          {soGroups.map((g) => (
            <div key={g.so} className="border rounded-lg bg-white overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b flex-wrap">
                <span className="font-semibold">SO {g.so}</span>
                {g.worst && g.worst !== FLAGS.ON_TRACK && (
                  <span className={`px-2 py-0.5 rounded border text-xs font-medium ${FLAG_STYLE[g.worst]}`}>
                    {FLAG_LABEL[g.worst]}
                  </span>
                )}
                <span className="text-sm text-gray-500">
                  ship {fmtDate(g.ship)} · cancel {fmtDate(g.cancel)}
                </span>
                <span className={`text-sm font-medium ${g.shippedCount === g.pos.length ? "text-green-700" : "text-gray-700"}`}>
                  {g.shippedCount} of {g.pos.length} shipped
                </span>
                <span className="ml-auto text-sm text-gray-500">{dollar(g.total)}</span>
              </div>
              {g.risks.length > 0 && (
                <div className="px-4 py-2 bg-red-50 border-b border-red-100 space-y-0.5">
                  {g.risks.map(({ row, days }) => (
                    <div key={row.id} className="text-sm text-red-700">
                      ⚠ <span className="font-medium">{row.vendor || "?"} {row.vendor_po}</span> not shipped —{" "}
                      {days == null ? "no ship date" : days < 0 ? `ship date was ${-days}d ago` : days === 0 ? "ships TODAY" : `ships in ${days}d`}
                      {daysUntil(dueDateOf(row)) != null && daysUntil(dueDateOf(row)) < 0 && (
                        <span className="font-semibold"> · PAST CANCEL DATE</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 uppercase">
                    <th className="px-3 py-1.5 w-8" />
                    <th className="px-3 py-1.5">Vendor PO</th>
                    <th className="px-3 py-1.5">Vendor</th>
                    <th className="px-3 py-1.5">SO</th>
                    <th className="px-3 py-1.5">Ship by</th>
                    <th className="px-3 py-1.5">Cancel</th>
                    <th className="px-3 py-1.5 text-right">$</th>
                    <th className="px-3 py-1.5">Status</th>
                    <th className="px-3 py-1.5">Flag</th>
                    <th className="px-3 py-1.5 w-16" />
                  </tr>
                </thead>
                <tbody>{g.pos.map(renderRow)}</tbody>
              </table>
            </div>
          ))}
          {soGroups.length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm border rounded-lg bg-white">Nothing here.</div>
          )}
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase bg-gray-50 select-none">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox"
                    checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                    onChange={toggleAll} />
                </th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("po")}>Vendor PO{sortArrow("po")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("vendor")}>Vendor{sortArrow("vendor")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("so")}>SO / Signet PO{sortArrow("so")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("ship")}>Ship by{sortArrow("ship")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("cancel")}>Cancel{sortArrow("cancel")}</th>
                <th className="px-3 py-2 cursor-pointer text-right" onClick={() => clickSort("amount")}>${sortArrow("amount")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("status")}>Status{sortArrow("status")}</th>
                <th className="px-3 py-2 cursor-pointer" onClick={() => setSort({ key: "priority", dir: "asc" })}>
                  Flag{sort.key === "priority" ? " ●" : ""}
                </th>
                <th className="px-3 py-2 w-16" />
              </tr>
            </thead>
            <tbody>{filtered.map(renderRow)}</tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm">Nothing here.</div>
          )}
        </div>
      )}

      {/* dialogs */}
      {dialog?.type === "shipped" && (
        <MarkShippedDialog rows={dialog.rows} busy={busy}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "link" && (
        <LinkSODialog row={dialog.row} busy={busy}
          onCancel={() => setDialog(null)} onSave={linkRow} />
      )}
      {dialog?.type === "notes" && (
        <NotesDialog row={dialog.row} onCancel={() => setDialog(null)}
          onSave={(text) => saveNote(dialog.row, text)} />
      )}
    </div>
  );
}

function NotesDialog({ row, onCancel, onSave }) {
  const [text, setText] = useState(row.notes || "");
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="font-semibold text-lg">Note — PO {row.vendor_po}</div>
            <div className="text-sm text-gray-500">Prints on the warehouse manifest</div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="px-5 py-4">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus
            className="w-full border rounded px-3 py-2 text-sm" />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Cancel</button>
          <button onClick={() => onSave(text.trim())}
            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black">Save</button>
        </div>
      </div>
    </div>
  );
}
