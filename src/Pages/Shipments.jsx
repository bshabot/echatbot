import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useAlert } from "../components/Alerts/AlertContext";
import { RefreshCw, Search, Truck, Link2, Upload, X, PackageCheck, Zap, Send } from "lucide-react";
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
import ShipOutDialog from "../components/Shipments/ShipOutDialog";

// ─── Shipments v3.3 (Kevin 7/6) ──────────────────────────────────────────────
// ORDERED → (quick ship) → HONG KONG (grouped by ship date; forwarder batches)
// → (ship from HK dialog: new date + tracking) → IN TRANSIT (grouped by SO,
// whole order visible, "2 of 3 shipped") → (SHIP OUT: invoices + manifest
// PDF/Excel + Titan pickup doc) → CLOSED.
// One clean row format everywhere: merged ship→cancel dates, notes as text.
// Flags/issues live ONLY in Needs attention.

// one flag only: NEED TO SHIP
const FLAG_ORDER = { [FLAGS.NEED_TO_SHIP]: 0, [FLAGS.ON_TRACK]: 1 };
const FLAG_STYLE = {
  [FLAGS.NEED_TO_SHIP]: "bg-red-100 text-red-700 border-red-300",
  [FLAGS.ON_TRACK]: "bg-green-50 text-green-700 border-green-200",
};
const FLAG_LABEL = {
  [FLAGS.NEED_TO_SHIP]: "Need to ship",
  [FLAGS.ON_TRACK]: "On track",
};

const TABS = [
  { key: "ordered", label: "Ordered" },
  { key: "hong_kong", label: "Hong Kong" },
  { key: "in_transit", label: "In transit" },
  { key: "attention", label: "Needs attention" },
  { key: "closed", label: "Closed" },
];

