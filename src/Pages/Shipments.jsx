import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useAlert } from "../components/Alerts/AlertContext";
import { RefreshCw, Search, Truck, Link2, StickyNote, Upload, X, PackageCheck, Zap } from "lucide-react";
import {
  SHIPMENTS_TABLE,
  syncShipmentsFromPOs,
  parseQuickShip,
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

// ─── Shipments v3.1 (Kevin 7/6) — fewer clicks, SO-combined views ───────────
// The flow: Ordered → (quick ship: "12770:3 12771:2") → IN TRANSIT →
// (Arrived) → TO SHIP → (ship-out, next iteration) → CLOSED.
// QB file is the source of truth for rows; Signet PO sync is reconcile-only.

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
  { key: "ordered", label: "Ordered" },
  { key: "in_transit", label: "In transit" },
  { key: "to_ship", label: "To ship" },
  { key: "attention", label: "Needs attention" },
  { key: "closed", label: "Closed" },
];
const GROUPED_TABS = new Set(["in_transit", "to_ship"]); // combined by SO

const fmtDate = (d) => {
  if (!d) return "—";
  const p = String(d).slice(0, 10).split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}/${p[0].slice(2)}` : d;
};
const dollar = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);

export default function Shipments() {
  const { supabase } = useSupabase();
  const { showAlert, showPrompt } = useAlert();
  const fileRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [qbBusy, setQbBusy] = useState(false);
  const [tab, setTab] = useState("ordered");
  const [sort, setSort] = useState({ key: "priority", dir: "asc" });
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
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
    if (!silent || res.updated > 0 || res.flagged > 0 || res.errors.length > 0) {
      const bits = [`${res.scanned} Signet POs`, `${res.updated} reconciled`];
      if (res.flagged) bits.push(`${res.flagged} flagged ⚠`);
      if (res.orphanPos.length) {
        bits.push(`${res.orphanPos.length} Signet PO${res.orphanPos.length === 1 ? "" : "s"} not in QB`);
        console.warn("Signet POs with no board row:", res.orphanPos.join(", "));
      }
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

  // ── QUICK SHIP: "12770:3 12771:2" → in transit, no dialog ──
  async function quickShip() {
    const { entries, bad } = parseQuickShip(quick);
    if (entries.length === 0) {
      showAlert('Type vendor PO and boxes like:  12770:3 12771:2 12772:4', { title: "Quick ship" });
      return;
    }
    setQuickBusy(true);
    const byPo = new Map(rows.map((r) => [String(r.vendor_po).toLowerCase(), r]));
    const shipped = [];
    const unknown = [];
    const failed = [];
    for (const e of entries) {
      const row = byPo.get(String(e.vendorPo).toLowerCase());
      if (!row) { unknown.push(e.vendorPo); continue; }
      const { error } = await supabase
        .from(SHIPMENTS_TABLE)
        .update({
          factory_shipped_at: today(),
          carton_count: e.boxes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (error) failed.push(`${e.vendorPo}: ${error.message}`);
      else shipped.push(`${e.vendorPo} (${e.boxes} bx)`);
    }
    setQuickBusy(false);
    const lines = [];
    if (shipped.length) lines.push(`✓ In transit: ${shipped.join(", ")}`);
    if (unknown.length) lines.push(`Not on the board: ${unknown.join(", ")}`);
    if (bad.length) lines.push(`Couldn't read: ${bad.join(", ")} — use PO:boxes`);
    if (failed.length) lines.push(...failed);
    if (unknown.length || bad.length || failed.length) {
      await showAlert(lines.join("\n"), { title: "Quick ship", variant: shipped.length ? "warning" : "error" });
    }
    setQuick("");
    await load();
    if (shipped.length) setTab("in_transit"); // show them where they went
  }

  // ── group → next stage ──
  async function markArrived(pos) {
    setBusy(true);
    for (const r of pos.filter((p) => stageOf(p) === "in_transit")) {
      const { error } = await supabase
        .from(SHIPMENTS_TABLE)
        .update({ received_confirmed_at: today(), updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) console.error("arrived failed", r.vendor_po, error.message);
    }
    setBusy(false);
    await load();
  }

  async function onQbFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setQbBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await importQbPos(supabase, buf);
      const lines = [`${res.parsed} POs in file · ${res.updated} updated · ${res.inserted} added`];
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

  const counts = useMemo(() => {
    const c = { ordered: 0, in_transit: 0, to_ship: 0, attention: 0 };
    for (const r of enriched) {
      if (r.status !== "open") continue;
      if (r._stage === "ordered") c.ordered++;
      else if (r._stage === "in_transit") c.in_transit++;
      else if (r._stage === "to_ship") c.to_ship++;
      if (
        r.link_source === "needs_link" ||
        !r.signet_po_number ||
        String(r.memo_note || "").includes("⚠") ||
        (r._flag && r._flag !== FLAGS.ON_TRACK)
      )
        c.attention++;
    }
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (tab === "closed") list = list.filter((r) => r.status === "closed");
    else if (tab === "attention")
      list = list.filter(
        (r) =>
          r.status === "open" &&
          (r.link_source === "needs_link" ||
            !r.signet_po_number ||
            String(r.memo_note || "").includes("⚠") ||
            (r._flag && r._flag !== FLAGS.ON_TRACK))
      );
    else list = list.filter((r) => r.status === "open" && r._stage === tab);
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
      if (aNull) return 1;
      if (bNull) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? c : -c;
    });
  }, [enriched, tab, search, sort]);

  // ── combined by SO (In transit / To ship) ──
  const soGroups = useMemo(() => {
    if (!GROUPED_TABS.has(tab)) return [];
    const bySO = new Map();
    for (const r of filtered) {
      const key = r.signet_po_number || "No SO";
      if (!bySO.has(key)) bySO.set(key, []);
      bySO.get(key).push(r);
    }
    const groups = [...bySO.entries()].map(([so, pos]) => ({
      so,
      pos,
      ship: pos.map(shipDateOf).filter(Boolean).sort()[0] || null,
      cancel: pos.map(dueDateOf).filter(Boolean).sort()[0] || null,
      total: pos.reduce((s, p) => s + (Number(amountOf(p)) || 0), 0),
      boxes: pos.reduce((s, p) => s + (p.carton_count || 0), 0),
    }));
    return groups.sort((a, b) => String(a.ship || "9999").localeCompare(String(b.ship || "9999")));
  }, [filtered, tab]);

  function clickSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  const sortArrow = (key) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  const selectedRows = useMemo(() => enriched.filter((r) => selected.has(r.id)), [enriched, selected]);
  const openSelected = selectedRows.filter((r) => r.status === "open");

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

  async function promptSO(row) {
    const so = await showPrompt(`Sales order # for vendor PO ${row.vendor_po} (${row.vendor || "?"}):`, {
      title: "Link to sales order",
      placeholder: "164138",
    });
    if (so == null) return;
    const clean = String(so).trim();
    if (!/^\d{4,6}$/.test(clean)) {
      showAlert("That doesn't look like a Signet PO number (4–6 digits).", { variant: "warning" });
      return;
    }
    const { error } = await supabase
      .from(SHIPMENTS_TABLE)
      .update({ signet_po_number: clean, link_source: "manual", updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) showAlert("Link failed: " + error.message, { variant: "error" });
    await load();
    runSync(true); // pull Signet dates for the newly linked SO
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

  function renderRow(r) {
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
          ) : r._stage === "to_ship" ? (
            <span className="text-green-700">
              arrived {fmtDate(r.received_confirmed_at)}
              {r.carton_count ? ` · ${r.carton_count} bx` : ""}
            </span>
          ) : r._stage === "in_transit" ? (
            <span className="text-blue-700">
              shipped {fmtDate(shippedDateOf(r))}
              {r.carton_count ? ` · ${r.carton_count} bx` : ""}
              {r.leg1_tracking ? ` · ${r.leg1_tracking}` : ""}
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
            {(needsLink || !r.signet_po_number) && (
              <button
                onClick={() => (!r.signet_po_number ? promptSO(r) : setDialog({ type: "link", row: r }))}
                title={!r.signet_po_number ? "Link to sales order" : "Link PO ↔ SO"}
                className="text-blue-500 hover:text-blue-700">
                <Link2 size={15} />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  const tableHead = (slim) => (
    <thead>
      <tr className={`text-left text-xs uppercase select-none ${slim ? "text-gray-400" : "text-gray-500 bg-gray-50"}`}>
        <th className="px-3 py-2 w-8">
          {!slim && (
            <input type="checkbox"
              checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
              onChange={toggleAll} />
          )}
        </th>
        {slim ? (
          <>
            <th className="px-3 py-2">Vendor PO</th>
            <th className="px-3 py-2">Vendor</th>
            <th className="px-3 py-2">SO</th>
            <th className="px-3 py-2">Ship by</th>
            <th className="px-3 py-2">Cancel</th>
            <th className="px-3 py-2 text-right">$</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Flag</th>
            <th className="px-3 py-2 w-16" />
          </>
        ) : (
          <>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("po")}>Vendor PO{sortArrow("po")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("vendor")}>Vendor{sortArrow("vendor")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("so")}>SO{sortArrow("so")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("ship")}>Ship by{sortArrow("ship")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("cancel")}>Cancel{sortArrow("cancel")}</th>
            <th className="px-3 py-2 cursor-pointer text-right" onClick={() => clickSort("amount")}>${sortArrow("amount")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => clickSort("status")}>Status{sortArrow("status")}</th>
            <th className="px-3 py-2 cursor-pointer" onClick={() => setSort({ key: "priority", dir: "asc" })}>
              Flag{sort.key === "priority" ? " ●" : ""}
            </th>
            <th className="px-3 py-2 w-16" />
          </>
        )}
      </tr>
    </thead>
  );

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
          <button onClick={() => fileRef.current?.click()} disabled={qbBusy || syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <Upload size={15} /> {qbBusy ? "Importing…" : "Import QB file"}
          </button>
          <button onClick={() => runSync(false)} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} /> Reconcile Signet POs
          </button>
        </div>
      </div>

      {/* QUICK SHIP — the no-clicks path */}
      <div className="flex items-center gap-2 mb-4 px-4 py-3 bg-gray-900 rounded-lg">
        <Zap size={16} className="text-amber-400 shrink-0" />
        <input
          type="text"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !quickBusy && quickShip()}
          placeholder="Quick ship — PO then boxes, e.g.  12770 3 12771 2 12772 4  then Enter"
          className="flex-1 bg-gray-800 text-white placeholder-gray-500 border border-gray-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-400"
        />
        <button onClick={quickShip} disabled={quickBusy || !quick.trim()}
          className="px-4 py-2 text-sm rounded bg-amber-400 text-gray-900 font-semibold hover:bg-amber-300 disabled:opacity-50">
          {quickBusy ? "Shipping…" : "Ship"}
        </button>
      </div>

      {/* tabs + search */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); setSelected(new Set()); }}
              className={`px-3 py-1.5 text-sm rounded-full ${tab === t.key ? "bg-gray-900 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
              {t.label}
              {counts[t.key] > 0 && (
                <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${t.key === "attention" ? "bg-red-500 text-white" : tab === t.key ? "bg-white/20 text-white" : "bg-gray-300 text-gray-700"}`}>
                  {counts[t.key]}
                </span>
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
          <span className="text-sm font-medium">{selected.size} selected</span>
          {openSelected.some((r) => r._stage === "ordered") && (
            <button onClick={() => setDialog({ type: "shipped", rows: openSelected.filter((r) => r._stage === "ordered") })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-gray-900 text-white hover:bg-black">
              <Truck size={14} /> Mark shipped
            </button>
          )}
          {openSelected.some((r) => r._stage === "in_transit") && (
            <button onClick={() => markArrived(openSelected)} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-green-700 text-white hover:bg-green-800">
              <PackageCheck size={14} /> Arrived → To ship
            </button>
          )}
          <button onClick={() => setSelected(new Set())}
            className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-500 hover:text-gray-800 ml-auto">
            <X size={14} /> Clear
          </button>
        </div>
      )}

      {/* content */}
      {loading ? (
        <div className="text-gray-400 py-16 text-center">Loading…</div>
      ) : GROUPED_TABS.has(tab) ? (
        <div className="space-y-4">
          {soGroups.map((g) => (
            <div key={g.so} className="border rounded-lg bg-white overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b flex-wrap">
                <span className="font-semibold">SO {g.so}</span>
                <span className="text-sm text-gray-500">
                  ship {fmtDate(g.ship)} · cancel {fmtDate(g.cancel)}
                </span>
                <span className="text-sm text-gray-600">
                  {g.pos.length} PO{g.pos.length === 1 ? "" : "s"}{g.boxes ? ` · ${g.boxes} boxes` : ""}
                </span>
                <span className="text-sm text-gray-500">{dollar(g.total)}</span>
                {tab === "in_transit" && (
                  <button onClick={() => markArrived(g.pos)} disabled={busy}
                    className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-green-700 text-white hover:bg-green-800">
                    <PackageCheck size={14} /> Arrived → To ship
                  </button>
                )}
              </div>
              <table className="w-full text-sm">
                {tableHead(true)}
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
            {tableHead(false)}
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
