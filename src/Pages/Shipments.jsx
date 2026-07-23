import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useAlert } from "../components/Alerts/AlertContext";
import { RefreshCw, Search, Truck, Link2, Upload, X, PackageCheck, Zap, Send, Hash, Pencil } from "lucide-react";
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
import {
  downloadManifestPdf,
  downloadManifestExcel,
  downloadPickupRequestPdf,
} from "../utils/shipmentDocs";
import {
  folderApiSupported,
  pickDocFolder,
  clearDocFolder,
  getDocFolderName,
} from "../utils/docFolder";

// ─── Shipments v3.3 (Kevin 7/6) ──────────────────────────────────────────────
// ORDERED → (quick ship) → HONG KONG (grouped by ship date; forwarder batches)
// → (ship from HK dialog: new date + tracking) → IN TRANSIT (grouped by SO,
// whole order visible, "2 of 3 shipped") → (SHIP OUT: invoices + manifest
// PDF/Excel + Titan pickup doc) → CLOSED.
// One clean row format everywhere: merged ship→cancel dates, notes as text.
// Flags/issues live ONLY in Needs attention.

// NEED TO SHIP = red (not moving, cancel ≤ 21d)
// AT RISK = amber (moving, but cancel ≤ 10d while in HK / ≤ 5d in transit)
const FLAG_ORDER = { [FLAGS.NEED_TO_SHIP]: 0, [FLAGS.AT_RISK]: 1, [FLAGS.ON_TRACK]: 2 };
const FLAG_STYLE = {
  [FLAGS.NEED_TO_SHIP]: "bg-red-100 text-red-700 border-red-300",
  [FLAGS.AT_RISK]: "bg-amber-100 text-amber-700 border-amber-300",
  [FLAGS.ON_TRACK]: "bg-green-50 text-green-700 border-green-200",
};
const FLAG_LABEL = {
  [FLAGS.NEED_TO_SHIP]: "Need to ship",
  [FLAGS.AT_RISK]: "Due soon",
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

// Carrier tracking link from the number's shape: 1Z→UPS, 10 digits→DHL,
// 12/15/20-22 digits→FedEx. Anything else (incl. SF Express) → 17track,
// which handles every carrier.
function trackingUrl(num) {
  const t = String(num || "").trim().replace(/\s+/g, "");
  if (!t) return null;
  if (/^1Z/i.test(t)) return `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`;
  if (/^\d{10}$/.test(t)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(t)}&submit=1`;
  if (/^\d{12}$|^\d{15}$|^\d{20,22}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`;
  return `https://t.17track.net/en#nums=${encodeURIComponent(t)}`;
}

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
  const [whOnly, setWhOnly] = useState(false); // In transit sub-view: only what's in the warehouse
  const [transitGroupBy, setTransitGroupBy] = useState("shipment"); // shipment (default) | so
  const [quickBusy, setQuickBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  // per-column filters (In transit)
  const [colFilters, setColFilters] = useState({ po: "", so: "", boxes: "", notes: "", tracking: "", invoice: "", out_tracking: "", dates: "", vendor: "", amount: "" });

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
    if (res.datesFixed > 0) await load(); // Signet moved a window — repaint
    if (res.checkedSOs > 0 || res.findings.length > 0 || res.datesFixed > 0) {
      setSyncMsg(
        `${res.checkedSOs} in-transit SO${res.checkedSOs === 1 ? "" : "s"} checked against Signet memos · ${res.findings.length} finding${res.findings.length === 1 ? "" : "s"}` +
          (res.datesFixed > 0 ? ` · ${res.datesFixed} date window${res.datesFixed === 1 ? "" : "s"} refreshed from Signet` : "")
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

  // Needs attention = a PO with no SO (QB memo had no "Sales Order ####" —
  // type it in), or any non-green flag: NEED TO SHIP (not moving, cancel
  // ≤ 21d) or AT RISK (in HK with ≤ 10d to cancel, or in transit with ≤ 5d).
  const isAttention = (r) =>
    r.status === "open" &&
    (!r.signet_po_number || (r._flag && r._flag !== FLAGS.ON_TRACK));

  const counts = useMemo(() => {
    const c = { ordered: 0, hong_kong: 0, in_transit: 0, warehouse: 0, attention: 0 };
    for (const r of enriched) {
      if (r.status !== "open") continue;
      if (c[r._stage] != null) c[r._stage]++;
      if (r.received_confirmed_at) c.warehouse++;
      if (isAttention(r)) c.attention++;
    }
    return c;
  }, [enriched]);

  // A live search ignores the tab entirely — a PO comes up no matter where it
  // is (any stage, even closed); the search view shows a Status column so you
  // can see where each match lives.
  const searching = search.trim().length > 0;

  const filtered = useMemo(() => {
    let list = enriched;
    if (!searching) {
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
        // "in warehouse only" sub-view: just what's physically here
        if (whOnly) list = list.filter((r) => r.received_confirmed_at);
      } else list = list.filter((r) => r.status === "open" && r._stage === tab);
    }
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (r) =>
          String(r.vendor_po).toLowerCase().includes(q) ||
          String(r.signet_po_number || "").toLowerCase().includes(q) ||
          String(r.vendor || "").toLowerCase().includes(q) ||
          String(r.notes || "").toLowerCase().includes(q) ||
          String(r.leg1_tracking || "").toLowerCase().includes(q) ||
          String(r.out_tracking || "").toLowerCase().includes(q) ||
          String(r.out_invoice || "").toLowerCase().includes(q)
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
            (!f.tracking.trim() || has(r.leg1_tracking, f.tracking)) &&
            (!f.invoice.trim() || has(r.out_invoice, f.invoice)) &&
            (!f.out_tracking.trim() || has(r.out_tracking, f.out_tracking)) &&
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
        case "tracking": return r.leg1_tracking || null;
        case "invoice": return r.out_invoice || null;
        case "out_tracking": return r.out_tracking || null;
        case "arrived": return r.received_confirmed_at || null;
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
  }, [enriched, tab, search, sort, colFilters, whOnly]);

  // Hong Kong: forwarder batches — one card per factory-ship date
  const hkGroups = useMemo(() => {
    if (tab !== "hong_kong" || searching) return [];
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

  // In transit DEFAULT: grouped by physical shipment — the inbound tracking #
  // everything flew on. What lands together sits together (Brian 7/20).
  // Laggard rows (other stages pulled in for SO context) stay out of this view.
  const shipGroups = useMemo(() => {
    if (tab !== "in_transit" || searching || transitGroupBy !== "shipment") return [];
    const byTrk = new Map();
    for (const r of filtered) {
      if (r._stage !== "in_transit") continue;
      const key = r.leg1_tracking || "No tracking yet";
      if (!byTrk.has(key)) byTrk.set(key, []);
      byTrk.get(key).push(r);
    }
    const groups = [...byTrk.entries()].map(([trk, pos]) => ({
      trk,
      pos, // filtered order → column sorting works inside each shipment
      boxes: pos.reduce((s, p) => s + (p.carton_count || 0), 0),
      total: pos.reduce((s, p) => s + (Number(amountOf(p)) || 0), 0),
      sos: [...new Set(pos.map((p) => p.signet_po_number).filter(Boolean))],
      departed:
        pos.map((p) => (p.route === "direct" ? shippedDateOf(p) : p.hk_departed_at)).filter(Boolean).sort()[0] || null,
      allHere: pos.every((p) => p.received_confirmed_at),
    }));
    // newest departure first; the untracked bucket sinks to the bottom
    return groups.sort((a, b) => {
      if (a.trk === "No tracking yet") return 1;
      if (b.trk === "No tracking yet") return -1;
      return String(b.departed || "").localeCompare(String(a.departed || ""));
    });
  }, [filtered, tab, searching, transitGroupBy]);

  // In transit alt view: grouped by SO, whole order visible
  const soGroups = useMemo(() => {
    if (tab !== "in_transit" || searching) return [];
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
        // sort the SO groups by their first tracking / invoice / UPS # so the
        // Tracking column header actually reorders the In transit view
        case "tracking": return g.pos.map((p) => p.leg1_tracking || "").filter(Boolean).sort()[0] || null;
        case "invoice": return g.pos.map((p) => p.out_invoice || "").filter(Boolean).sort()[0] || null;
        case "out_tracking": return g.pos.map((p) => p.out_tracking || "").filter(Boolean).sort()[0] || null;
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

  // Add/edit the inbound tracking # (leg1_tracking) — the piece quick ship
  // skips. One number shared across the rows passed in (one AWB, many POs).
  async function promptTracking(targetRows) {
    const existing = targetRows.find((r) => r.leg1_tracking)?.leg1_tracking || "";
    const label =
      targetRows.length === 1
        ? `Tracking # for vendor PO ${targetRows[0].vendor_po} (${targetRows[0].vendor || "?"}). Leave empty to clear.`
        : `Tracking # for ${targetRows.length} POs — shared, one shipment covering all of them.`;
    const val = await showPrompt(label, {
      title: "Tracking number",
      placeholder: "SF / DHL / FedEx / UPS #",
      defaultValue: existing,
    });
    if (val == null) return;
    const clean = String(val).trim();
    await applyPatches(Object.fromEntries(targetRows.map((r) => [r.id, { leg1_tracking: clean || null }])));
  }

  // "In warehouse" (Brian 7/20): goods physically arrived at E. Chabot but not
  // shipped out to Signet yet. Stamps received_confirmed_at; row stays In
  // transit (Ship out still closes it) but reads green. Toggle: if every
  // selected row is already marked, the same button unmarks.
  async function toggleWarehouse(targetRows) {
    const allIn = targetRows.every((r) => r.received_confirmed_at);
    const stamp = allIn ? null : new Date().toISOString();
    await applyPatches(Object.fromEntries(targetRows.map((r) => [r.id, { received_confirmed_at: stamp }])));
  }

  // Pre-entry for ship-out (Ezra 7/20): invoice # + outbound UPS # get typed
  // ahead of time on In transit rows; ShipOutDialog picks them up as defaults.
  async function promptOutField(row, field) {
    const isInv = field === "out_invoice";
    const val = await showPrompt(
      `${isInv ? "Invoice #" : "Outbound UPS / tracking #"} for vendor PO ${row.vendor_po}. Leave empty to clear.`,
      {
        title: isInv ? "Invoice number" : "Outbound tracking",
        placeholder: isInv ? "692245" : "1Z71A562…",
        defaultValue: row[field] || "",
      }
    );
    if (val == null) return;
    const clean = String(val).trim();
    await applyPatches({ [row.id]: { [field]: clean || null } });
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

  // While searching: one generic table for matches from every tab — status
  // column on, tab-specific extras off.
  const showFlags = tab === "attention" && !searching; // flags/issues live here only
  const isOrdered = tab === "ordered";
  const showStatus = searching || (!isOrdered && tab !== "in_transit"); // in transit: the view IS the status
  const showBoxesNotes = searching || (tab !== "ordered" && tab !== "attention"); // shipping-side columns only
  const showTracking = tab === "in_transit" && !searching && !whOnly; // inbound tracking — pointless once everything shown is here
  const showOutCols = tab === "in_transit" && !searching; // invoice + UPS pre-entry
  const showArrived = tab === "in_transit" && whOnly && !searching; // warehouse view: when it landed

  // ── ONE row format everywhere ──
  // checkbox · PO · vendor · SO · ship→cancel · $ · boxes · status (not in
  // Ordered) · notes as visible text (click to edit) · flag/link (attention)
  // opts.soContent overrides the SO cell (group views show SO once per group);
  // opts.groupStart draws a heavier divider so an SO's rows sit together.
  function renderRow(r, opts = {}) {
    const dd = daysUntil(dueDateOf(r));
    return (
      <tr key={r.id}
        className={`${opts.groupStart ? "border-t-2 border-gray-300" : "border-t"} hover:bg-gray-50 ${selected.has(r.id) ? "bg-blue-50/40" : showTracking && r.status === "open" && r.received_confirmed_at ? "bg-emerald-50/60" : ""}`}>
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
        {showTracking && (
          <td className="px-3 py-2 text-xs whitespace-nowrap">
            {r.received_confirmed_at ? (
              // it's here — the inbound tracking # is history, don't show it
              <span className="text-[11px] font-semibold text-emerald-700"
                title={`Arrived at our warehouse ${fmtDate(r.received_confirmed_at)} — tracking hidden, it's done its job`}>
                in warehouse {fmtDate(r.received_confirmed_at)}
              </span>
            ) : r.leg1_tracking ? (
              <span className="inline-flex items-center gap-1.5">
                <a href={trackingUrl(r.leg1_tracking)} target="_blank" rel="noreferrer"
                  title="Open carrier tracking in a new tab"
                  className="font-mono text-blue-600 hover:underline">
                  {r.leg1_tracking}
                </a>
                <button onClick={() => promptTracking([r])} title="Edit tracking"
                  className="text-gray-300 hover:text-gray-600">
                  <Pencil size={12} />
                </button>
              </span>
            ) : (
              <button onClick={() => promptTracking([r])} title="Add tracking"
                className="text-gray-300 hover:text-gray-700">+ tracking</button>
            )}
          </td>
        )}
        {showOutCols && (
          <td className="px-3 py-2 text-xs whitespace-nowrap">
            {r.out_invoice ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-medium">{r.out_invoice}</span>
                <button onClick={() => promptOutField(r, "out_invoice")} title="Edit invoice #"
                  className="text-gray-300 hover:text-gray-600">
                  <Pencil size={12} />
                </button>
              </span>
            ) : (
              <button onClick={() => promptOutField(r, "out_invoice")} title="Add the QuickBooks invoice # ahead of ship-out"
                className="text-gray-300 hover:text-gray-700">+ invoice</button>
            )}
          </td>
        )}
        {showOutCols && (
          <td className="px-3 py-2 text-xs whitespace-nowrap">
            {r.out_tracking ? (
              <span className="inline-flex items-center gap-1.5">
                <a href={trackingUrl(r.out_tracking)} target="_blank" rel="noreferrer"
                  title="Open carrier tracking in a new tab"
                  className="font-mono text-blue-600 hover:underline">
                  {r.out_tracking}
                </a>
                <button onClick={() => promptOutField(r, "out_tracking")} title="Edit outbound tracking"
                  className="text-gray-300 hover:text-gray-600">
                  <Pencil size={12} />
                </button>
              </span>
            ) : (
              <button onClick={() => promptOutField(r, "out_tracking")} title="Add the outbound UPS # ahead of ship-out"
                className="text-gray-300 hover:text-gray-700">+ UPS #</button>
            )}
          </td>
        )}
        {showArrived && (
          <td className="px-3 py-2 text-xs whitespace-nowrap text-emerald-700 font-medium">
            {fmtDate(r.received_confirmed_at)}
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
                {r.leg1_tracking && (
                  <>
                    {" · "}
                    <a href={trackingUrl(r.leg1_tracking)} target="_blank" rel="noreferrer"
                      className="underline decoration-green-300 hover:text-green-900">
                      {r.leg1_tracking}
                    </a>
                  </>
                )}
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
          {showTracking && th("tracking", "Tracking")}
          {showOutCols && th("invoice", "Invoice #")}
          {showOutCols && th("out_tracking", "UPS #")}
          {showArrived && th("arrived", "Arrived")}
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
              onClick={() => promptTracking(openSelected.filter((r) => r._stage === "in_transit"))}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-100">
              <Hash size={14} /> Add tracking
            </button>
          )}
          {openSelected.some((r) => r._stage === "in_transit") && (() => {
            const transit = openSelected.filter((r) => r._stage === "in_transit");
            const allIn = transit.every((r) => r.received_confirmed_at);
            return (
              <button onClick={() => toggleWarehouse(transit)} disabled={busy}
                title={allIn
                  ? "Un-mark — goods are not at the warehouse after all"
                  : "Goods arrived at our warehouse — marks them received, ready to ship out"}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700">
                <PackageCheck size={14} /> {allIn ? "Undo in warehouse" : "In warehouse"}
              </button>
            );
          })()}
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
      ) : searching ? (
        // global search: matches from EVERY tab, status column shows where each one is
        <div className="border rounded-lg overflow-x-auto bg-white">
          <div className="px-3 py-1.5 text-xs text-gray-500 border-b bg-gray-50">
            Showing matches from all tabs — clear the search to go back
          </div>
          <table className="w-full text-sm">
            {tableHead(false)}
            <tbody>{filtered.map(renderRow)}</tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm">No PO matches "{search.trim()}".</div>
          )}
        </div>
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
        <>
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-400 mr-1">Group by</span>
              {[["shipment", "Shipment"], ["so", "Sales order"]].map(([k, label]) => (
                <button key={k} onClick={() => setTransitGroupBy(k)}
                  className={`px-2.5 py-1 rounded-full ${
                    transitGroupBy === k ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
            {(counts.warehouse > 0 || whOnly) && (
              <button
                onClick={() => setWhOnly((v) => !v)}
                title={whOnly
                  ? "Back to the full In transit view"
                  : "Show only the POs physically at our warehouse, ready to ship out"}
                className={`text-xs px-3 py-1.5 rounded-full font-medium ${
                  whOnly
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100"
                }`}>
                {whOnly ? `In warehouse only (${counts.warehouse}) ✕` : `In warehouse (${counts.warehouse})`}
              </button>
            )}
          </div>
        <div className="border rounded-lg overflow-x-auto bg-white">
          <table className="w-full text-sm">
            {tableHead(true, true)}
            <tbody>
              {/* per-column filters (full view only — the warehouse sub-view swaps columns) */}
              {!whOnly && (
              <tr className="bg-gray-50/70 border-b">
                <td className="px-3 py-1" />
                {[
                  ["po", "filter…"],
                  ["so", "filter…"],
                  ["boxes", "#"],
                  ["notes", "filter…"],
                  ["tracking", "filter…"],
                  ["invoice", "inv…"],
                  ["out_tracking", "1Z…"],
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
              )}
              {transitGroupBy === "shipment" && shipGroups.map((g) => (
                <React.Fragment key={g.trk}>
                  <tr className="border-t-2 border-gray-300 bg-gray-50">
                    <td colSpan={12} className="px-3 py-1.5">
                      <div className="flex items-center gap-3 text-xs">
                        {g.trk === "No tracking yet" ? (
                          <span className="font-semibold text-gray-500">No tracking yet</span>
                        ) : (
                          <a href={trackingUrl(g.trk)} target="_blank" rel="noreferrer"
                            title="Open carrier tracking in a new tab"
                            className="font-mono font-semibold text-blue-700 hover:underline">
                            {g.trk}
                          </a>
                        )}
                        <span className="text-gray-600">
                          {g.pos.length} PO{g.pos.length === 1 ? "" : "s"} · {g.sos.length} SO{g.sos.length === 1 ? "" : "s"}
                          {g.boxes ? ` · ${g.boxes} bx` : ""}
                        </span>
                        <span className="text-gray-500">{dollar(g.total)}</span>
                        {g.departed && <span className="text-gray-500">left {fmtDate(g.departed)}</span>}
                        <button onClick={() => toggleWarehouse(g.pos)} disabled={busy}
                          title={g.allHere ? "Un-mark this whole shipment" : "This shipment landed — mark every PO on it as in the warehouse"}
                          className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded ${
                            g.allHere
                              ? "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                              : "bg-emerald-600 text-white hover:bg-emerald-700"
                          } disabled:opacity-50`}>
                          <PackageCheck size={13} />
                          {g.allHere ? "Undo in warehouse" : `In warehouse (all ${g.pos.length})`}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {g.pos.map((p) => renderRow(p))}
                </React.Fragment>
              ))}
              {transitGroupBy === "so" && soGroups.map((g) => {
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
                                {(() => {
                                  const here = moving.filter((p) => p.received_confirmed_at).length;
                                  return here > 0 ? <span className="text-emerald-700"> · {here} here</span> : null;
                                })()}
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
                        <td colSpan={10} className="px-3 py-1.5 text-xs text-amber-800">
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
          {(transitGroupBy === "shipment" ? shipGroups : soGroups).length === 0 && (
            <div className="text-gray-400 py-12 text-center text-sm">
              {whOnly ? "Nothing marked in warehouse yet." : "Nothing here."}
            </div>
          )}
        </div>
        </>
      ) : (
        <>
          {tab === "closed" && <ShippedBatches />}
          <div className="border rounded-lg overflow-x-auto bg-white">
            <table className="w-full text-sm">
              {tableHead(false)}
              <tbody>{filtered.map(renderRow)}</tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-gray-400 py-12 text-center text-sm">Nothing here.</div>
            )}
          </div>
        </>
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

// ── Shipped batches (Closed tab): re-download the docs after ship-out ──
// Everything the manifest + pickup request are built from was saved at
// ship-out time (outbound_batches / outbound_boxes / box_contents / invoices),
// so we rebuild the exact {batch, boxList} shapes the dialog produced and hand
// them to the SAME generators in shipmentDocs.js. One note: box notes come
// from the shipment row as it is NOW, same as the original print.
function ShippedBatches() {
  const { supabase } = useSupabase();
  const { showAlert } = useAlert();
  const [batches, setBatches] = useState(null); // null = loading, [] = none
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // docs folder (OneDrive "Shipments manifests") — picked once per machine
  const [folderName, setFolderName] = useState(null);
  useEffect(() => {
    getDocFolderName().then(setFolderName).catch(() => {});
  }, []);
  async function chooseFolder() {
    try {
      const h = await pickDocFolder();
      setFolderName(h.name);
      showAlert(`Docs will now save to "${h.name}"`, { variant: "success" });
    } catch {
      /* picker cancelled */
    }
  }
  async function forgetFolder() {
    await clearDocFolder();
    setFolderName(null);
  }

  useEffect(() => {
    let dead = false;
    // .in() lists go in the URL — chunk so a big batch set can't overflow it
    async function fetchIn(table, cols, col, ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase.from(table).select(cols).in(col, ids.slice(i, i + 150));
        if (error) throw new Error(table + ": " + error.message);
        out.push(...(data || []));
      }
      return out;
    }
    (async () => {
      try {
        const { data: bs, error } = await supabase
          .from("outbound_batches")
          .select("id, carrier, master_tracking, shipped_date, pickup_window, declared_value")
          .order("shipped_date", { ascending: false })
          .limit(25);
        if (error) throw new Error(error.message);
        const list = bs || [];
        const boxes = list.length
          ? await fetchIn("outbound_boxes", "id, batch_id, box_number, per_box_tracking", "batch_id", list.map((b) => b.id))
          : [];
        const contents = boxes.length
          ? await fetchIn("box_contents", "box_id, shipment_id, invoice_id", "box_id", boxes.map((x) => x.id))
          : [];
        const shipIds = [...new Set(contents.map((c) => c.shipment_id).filter(Boolean))];
        const invIds = [...new Set(contents.map((c) => c.invoice_id).filter(Boolean))];
        const ships = shipIds.length
          ? await fetchIn(SHIPMENTS_TABLE, "id, vendor_po, signet_po_number, notes", "id", shipIds)
          : [];
        const invs = invIds.length ? await fetchIn("invoices", "id, invoice_number", "id", invIds) : [];
        const contentByBox = new Map(contents.map((c) => [c.box_id, c]));
        const shipById = new Map(ships.map((s) => [s.id, s]));
        const invById = new Map(invs.map((i) => [i.id, i]));
        for (const b of list) {
          b.boxes = boxes
            .filter((x) => x.batch_id === b.id)
            .sort((a, z) => a.box_number - z.box_number)
            .map((x) => {
              const c = contentByBox.get(x.id);
              const s = c ? shipById.get(c.shipment_id) : null;
              return {
                boxNumber: x.box_number,
                invoiceNumber: (c?.invoice_id && invById.get(c.invoice_id)?.invoice_number) || "",
                vendorPo: s?.vendor_po || "—",
                signetPo: s?.signet_po_number || "",
                tracking: x.per_box_tracking || "",
                note: s?.notes || "",
              };
            });
          b.pos = [...new Set(b.boxes.map((x) => x.vendorPo).filter((p) => p && p !== "—"))];
        }
        if (!dead) setBatches(list);
      } catch (err) {
        console.error("shipped batches load:", err);
        if (!dead) setBatches([]);
      }
    })();
    return () => { dead = true; };
  }, [supabase]);

  if (batches === null)
    return <div className="text-xs text-gray-400 mb-3">Loading shipped batches…</div>;
  if (batches.length === 0) return null;

  const docBatch = (b) => ({
    carrier: b.carrier,
    masterTracking: b.master_tracking,
    shippedDate: b.shipped_date,
    totalBoxes: b.boxes.length,
  });
  async function run(b, fn) {
    setBusyId(b.id);
    try {
      const where = await fn();
      if (where === "folder") showAlert(`Saved to "${folderName}"`, { variant: "success" });
      else if (folderName) showAlert("Folder save failed — downloaded instead", { variant: "warning" });
    } catch (err) {
      showAlert("Doc failed: " + err.message, { variant: "error" });
    } finally {
      setBusyId(null);
    }
  }
  const btn = "px-2 py-0.5 text-xs rounded border hover:bg-gray-100 disabled:opacity-40";
  const visible = showAll ? batches : batches.slice(0, 6);

  return (
    <div className="border rounded-lg bg-white mb-4">
      <div className="px-3 py-2 border-b text-sm font-medium flex items-center gap-3 flex-wrap">
        <span>
          Shipped batches <span className="text-gray-400 font-normal">— reprint manifest / pickup docs</span>
        </span>
        {folderApiSupported() && (
          <span className="ml-auto text-xs font-normal text-gray-500 flex items-center gap-1.5">
            {folderName ? (
              <>
                docs → <b className="text-gray-700">{folderName}</b>
                <button onClick={chooseFolder} className="text-blue-500 hover:underline">change</button>
                <button onClick={forgetFolder} title="Back to normal downloads"
                  className="text-gray-400 hover:text-gray-600">×</button>
              </>
            ) : (
              <button onClick={chooseFolder} className="text-blue-500 hover:underline"
                title="Pick the OneDrive Shipments manifests folder — docs save straight there instead of Downloads">
                save docs to a folder…
              </button>
            )}
          </span>
        )}
      </div>
      <div className="divide-y">
        {visible.map((b) => (
          <div key={b.id} className="px-3 py-2 flex items-center gap-3 text-sm flex-wrap">
            <span className="font-medium whitespace-nowrap">{fmtDate(b.shipped_date)}</span>
            <span className="text-gray-600 whitespace-nowrap">
              {b.carrier}
              {b.master_tracking ? " — " + b.master_tracking : ""} · {b.boxes.length} box{b.boxes.length === 1 ? "" : "es"}
            </span>
            <span className="text-xs text-gray-500 truncate max-w-[340px]" title={b.pos.join(", ")}>
              {b.pos.join(", ") || "—"}
            </span>
            <span className="ml-auto flex gap-1.5">
              <button className={btn} disabled={busyId === b.id}
                onClick={() => run(b, () => downloadManifestPdf(docBatch(b), b.boxes))}>
                Manifest PDF
              </button>
              <button className={btn} disabled={busyId === b.id}
                onClick={() => run(b, () => downloadManifestExcel(docBatch(b), b.boxes))}>
                Excel
              </button>
              {b.carrier === "Titan" && (
                <button className={btn} disabled={busyId === b.id}
                  onClick={() =>
                    run(b, () =>
                      downloadPickupRequestPdf({
                        pickupDate: b.shipped_date,
                        windowText: b.pickup_window,
                        totalBoxes: b.boxes.length,
                        declaredValue: b.declared_value,
                        reference: b.pos.join(", "),
                      })
                    )
                  }>
                  Pickup
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {batches.length > 6 && !showAll && (
        <button onClick={() => setShowAll(true)}
          className="w-full px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 border-t">
          Show all {batches.length}
        </button>
      )}
    </div>
  );
}