const fmtDate = (d) => {
  if (!d) return "—";
  const p = String(d).slice(0, 10).split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}/${p[0].slice(2)}` : d;
};
const dollar = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);

// ── Excel-like quick ship grid ──────────────────────────────────────────────
// PO → Enter → boxes → Enter → note → Enter → next row. Ctrl+Enter ships.
// Paste 2–3 columns from Excel (PO, boxes, note). Red = no match / duplicate.
function QuickShipGrid({ boardMap, busy, onShip }) {
  const empty = () => ({ po: "", boxes: "", note: "" });
  const [lines, setLines] = useState([empty()]);
  const refs = useRef({});

  const setLine = (i, field, value) =>
    setLines((ls) => {
      const next = ls.map((l, j) => (j === i ? { ...l, [field]: value } : l));
      const last = next[next.length - 1];
      if (last.po.trim() || last.boxes.trim() || last.note.trim()) next.push(empty());
      return next;
    });

  function handlePaste(i, e) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[\n\t]/.test(text) && !/\s\d/.test(text.trim())) return;
    e.preventDefault();
    const parsed = [];
    for (const rawLine of text.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.includes("\t")) {
        const cells = line.split("\t").map((c) => c.trim());
        if (cells[0]) parsed.push({ po: cells[0], boxes: cells[1] || "", note: cells.slice(2).join(" ") });
      } else {
        const toks = line.split(/[\s:,;]+/).filter(Boolean);
        for (let k = 0; k < toks.length; k += 2) {
          if (toks[k]) parsed.push({ po: toks[k], boxes: toks[k + 1] ?? "", note: "" });
        }
      }
    }
    if (!parsed.length) return;
    setLines((ls) => {
      const next = ls.slice(0, i).concat(parsed);
      next.push(empty());
      return next;
    });
  }

  const active = lines.filter((l) => l.po.trim());
  const poCounts = new Map();
  for (const l of active) {
    const k = l.po.trim().toLowerCase();
    poCounts.set(k, (poCounts.get(k) || 0) + 1);
  }
  const entries = active.map((l) => {
    const row = boardMap.get(l.po.trim().toLowerCase()) || null;
    const boxes = parseInt(l.boxes, 10);
    return {
      po: l.po.trim(),
      row,
      boxes: Number.isFinite(boxes) && boxes > 0 ? boxes : null,
      note: l.note.trim(),
    };
  });
  const hasDups = [...poCounts.values()].some((c) => c > 1);
  const allGood = entries.length > 0 && !hasDups && entries.every((e) => e.row && e.boxes);

  function ship() {
    if (!allGood || busy) return;
    onShip(entries.map((e) => ({ row: e.row, boxes: e.boxes, note: e.note })));
    setLines([empty()]);
    refs.current["p0"]?.focus();
  }

  function handleKey(i, field, e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ship();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target =
        field === "po" ? refs.current[`b${i}`] :
        field === "boxes" ? refs.current[`n${i}`] :
        refs.current[`p${i + 1}`];
      target?.focus();
    }
  }

  const cellCls = (bad) =>
    `px-2 py-1 font-mono text-sm border rounded focus:outline-none focus:border-gray-900 ${bad ? "text-red-600 border-red-400 bg-red-50" : "border-transparent hover:border-gray-200"}`;

  return (
    <div className="mb-4 border rounded-lg bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm max-md:px-3">
        <Zap size={15} className="text-amber-400" />
        <span className="font-medium">Quick ship</span>
        <span className="text-gray-400 max-md:hidden">— PO · boxes · note. Ctrl+Enter ships. Paste from Excel works.</span>
        <button onClick={ship} disabled={busy || !allGood}
          className="ml-auto px-4 py-1.5 text-sm rounded bg-amber-400 text-gray-900 font-semibold hover:bg-amber-300 disabled:opacity-40">
          {busy ? "Shipping…" : `Ship${entries.length ? ` (${entries.length})` : ""}`}
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 uppercase border-b">
            <th className="px-4 py-1.5 w-36">Vendor PO</th>
            <th className="px-2 py-1.5 w-20">Boxes</th>
            <th className="px-2 py-1.5 w-72">Note</th>
            <th className="px-2 py-1.5">Match</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const po = l.po.trim();
            const row = po ? boardMap.get(po.toLowerCase()) : null;
            const dup = po && poCounts.get(po.toLowerCase()) > 1;
            const bad = po && (!row || dup);
            const boxesBad = po && l.boxes.trim() && !(parseInt(l.boxes, 10) > 0);
            return (
              <tr key={i} className="border-b last:border-b-0">
                <td className="px-4 py-1">
                  <input
                    ref={(el) => (refs.current[`p${i}`] = el)}
                    type="text"
                    value={l.po}
                    onChange={(e) => setLine(i, "po", e.target.value)}
                    onPaste={(e) => handlePaste(i, e)}
                    onKeyDown={(e) => handleKey(i, "po", e)}
                    placeholder={i === 0 ? "12770" : ""}
                    className={`w-full ${cellCls(bad)}`}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    ref={(el) => (refs.current[`b${i}`] = el)}
                    type="text"
                    inputMode="numeric"
                    value={l.boxes}
                    onChange={(e) => setLine(i, "boxes", e.target.value)}
                    onKeyDown={(e) => handleKey(i, "boxes", e)}
                    placeholder={i === 0 ? "3" : ""}
                    className={`w-16 ${cellCls(boxesBad)}`}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    ref={(el) => (refs.current[`n${i}`] = el)}
                    type="text"
                    value={l.note}
                    onChange={(e) => setLine(i, "note", e.target.value)}
                    onKeyDown={(e) => handleKey(i, "note", e)}
                    placeholder={i === 0 ? "optional" : ""}
                    className={`w-full ${cellCls(false)}`}
                  />
                </td>
                <td className="px-2 py-1 text-xs">
                  {dup ? (
                    <span className="text-red-600 font-medium">duplicate — entered twice</span>
                  ) : bad ? (
                    <span className="text-red-600 font-medium">no matching vendor PO</span>
                  ) : row ? (
                    <span className="text-gray-500">
                      {row.vendor || "?"} · SO {row.signet_po_number || "—"}
                      {stageOf(row) !== "ordered" && <span className="ml-1 text-amber-600">(already {stageOf(row).replace("_", " ")})</span>}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Shipments() {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm, showPrompt } = useAlert();
  const fileRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [qbBusy, setQbBusy] = useState(false);
  const [tab, setTab] = useState(() => {
    // remember the tab across refreshes
    const saved = localStorage.getItem("shipments.tab");
    return TABS.some((t) => t.key === saved) ? saved : "ordered";
  });
  useEffect(() => {
    localStorage.setItem("shipments.tab", tab);
  }, [tab]);
  const [sort, setSort] = useState({ key: "cancel", dir: "asc" });
  const [search, setSearch] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  // per-column filters (In transit)
  const [colFilters, setColFilters] = useState({ po: "", so: "", boxes: "", notes: "", dates: "", vendor: "", amount: "" });

  async function load() {
    const { data, error } = await supabase
      .from(SHIPMENTS_TABLE)
      .select("*")
      .is("deleted_at", null) // tombstoned rows never reach the UI
      .order("due_date", { ascending: true })
      .limit(5000);
    if (error) {
      console.error("shipments load:", error.message);
      showAlert("Couldn't load shipments: " + error.message, { variant: "error" });
    }
    setRows(data ?? []);
    setLoading(false);
  }

  // Read-only memo check for IN-TRANSIT SOs: what does Signet's memo say is
  // on the order, and is any of it not shipped / not on our board?
  async function runSync(silent) {
    setSyncing(true);
    const res = await syncShipmentsFromPOs(supabase);
    if (res.errors.length) console.error(res.errors);
    if (res.checkedSOs > 0 || res.findings.length > 0) {
      setSyncMsg(
        `${res.checkedSOs} in-transit SO${res.checkedSOs === 1 ? "" : "s"} checked against Signet memos · ${res.findings.length} finding${res.findings.length === 1 ? "" : "s"}`
      );
    } else setSyncMsg("");
    if (!silent) {
      await showAlert(
        res.findings.length
          ? res.findings.join("\n")
          : `Checked ${res.checkedSOs} in-transit SO${res.checkedSOs === 1 ? "" : "s"} — everything in the memos is shipped or on the board.`,
        { title: "In-transit memo check", variant: res.findings.length ? "warning" : "success" }
      );
    } else if (res.findings.length) {
      console.warn("Memo check findings:", res.findings);
    }
    setSyncing(false);
  }

  useEffect(() => {
    if (!supabase) return;
    load().then(() => runSync(true)); // paint fast, sync quietly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const boardMap = useMemo(
    () => new Map(rows.map((r) => [String(r.vendor_po).toLowerCase(), r])),
    [rows]
  );

  // quick ship: entries = [{row, boxes, note}] — already validated by the grid
  async function quickShip(entries) {
    setQuickBusy(true);
    const failed = [];
    let anyHk = false;
    for (const e of entries) {
      if (e.row.route !== "direct") anyHk = true;
      const patch = {
        factory_shipped_at: today(),
        carton_count: e.boxes,
        updated_at: new Date().toISOString(),
      };
      if (e.note) patch.notes = e.row.notes ? `${e.row.notes}; ${e.note}` : e.note;
      const { error } = await supabase
        .from(SHIPMENTS_TABLE)
        .update(patch)
        .eq("id", e.row.id);
      if (error) failed.push(`${e.row.vendor_po}: ${error.message}`);
    }
    setQuickBusy(false);
    if (failed.length) await showAlert(failed.join("\n"), { title: "Quick ship", variant: "error" });
    await load();
    setTab(anyHk ? "hong_kong" : "in_transit"); // show them where they went
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

  // ── SHIP OUT (In transit → CLOSED): invoices + boxes + docs ──
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
          .from(SHIPMENTS_TABLE)
          .update({ status: "closed", updated_at: new Date().toISOString() })
          .eq("id", id);
        if (e4) throw new Error("close: " + e4.message);
      }
    } catch (err) {
      showAlert("Ship-out failed: " + err.message, { variant: "error" });
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
        .from(SHIPMENTS_TABLE)
        .update({ status: "open", updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) console.error("reopen failed", r.vendor_po, error.message);
    }
    setBusy(false);
    setSelected(new Set());
    await load();
  }

  // PERMANENT delete: tombstone the row (deleted_at). It disappears from every
  // view, and the QB import + Signet reconcile skip it forever — re-importing
  // the QB file can NOT bring it back.
  async function deleteSelected() {
    const targets = selectedRows;
    if (!targets.length) return;
    const ok = await showConfirm(
      `Delete ${targets.length} PO${targets.length === 1 ? "" : "s"} (${targets.slice(0, 5).map((r) => r.vendor_po).join(", ")}${targets.length > 5 ? "…" : ""})? This is permanent — they will NOT come back when the QB file is re-imported.`,
      { title: "Delete shipments", confirmText: "Delete forever", variant: "error" }
    );
    if (!ok) return;
    setBusy(true);
    for (const r of targets) {
      const { error } = await supabase
        .from(SHIPMENTS_TABLE)
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) console.error("delete failed", r.vendor_po, error.message);
    }
    setBusy(false);
    setSelected(new Set());
    await load();
  }

  const enriched = useMemo(
    () => rows.map((r) => ({ ...r, _flag: computeFlag(r), _stage: stageOf(r) })),
    [rows]
  );

  // Needs attention = exactly two things: a PO with no SO (QB memo had no
  // "Sales Order ####" — type it in), or NEED TO SHIP (cancel date closing in).
  const isAttention = (r) =>
    r.status === "open" && (!r.signet_po_number || r._flag === FLAGS.NEED_TO_SHIP);

  const counts = useMemo(() => {
    const c = { ordered: 0, hong_kong: 0, in_transit: 0, attention: 0 };
    for (const r of enriched) {
      if (r.status !== "open") continue;
      if (c[r._stage] != null) c[r._stage]++;
      if (isAttention(r)) c.attention++;
    }
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (tab === "closed") list = list.filter((r) => r.status === "closed");
    else if (tab === "attention") list = list.filter(isAttention);
    else if (tab === "in_transit") {
      // whole sales order: any SO with a PO in transit brings ALL its POs
      const soSet = new Set(
        enriched
          .filter((r) => r.status === "open" && r._stage === "in_transit" && r.signet_po_number)
          .map((r) => String(r.signet_po_number))
      );
      list = list.filter(
        (r) =>
          r.status === "open" &&
          ((r.signet_po_number && soSet.has(String(r.signet_po_number))) ||
            (!r.signet_po_number && r._stage === "in_transit"))
      );
    } else list = list.filter((r) => r.status === "open" && r._stage === tab);
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (r) =>
          String(r.vendor_po).toLowerCase().includes(q) ||
          String(r.signet_po_number || "").toLowerCase().includes(q) ||
          String(r.vendor || "").toLowerCase().includes(q) ||
          String(r.notes || "").toLowerCase().includes(q)
      );
    // per-column filters (In transit)
    if (tab === "in_transit") {
      const f = colFilters;
      const has = (v, needle) => String(v ?? "").toLowerCase().includes(needle.trim().toLowerCase());
      if (Object.values(f).some((v) => v.trim())) {
        list = list.filter(
          (r) =>
            (!f.po.trim() || has(r.vendor_po, f.po)) &&
            (!f.so.trim() || has(r.signet_po_number, f.so)) &&
            (!f.boxes.trim() || has(r.carton_count, f.boxes)) &&
            (!f.notes.trim() || has(r.notes, f.notes)) &&
            (!f.dates.trim() || has(`${fmtDate(shipDateOf(r))} → ${fmtDate(dueDateOf(r))}`, f.dates)) &&
            (!f.vendor.trim() || has(r.vendor, f.vendor)) &&
            (!f.amount.trim() || has(amountOf(r), f.amount))
        );
      }
    }
    const sortVal = (r) => {
      switch (sort.key) {
        case "po": { const n = parseInt(r.vendor_po, 10); return Number.isFinite(n) ? n : null; }
        case "vendor": return r.vendor || null;
        case "so": { const n = parseInt(r.signet_po_number, 10); return Number.isFinite(n) ? n : null; }
        case "boxes": return r.carton_count ?? null;
        case "notes": return r.notes || null;
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
  }, [enriched, tab, search, sort, colFilters]);

  // Hong Kong: forwarder batches — one card per factory-ship date
  const hkGroups = useMemo(() => {
    if (tab !== "hong_kong") return [];
    const byDate = new Map();
    for (const r of filtered) {
      const key = String(shippedDateOf(r) || "No date").slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(r);
    }
    // pos keep `filtered` order → column-header sorting works inside each card
    const groups = [...byDate.entries()].map(([date, pos]) => ({
      date,
      pos,
      total: pos.reduce((s, p) => s + (Number(amountOf(p)) || 0), 0),
      boxes: pos.reduce((s, p) => s + (p.carton_count || 0), 0),
    }));
    return groups.sort((a, b) => String(a.date).localeCompare(String(b.date))); // oldest first
  }, [filtered, tab]);

  // In transit: grouped by SO, whole order visible
  const soGroups = useMemo(() => {
    if (tab !== "in_transit") return [];
    const bySO = new Map();
    for (const r of filtered) {
      const key = r.signet_po_number || "No SO";
      if (!bySO.has(key)) bySO.set(key, []);
      bySO.get(key).push(r);
    }
    const groups = [...bySO.entries()].map(([so, pos]) => ({
      so,
      pos, // filtered order → rows inside a group follow the column sort
      ship: pos.map(shipDateOf).filter(Boolean).sort()[0] || null,
      cancel: pos.map(dueDateOf).filter(Boolean).sort()[0] || null,
      total: pos.reduce((s, p) => s + (Number(amountOf(p)) || 0), 0),
      boxes: pos.reduce((s, p) => s + (p.carton_count || 0), 0),
      shipped: pos.filter((p) => p._stage !== "ordered").length,
    }));
    // column-header sorting re-orders the GROUPS (rows stay with their SO)
    const groupVal = (g) => {
      switch (sort.key) {
        case "po": { const ns = g.pos.map((p) => parseInt(p.vendor_po, 10)).filter(Number.isFinite); return ns.length ? Math.min(...ns) : null; }
        case "so": { const n = parseInt(g.so, 10); return Number.isFinite(n) ? n : null; }
        case "boxes": return g.boxes;
        case "vendor": return g.pos.map((p) => p.vendor || "").sort()[0] || null;
        case "amount": return g.total;
        case "notes": return g.pos.map((p) => p.notes || "").filter(Boolean).sort()[0] || null;
        case "cancel": default: return g.cancel || g.ship || null;
      }
    };
    return groups.sort((a, b) => {
      const av = groupVal(a);
      const bv = groupVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? c : -c;
    });
  }, [filtered, tab, sort]);

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

  const showFlags = tab === "attention"; // flags/issues live here only
  const isOrdered = tab === "ordered";
  const showStatus = !isOrdered && tab !== "in_transit"; // in transit: the view IS the status
  const showBoxesNotes = tab !== "ordered" && tab !== "attention"; // shipping-side columns only

  // ── ONE row format everywhere ──
  // checkbox · PO · vendor · SO · ship→cancel · $ · boxes · status (not in
  // Ordered) · notes as visible text (click to edit) · flag/link (attention)
  // opts.soContent overrides the SO cell (group views show SO once per group);
  // opts.groupStart draws a heavier divider so an SO's rows sit together.
  function renderRow(r, opts = {}) {
    const dd = daysUntil(dueDateOf(r));
    return (
      <tr key={r.id}
        className={`${opts.groupStart ? "border-t-2 border-gray-300" : "border-t"} hover:bg-gray-50 ${selected.has(r.id) ? "bg-blue-50/40" : ""}`}>
        <td className="px-3 py-2">
          <input type="checkbox" className="max-md:w-5 max-md:h-5" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
        </td>
        <td className="px-3 py-2 font-medium">{r.vendor_po}</td>
        <td className="px-3 py-2">
          {opts.soContent !== undefined ? (
            opts.soContent
          ) : r.signet_po_number ? (
            r.signet_po_number
          ) : r.memo_note ? (
            <span className="inline-block max-w-[12rem] truncate align-bottom text-xs italic text-gray-500" title={r.memo_note}>
              {r.memo_note}
            </span>
          ) : (
            "—"
          )}
        </td>
        {showBoxesNotes && (
          <td className="px-3 py-2 text-center font-medium">
            {r.carton_count ?? <span className="text-gray-300">—</span>}
          </td>
        )}
        {showBoxesNotes && (
          <td
            className="px-3 py-2 text-xs text-gray-600 italic max-w-[16rem] truncate cursor-pointer hover:text-gray-900"
            title={r.notes ? `${r.notes} — click to edit` : "Click to add a note"}
            onClick={() => setDialog({ type: "notes", row: r })}>
            {r.notes || <span className="text-gray-300 not-italic">—</span>}
          </td>
        )}
        <td className="px-3 py-2 whitespace-nowrap">
          {fmtDate(shipDateOf(r))} <span className="text-gray-400">→</span> {fmtDate(dueDateOf(r))}
          {!r.ship_date && r.qb_ship_date && <span className="ml-1 text-[10px] text-gray-400">QB</span>}
          {showFlags && r.status === "open" && dd != null && dd <= 7 && (
            <span className={`ml-1 text-xs ${dd < 0 ? "text-red-600 font-semibold" : "text-orange-600"}`}>
              {dd < 0 ? `${-dd}d over` : `${dd}d`}
            </span>
          )}
        </td>
        <td className="px-3 py-2">{r.vendor || "—"}</td>
        <td className="px-3 py-2 text-right">{dollar(amountOf(r))}</td>
        {showStatus && (
          <td className="px-3 py-2 text-xs whitespace-nowrap">
            {r.status === "closed" ? (
              <span className="px-2 py-0.5 rounded bg-gray-200 text-gray-500">CLOSED</span>
            ) : r._stage === "in_transit" ? (
              <span className="text-green-700">
                {r.route === "direct" ? "shipped" : "left HK"} {fmtDate(r.route === "direct" ? shippedDateOf(r) : r.hk_departed_at)}
                {r.leg1_tracking ? ` · ${r.leg1_tracking}` : ""}
              </span>
            ) : r._stage === "hong_kong" ? (
              <span className="text-blue-700">at HK · shipped {fmtDate(shippedDateOf(r))}</span>
            ) : (
              <span className="text-gray-400">not shipped</span>
            )}
          </td>
        )}
        {showFlags && (
          <td className="px-3 py-2">
            {r.status === "open" && r._flag && r._flag !== FLAGS.ON_TRACK && (
              <span className={`px-2 py-0.5 rounded border text-xs font-medium ${FLAG_STYLE[r._flag]}`}>
                {FLAG_LABEL[r._flag]}
              </span>
            )}
          </td>
        )}
        {showFlags && (
          <td className="px-3 py-2">
            {!r.signet_po_number && (
              <button onClick={() => promptSO(r)} title="Type the sales order # for this PO"
                className="text-blue-500 hover:text-blue-700">
                <Link2 size={15} />
              </button>
            )}
          </td>
        )}
      </tr>
    );
  }

  // one header everywhere, every column sortable:
  // PO · SO · Boxes · Notes · Ship→Cancel · Vendor · $ · Status (HK/attention/closed)
  const tableHead = (slim, selectable = !slim) => {
    const th = (key, label, extra = "") => (
      <th className={`px-3 py-2 cursor-pointer ${extra}`} onClick={() => clickSort(key)}>
        {label}{sortArrow(key)}
      </th>
    );
    return (
      <thead>
        <tr className={`text-left text-xs uppercase select-none ${slim ? "text-gray-400" : "text-gray-500 bg-gray-50"}`}>
          <th className="px-3 py-2 w-8">
            {selectable && (
              <input type="checkbox" className="max-md:w-5 max-md:h-5"
                checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                onChange={toggleAll} />
            )}
          </th>
          {th("po", "Vendor PO")}
          {th("so", "SO")}
          {showBoxesNotes && th("boxes", "Boxes", "text-center")}
          {showBoxesNotes && th("notes", "Notes")}
          {th("cancel", "Ship → Cancel")}
          {th("vendor", "Vendor")}
          {th("amount", "$", "text-right")}
          {showStatus && th("status", "Status")}
          {showFlags && (
            <th className="px-3 py-2 cursor-pointer" onClick={() => setSort({ key: "priority", dir: "asc" })}>
              Flag{sort.key === "priority" ? " ●" : ""}
            </th>
          )}
          {showFlags && <th className="px-3 py-2 w-10" />}
        </tr>
      </thead>
    );
  };

  return (
    <div className="p-6 max-md:p-2">
      {/* header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2 max-md:text-xl">
            <Truck size={24} /> Shipments
          </h1>
          {syncMsg && <div className="text-xs text-gray-500 mt-0.5">{syncMsg}</div>}
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onQbFile} />
          <button onClick={() => fileRef.current?.click()} disabled={qbBusy || syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50 max-md:whitespace-nowrap">
            <Upload size={15} /> {qbBusy ? "Importing…" : "Import QB file"}
          </button>
          <button onClick={() => runSync(false)} disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border hover:bg-gray-50 disabled:opacity-50 max-md:whitespace-nowrap">
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} /> Check in-transit memos
          </button>
        </div>
      </div>

      {/* quick ship grid */}
      <QuickShipGrid boardMap={boardMap} busy={quickBusy} onShip={quickShip} />

      {/* tabs + search */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div className="flex gap-1 max-md:flex-wrap">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); setSelected(new Set()); }}
              className={`px-3 py-1.5 text-sm rounded-full max-md:py-2 ${tab === t.key ? "bg-gray-900 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}>
              {t.label}
              {counts[t.key] > 0 && (
                <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${t.key === "attention" ? "bg-red-500 text-white" : tab === t.key ? "bg-white/20 text-white" : "bg-gray-300 text-gray-700"}`}>
                  {counts[t.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative max-md:w-full">
          <Search size={15} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter — PO, SO, vendor, note…"
            enterKeyHint="search"
            className="pl-8 pr-3 py-2 text-sm border rounded w-64 max-md:w-full" />
        </div>
      </div>

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded max-md:flex-wrap max-md:gap-2 max-md:px-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          {openSelected.some((r) => r._stage === "ordered") && (
            <button onClick={() => setDialog({ type: "shipped", rows: openSelected.filter((r) => r._stage === "ordered") })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-gray-900 text-white hover:bg-black">
              <Truck size={14} /> Mark shipped
            </button>
          )}
          {openSelected.some((r) => r._stage === "hong_kong") && (
            <button
              onClick={() => setDialog({ type: "shipped", mode: "depart", rows: openSelected.filter((r) => r._stage === "hong_kong") })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-green-700 text-white hover:bg-green-800">
              <PackageCheck size={14} /> Ship from HK → In transit
            </button>
          )}
          {openSelected.some((r) => r._stage === "in_transit") && (
            <button
              onClick={() => setDialog({ type: "shipout", rows: openSelected.filter((r) => r._stage === "in_transit") })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-blue-700 text-white hover:bg-blue-800">
              <Send size={14} /> Ship out → invoices + manifest
            </button>
          )}
          {selectedRows.some((r) => r.status === "closed") && (
            <button onClick={reopenSelected} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-amber-500 text-white hover:bg-amber-600">
              Reopen
            </button>
          )}
          <button onClick={deleteSelected} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50">
            Delete
          </button>
          <button onClick={() => setSelected(new Set())}
            className="flex items-center gap-1 px-2 py-1.5 text-sm text-gray-500 hover:text-gray-800 ml-auto">
            <X size={14} /> Clear
          </button>
        </div>
      )}

      {/* content */}
      {loading ? (
        <div className="text-gray-400 py-16 text-center">Loading…</div>
      ) : tab === "hong_kong" ? (
        // same table as Ordered — one date batch per section: a slim header row
        // ("Shipped 7/6 · 3 POs · 8 boxes") with its Ship-from-HK button, then
        // the batch's rows
        <div className="border rounded-lg overflow-x-auto bg-white">
          <table className="w-full text-sm">
            {tableHead(true, true)}
            <tbody>
              {hkGroups.map((g) => {
                const selInGroup = g.pos.filter((p) => selected.has(p.id) && p._stage === "hong_kong");
                const shipTarget = selInGroup.length ? selInGroup : g.pos.filter((p) => p._stage === "hong_kong");
                return (
                  <React.Fragment key={g.date}>
                    <tr className="border-t-2 border-gray-300 bg-gray-50">
                      <td colSpan={10} className="px-3 py-1.5">
                        <div className="flex items-center gap-3 text-xs">
                          <span className="font-semibold">
                            Shipped {g.date === "No date" ? "—" : fmtDate(g.date)}
                          </span>
                          <span className="text-gray-600">
                            {g.pos.length} PO{g.pos.length === 1 ? "" : "s"}{g.boxes ? ` · ${g.boxes} boxes` : ""}
                          </span>
                          <span className="text-gray-500">{dollar(g.total)}</span>
                          <button
                            onClick={() => setDialog({ type: "shipped", mode: "depart", rows: shipTarget })}
                            disabled={busy || shipTarget.length === 0}
                            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded bg-green-700 text-white hover:bg-green-800 disabled:opacity-50 max-md:py-2">
                            <PackageCheck size={13} />
                            Ship from HK{selInGroup.length ? ` (${selInGroup.length} selected)` : ` (all ${shipTarget.length})`}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {g.pos.map((p) => renderRow(p))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {hkGroups.length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm">Nothing here.</div>
          )}
        </div>
      ) : tab === "in_transit" ? (
        // same table as Ordered — rows just sit grouped: an SO's POs are
        // adjacent, the SO shown once with its rollup, heavier line between SOs
        <div className="border rounded-lg overflow-x-auto bg-white">
          <table className="w-full text-sm">
            {tableHead(true, true)}
            <tbody>
              {/* per-column filters */}
              <tr className="bg-gray-50/70 border-b">
                <td className="px-3 py-1" />
                {[
                  ["po", "filter…"],
                  ["so", "filter…"],
                  ["boxes", "#"],
                  ["notes", "filter…"],
                  ["dates", "e.g. 7/6"],
                  ["vendor", "filter…"],
                  ["amount", "$"],
                ].map(([key, ph]) => (
                  <td key={key} className="px-2 py-1">
                    <input
                      type="text"
                      value={colFilters[key]}
                      onChange={(e) => setColFilters((f) => ({ ...f, [key]: e.target.value }))}
                      placeholder={ph}
                      className={`w-full px-2 py-1 text-xs border rounded focus:outline-none focus:border-gray-900 ${colFilters[key].trim() ? "border-blue-400 bg-blue-50" : "border-gray-200"}`}
                    />
                  </td>
                ))}
              </tr>
              {soGroups.map((g) => {
                // only the moving POs take real rows; laggards collapse into
                // one compact line under the group
                const moving = g.pos.filter((p) => p._stage === "in_transit");
                const laggards = g.pos.filter((p) => p._stage !== "in_transit");
                return (
                  <React.Fragment key={g.so}>
                    {moving.map((p, idx) =>
                      renderRow(p, {
                        groupStart: idx === 0,
                        soContent:
                          idx === 0 ? (
                            <div>
                              <div className="font-medium">{g.so}</div>
                              <div className={`text-[11px] ${laggards.length === 0 ? "text-green-700" : "text-amber-700"}`}>
                                {moving.length}/{g.pos.length} in transit{g.boxes ? ` · ${g.boxes} bx` : ""}
                              </div>
                            </div>
                          ) : (
                            ""
                          ),
                      })
                    )}
                    {laggards.length > 0 && (
                      <tr className="bg-amber-50/60">
                        <td />
                        <td colSpan={9} className="px-3 py-1.5 text-xs text-amber-800">
                          {laggards
                            .map(
                              (p) =>
                                `${p.vendor_po} ${p.vendor || "?"} — ${p._stage === "hong_kong" ? "at Hong Kong" : "needs to be shipped"}`
                            )
                            .join("  ·  ")}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {soGroups.length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm">Nothing here.</div>
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
        <MarkShippedDialog rows={dialog.rows} busy={busy} mode={dialog.mode || "ship"}
          onCancel={() => setDialog(null)} onSave={applyPatches} />
      )}
      {dialog?.type === "shipout" && (
        <ShipOutDialog rows={dialog.rows} busy={busy}
          onCancel={() => setDialog(null)} onConfirm={shipOut} />
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
