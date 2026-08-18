import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import POUploader from "../components/RunningLines/POUploader";
import POLinesView from "../components/RunningLines/POLinesView";
import { reconcilePO, detectTariff, buildSkuMap, groupComponents, publishedLockFor } from "../utils/reconcilePOLines";
import { recomputeSignetBill, rebillFromActualPrice } from "../utils/runningLinesMath";
import { useMetalPriceStore } from "../store/MetalPrices";
import { Trash2, Search, Download, StickyNote, ChevronDown, ChevronRight, Landmark, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import { useAlert } from "../components/Alerts/AlertContext";
import { SHIPMENTS_TABLE, stageOf } from "../utils/shipmentsSync";
import { useGenericStore } from "../store/VendorStore";
import { isQbEnabled, refreshQbTransportTuning } from "../utils/qbClient";
import { importQbPosFromQb } from "../utils/qbPoImport";
import {
  prepareSalesOrderCreatesForPos,
  prepareSalesOrderUpdatesForPos,
  sendPreparedSalesOrderCreates,
  sendPreparedSalesOrderUpdates,
} from "../utils/qbSalesOrders";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";
import SelectAllCheckbox from "../components/SelectAllCheckbox";
import ActionMenu from "../components/ActionMenu";
import {
  folderApiSupported,
  pickDocFolder,
  clearDocFolder,
  getDocFolderName,
  getWritableDocFolder,
  writeToFolder,
} from "../utils/docFolder";

// Small QuickBooks sync-status chip shown on a PO row. Reads the qb_* columns
// stamped by the sync (qbSyncStatus.persistSyncResult).
function QbStatusBadge({ po }) {
  const s = po.qb_so_status;
  if (!s) return null;
  const map = {
    created: { label: "QB created", cls: "bg-blue-100 text-blue-700" },
    // Yellow, not green: "synced" only means we just PUSHED a change to
    // QuickBooks, not that this row has been independently reconfirmed
    // against what's actually there now — Kevin 8/13, after testing the
    // update flow: this shouldn't read as "confirmed same as QB."
    synced: { label: "QB synced", cls: "bg-yellow-100 text-yellow-800" },
    existed: { label: "in QB", cls: "bg-gray-100 text-gray-600" },
    failed: { label: "QB failed", cls: "bg-red-100 text-red-700" },
  };
  const m = map[s] || { label: `QB ${s}`, cls: "bg-gray-100 text-gray-600" };
  const title = [
    po.qb_created_at ? `created ${new Date(po.qb_created_at).toLocaleString()}` : null,
    po.qb_synced_at ? `synced ${new Date(po.qb_synced_at).toLocaleString()}` : null,
    po.qb_so_ref ? `SO ${po.qb_so_ref}` : null,
    po.qb_sync_error ? `error: ${po.qb_sync_error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className={`ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-sans align-middle ${m.cls}`}
      title={title}
    >
      {m.label}
    </span>
  );
}

export default function PurchaseOrders() {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm } = useAlert();
  // Today's spot — the modal seeds new silver/gold from this when the chosen
  // lock date has no exact published lock row. The export mirrors that fallback.
  const prices = useMetalPriceStore((s) => s.prices);
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPo, setSelectedPo] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState({ key: "po_date", dir: "desc" });
  const [viewFilter, setViewFilter] = useState("open"); // open (default) | all | shipped
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [memoStatus, setMemoStatus] = useState("");
  const [memoBusy, setMemoBusy] = useState(false);
  // QuickBooks integration — INERT unless the master switch in Settings is ON
  // (options.qbIntegration.enabled). When off, the QB buttons don't even render.
  const settings = useGenericStore((state) => state.getEntity("settings"));
  const qbOn = isQbEnabled(settings);

  // Read the connector's transport ONCE when the page opens, so the client
  // timeout is already tuned by the time anyone presses a QB button. This
  // used to run inside the flows, which put an extra HTTP round trip between
  // the click and the first real request — the opposite of the point.
  useEffect(() => {
    if (qbOn) refreshQbTransportTuning();
  }, [qbOn]);

  const [qbSummary, setQbSummary] = useState(null);
  const [qbUpdateSummary, setQbUpdateSummary] = useState(null);
  // Both batch flows run prepare -> review -> send; qbPreview holds the built
  // payloads between those steps (null when no review is pending) and carries
  // mode: "create" | "update" so one modal can serve both. This (and the two
  // summary states above) is page-local review/result UI, not a "process" —
  // everything that actually talks to QuickBooks reports into the global
  // QbSyncJobStore from inside qbSalesOrders.js / qbPoImport.js now, so this
  // page only READS busy/progress state, it never owns it (see QbSyncJobWidget).
  const [qbPreview, setQbPreview] = useState(null);
  const qbProcesses = useQbSyncJobStore((s) => s.processes);
  const findRunning = (types) => qbProcesses.find((p) => p.status === "running" && types.includes(p.type));
  const qbCreateProc = findRunning(["create-prepare", "create-send"]);
  const qbUpdateProc = findRunning(["update-prepare", "update-send"]);
  const qbBusy = !!qbCreateProc;
  const qbUpdateBusy = !!qbUpdateProc;
  const memoSyncBusy = !!findRunning(["po-sync"]);
  const previewBusy = qbPreview?.mode === "create" ? qbBusy : qbUpdateBusy;
  const qbProgress = qbPreview?.mode === "create" ? qbCreateProc : qbUpdateProc;
  // A batch that got interrupted (page reload) or stopped (the widget's Stop
  // button) shows a Resume banner here — resuming just re-selects its PO ids
  // and re-runs the normal prepare -> review -> send flow (see
  // resumeInterruptedJob below).
  const qbInterruptedJob =
    qbProcesses.find(
      (p) =>
        (p.status === "interrupted" || p.status === "cancelled") &&
        ["create-prepare", "create-send", "update-prepare", "update-send"].includes(p.type) &&
        p.poIds?.length
    ) || null;
  // rebills folder (OneDrive "ReBill From PLM") — picked once per machine;
  // rebill CSVs + line exports save there instead of Downloads
  const [rebillFolderName, setRebillFolderName] = useState(null);
  useEffect(() => {
    getDocFolderName("rebills").then(setRebillFolderName).catch(() => {});
  }, []);
  async function chooseRebillFolder() {
    try {
      const h = await pickDocFolder("rebills");
      setRebillFolderName(h.name);
      showAlert(`Rebill exports will now save to "${h.name}"`, { variant: "success" });
    } catch {
      /* picker cancelled */
    }
  }
  async function forgetRebillFolder() {
    await clearDocFolder("rebills");
    setRebillFolderName(null);
  }

  // vendor-PO shipments per SO (from the Shipments module)
  const [shipments, setShipments] = useState([]);
  const [expandedShip, setExpandedShip] = useState(() => new Set());

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const [{ data, error }, { data: ship, error: e2 }] = await Promise.all([
        supabase
          .from("running_line_purchase_orders")
          .select("*")
          .order("po_date", { ascending: false }),
        supabase
          .from(SHIPMENTS_TABLE)
          .select("vendor_po, signet_po_number, vendor, status, route, carton_count, factory_shipped_at, hk_arrived_at, hk_departed_at, received_confirmed_at, memo_unlinked_at")
          .is("deleted_at", null),
      ]);
      if (error) console.error(error.message);
      if (e2) console.error("shipments:", e2.message);
      setPos(data ?? []);
      setShipments(ship ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  // SO number → its vendor POs
  const shipsBySO = useMemo(() => {
    const m = new Map();
    for (const s of shipments) {
      const k = String(s.signet_po_number || "");
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    for (const list of m.values()) list.sort((a, b) => String(a.vendor_po).localeCompare(String(b.vendor_po)));
    return m;
  }, [shipments]);

  const shipStageText = (s) => {
    const stage = stageOf(s);
    if (stage === "closed") return { text: "shipped out", cls: "text-gray-500" };
    if (stage === "in_transit") return { text: "shipped · in transit", cls: "text-green-700" };
    if (stage === "hong_kong") return { text: "shipped · at Hong Kong", cls: "text-blue-700" };
    return { text: "not shipped", cls: "text-red-600" };
  };

  function toggleShip(id) {
    setExpandedShip((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const dollar = (n) =>
    n == null
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

  // An SO is "done" when it's manually marked fully shipped, or every vendor
  // PO on the shipments board for it is closed. Everything else — partial,
  // in transit, at HK, or nothing on the board — is still open.
  const soDone = (p) => {
    if (p.marked_shipped_at) return true;
    const ships = shipsBySO.get(String(p.po_number || "")) || [];
    return ships.length > 0 && ships.every((s) => stageOf(s) === "closed");
  };

  const viewCounts = useMemo(() => {
    let open = 0;
    let shipped = 0;
    for (const p of pos) (soDone(p) ? shipped++ : open++);
    return { all: pos.length, open, shipped };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, shipsBySO]);

  const filteredPos = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = pos;
    if (viewFilter === "open") list = list.filter((p) => !soDone(p));
    else if (viewFilter === "shipped") list = list.filter((p) => soDone(p));
    if (!q) return list;
    return list.filter((p) => String(p.po_number || "").toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, search, viewFilter, shipsBySO]);

  // Format an ISO date (YYYY-MM-DD) as M/D/YY for display
  const fmtDate = (d) => {
    if (!d) return "—";
    const parts = String(d).slice(0, 10).split("-");
    if (parts.length !== 3) return d;
    const [y, m, day] = parts;
    return `${Number(m)}/${Number(day)}/${y.slice(2)}`;
  };

  const NUMERIC_SORT_KEYS = ["line_count", "confidence_score", "total_amount"];
  function toggleSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key.endsWith("_date") ? "desc" : "asc" }
    );
  }
  const sortArrow = (key) =>
    sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

  const sortedPos = useMemo(() => {
    const arr = [...filteredPos];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const aNull = av == null || av === "";
      const bNull = bv == null || bv === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1; // nulls always last, regardless of direction
      if (bNull) return -1;
      let c;
      if (NUMERIC_SORT_KEYS.includes(key)) {
        c = Number(av) - Number(bv);
      } else if (key === "po_number") {
        const an = Number(av);
        const bn = Number(bv);
        c =
          Number.isFinite(an) && Number.isFinite(bn)
            ? an - bn
            : String(av).localeCompare(String(bv));
      } else {
        // date columns are ISO yyyy-mm-dd, so string compare = chronological
        c = String(av).localeCompare(String(bv));
      }
      return dir === "asc" ? c : -c;
    });
    return arr;
  }, [filteredPos, sort]);

  const visibleIds = useMemo(() => sortedPos.map((p) => p.id), [sortedPos]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (visibleIds.every((id) => next.has(id))) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function confidenceColor(c) {
    if (c == null) return "text-gray-400";
    if (c >= 90) return "text-green-600";
    if (c >= 70) return "text-amber-600";
    if (c >= 50) return "text-orange-600";
    return "text-red-600";
  }

  async function deletePo(po) {
    if (!supabase) return;
    if (!(await showConfirm(`Delete PO ${po.po_number || po.id.slice(0, 8)}? This can't be undone.`, { confirmText: "Delete", variant: "error" }))) return;
    setDeletingId(po.id);
    // Delete line items first, then the PO itself.
    const { error: e1 } = await supabase
      .from("running_line_po_items")
      .delete()
      .eq("po_id", po.id);
    if (e1) {
      console.error("delete items failed:", e1.message);
      showAlert(e1.message, { title: "Failed to delete line items", variant: "error" });
      setDeletingId(null);
      return;
    }
    const { error: e2 } = await supabase
      .from("running_line_purchase_orders")
      .delete()
      .eq("id", po.id);
    if (e2) {
      console.error("delete PO failed:", e2.message);
      showAlert(e2.message, { title: "Failed to delete PO", variant: "error" });
      setDeletingId(null);
      return;
    }
    setPos((prev) => prev.filter((p) => p.id !== po.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(po.id);
      return next;
    });
    setDeletingId(null);
  }

  async function updateTariff(po, newValue) {
    if (!supabase) return;
    const newTariff = Number(newValue);
    if (!Number.isFinite(newTariff)) return;
    if (newTariff === Number(po.tariff_percent)) return; // no change
    // Null out confidence — it's stale until the modal recomputes
    const { error } = await supabase
      .from("running_line_purchase_orders")
      .update({ tariff_percent: newTariff, confidence_score: null })
      .eq("id", po.id);
    if (error) {
      showAlert(error.message, { title: "Failed to update tariff", variant: "error" });
      return;
    }
    setPos((prev) =>
      prev.map((p) =>
        p.id === po.id ? { ...p, tariff_percent: newTariff, confidence_score: null } : p
      )
    );
  }

  // Cancel-date extensions get typed HERE (Brian 7/13). Writes the Signet PO
  // row; the Shipments board mirrors it on next load, where the LATER date
  // always wins — so a stale scrape can't shorten it back.
  async function updateDueDate(po, newValue) {
    if (!supabase) return;
    const newDate = String(newValue || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return; // cleared / partial — ignore
    if (newDate === String(po.due_date || "").slice(0, 10)) return; // no change
    const { error } = await supabase
      .from("running_line_purchase_orders")
      .update({ due_date: newDate })
      .eq("id", po.id);
    if (error) {
      showAlert(error.message, { title: "Failed to update cancel date", variant: "error" });
      return;
    }
    setPos((prev) => prev.map((p) => (p.id === po.id ? { ...p, due_date: newDate } : p)));
  }

  // "Clear all" (wipe every PO + line item) removed 7/20/26 — the page now
  // carries manual data that doesn't survive re-import (due-date extensions,
  // memos, marked_shipped_at, tariff edits). Single-PO delete still exists.

  // Compact in-PLM memo upload — same parse as the weekly QB importer.
  // Updates memo + memo_updated_at for matching POs; never clears (per Brian).
  async function handleMemoUpload(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !supabase) return;
    setMemoBusy(true);
    setMemoStatus("Reading…");
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
      let numCol = -1, memoCol = -1, hr = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = (rows[i] || []).map((c) => (c == null ? "" : String(c).trim().toLowerCase()));
        const n = r.indexOf("num");
        const m = r.indexOf("memo");
        if (n >= 0 && m >= 0) { hr = i; numCol = n; memoCol = m; break; }
      }
      if (hr < 0) { setMemoStatus('No "Num"/"Memo" columns found'); return; }
      const pairs = [];
      for (let i = hr + 1; i < rows.length; i++) {
        const numRaw = rows[i]?.[numCol];
        const memoRaw = rows[i]?.[memoCol];
        if (numRaw == null) continue;
        const mPO = String(numRaw).trim().match(/^(\d{4,})/);
        if (!mPO) continue;
        const memo = memoRaw == null ? "" : String(memoRaw).trim();
        if (!memo) continue;
        pairs.push({ po: mPO[1], memo });
      }
      if (pairs.length === 0) { setMemoStatus("No PO memos in that file"); return; }
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      let updated = 0;
      for (const { po, memo } of pairs) {
        const { data, error } = await supabase
          .from("running_line_purchase_orders")
          .update({ memo, memo_updated_at: today })
          .eq("po_number", po)
          .select("id");
        if (!error && data?.length) updated++;
      }
      const byPo = new Map(pairs.map((p) => [p.po, p.memo]));
      setPos((prev) =>
        prev.map((p) =>
          byPo.has(String(p.po_number))
            ? { ...p, memo: byPo.get(String(p.po_number)), memo_updated_at: today }
            : p
        )
      );
      setMemoStatus(`✓ ${updated} PO${updated === 1 ? "" : "s"} updated`);
    } catch (err) {
      setMemoStatus("Failed: " + (err?.message || err));
    } finally {
      setMemoBusy(false);
      setTimeout(() => setMemoStatus(""), 6000);
    }
  }

  // Create a QuickBooks Sales Order for each checked PO. Existing SOs are
  // skipped and reported (never overwritten); one duplicate/failure doesn't
  // abort the rest. GATED — only reachable when the Settings toggle is on.
  // Same two-phase flow as the batch update: build every payload and check
  // which SOs already exist WITHOUT writing anything, show the review, then
  // send exactly what was approved. Creating a sales order is the less
  // reversible of the two operations, so it gets the same look-first
  // treatment. Existing SOs are never overwritten.
  // Pull fresh qb_* status for the given PO ids and merge into the table, so the
  // badges reflect what just synced without a full reload.
  // C1 — synchronous double-click guard shared by both Send buttons.
  const qbSendingRef = useRef(false);

  // B8 — a preview built more than this long ago may no longer match what's
  // in QuickBooks (someone edits an SO in the QB UI in the meantime).
  const PREVIEW_MAX_AGE_MS = 10 * 60 * 1000;

  function previewIsStale(prepared) {
    const stamps = (prepared || []).map((p) => p.preparedAt).filter(Boolean);
    if (!stamps.length) return false; // older prepare shape — don't block
    return Date.now() - Math.min(...stamps) > PREVIEW_MAX_AGE_MS;
  }

  async function refreshQbStatus(ids) {
    if (!supabase || !ids || ids.length === 0) return;
    try {
      const { data, error } = await supabase
        .from("running_line_purchase_orders")
        .select("id,qb_so_status,qb_so_ref,qb_created_at,qb_synced_at,qb_sync_error")
        .in("id", ids);
      if (error || !data) return;
      const byId = new Map(data.map((r) => [r.id, r]));
      setPos((prev) => prev.map((p) => (byId.has(p.id) ? { ...p, ...byId.get(p.id) } : p)));
    } catch {
      /* best-effort — badges refresh on next full load if this fails */
    }
  }

  // idsOverride lets Resume re-trigger this with an explicit id set (e.g. from
  // an interrupted job) without depending on selectedIds having been updated
  // yet — onClick={handleCreateSosInQb} otherwise passes the click event here,
  // so only a real Set is honored.
  async function handleCreateSosInQb(idsOverride) {
    if (!qbOn || qbBusy) return;
    const idSet = idsOverride instanceof Set ? idsOverride : selectedIds;
    const chosen = pos.filter((p) => idSet.has(p.id));
    if (chosen.length === 0) return;
    setQbSummary(null);
    setQbPreview(null);
    // prepareSalesOrderCreatesForPos reports its own progress into the global
    // QbSyncJobStore (see qbSalesOrders.js) — nothing to track here.
    try {
      const res = await prepareSalesOrderCreatesForPos(chosen, { supabase, settings });
      // C2 — prepare is what discovers "QuickBooks already has this one";
      // without this the chip stayed stale until something else wrote a status.
      refreshQbStatus(chosen.map((p) => p.id).filter(Boolean));
      if (res.prepared.length === 0) {
        setQbSummary({ created: [], existed: res.existed, failed: res.failed });
        if (res.existed.length && !res.failed.length) {
          showAlert(
            `All ${res.existed.length} sales order${res.existed.length === 1 ? " is" : "s are"} already in QuickBooks — nothing to create.`,
            { title: "Nothing to create", variant: "success" }
          );
        }
        return;
      }
      setQbPreview({ mode: "create", ...res });
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  }

  // Phase 2 for create — send the reviewed payloads.
  async function sendQbCreatePreview() {
    if (!qbPreview || qbPreview.mode !== "create" || qbBusy) return;
    // C1 — the busy flag only flips after two async hops (trackQbProcess
    // awaits the Supabase session before startProcess), leaving a real window
    // where a second click gets through and sends the whole batch twice. A ref
    // flips synchronously, in the same tick as the click.
    if (qbSendingRef.current) return;
    qbSendingRef.current = true;
    const { prepared, existed, failed: prepFailed } = qbPreview;
    try {
      const res = await sendPreparedSalesOrderCreates(prepared, { supabase, settings });
      const summary = {
        created: res.created,
        existed: [...existed, ...res.existed],
        failed: [...prepFailed, ...res.failed],
      };
      setQbSummary(summary);
      setQbPreview(null);
      refreshQbStatus(prepared.map((p) => p.po?.id).filter(Boolean));
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    } finally {
      qbSendingRef.current = false;
    }
  }

  // Push current PLM data (lock date -> Other, ship/due dates, line
  // item/qty/price) onto every checked PO's EXISTING QB Sales Order, in one
  // batch — no need to open each PO. Never creates one; POs with no SO in QB
  // yet are skipped and reported (use "Create in QB" first).
  //
  // Two phases on purpose: PREPARE builds and diffs every payload without
  // touching QuickBooks, so the whole batch can be reviewed, and SEND then
  // transmits those exact payloads. Nothing reaches QuickBooks until the
  // preview is approved. GATED — only reachable when the Settings toggle is on.
  // See handleCreateSosInQb's comment — idsOverride powers Resume.
  async function handleUpdateSosInQb(idsOverride, { forceMemoStamp = true } = {}) {
    if (!qbOn || qbUpdateBusy) return;
    const idSet = idsOverride instanceof Set ? idsOverride : selectedIds;
    const chosen = pos.filter((p) => idSet.has(p.id));
    if (chosen.length === 0) return;
    setQbUpdateSummary(null);
    setQbPreview(null);
    try {
      const res = await prepareSalesOrderUpdatesForPos(chosen, {
        supabase,
        settings,
        forceMemoStamp,
      });
      if (res.prepared.length === 0) {
        // Nothing to send — say which bucket everything fell into rather than
        // popping an empty preview.
        setQbUpdateSummary({
          updated: [],
          notFound: res.notFound,
          failed: res.failed,
          unchanged: res.unchanged,
        });
        if (res.unchanged.length && !res.notFound.length && !res.failed.length) {
          showAlert(
            `All ${res.unchanged.length} sales order${res.unchanged.length === 1 ? " is" : "s are"} already up to date in QuickBooks — nothing to send.`,
            { title: "No changes", variant: "success" }
          );
        }
        return;
      }
      setQbPreview(res);
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  }

  // Phase 2 — send the payloads the preview showed, verbatim.
  async function sendQbPreview() {
    if (!qbPreview || qbUpdateBusy) return;
    if (qbSendingRef.current) return; // C1 — see sendQbCreatePreview
    const { prepared, notFound, failed: prepFailed, unchanged } = qbPreview;
    // B8 — don't send a diff that was computed against a QuickBooks state
    // from ten minutes ago.
    if (previewIsStale(prepared)) {
      setQbPreview(null);
      showAlert(
        "This preview is more than 10 minutes old — QuickBooks may have changed since. " +
          "Run the update check again before sending.",
        { title: "Preview is stale", variant: "error" }
      );
      return;
    }
    qbSendingRef.current = true;
    try {
      const res = await sendPreparedSalesOrderUpdates(prepared, { supabase, settings });
      const summary = {
        updated: res.updated,
        notFound,
        failed: [...prepFailed, ...res.failed],
        unchanged,
      };
      setQbUpdateSummary(summary);
      setQbPreview(null);
      refreshQbStatus(prepared.map((p) => p.po?.id).filter(Boolean));
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    } finally {
      qbSendingRef.current = false;
    }
  }

  // One-click Resume for an interrupted/cancelled bulk send: re-select the
  // process's PO ids and re-run the normal prepare -> review -> send flow.
  // Safe and correct without any special-case logic, because prepare already
  // checks live QuickBooks state (existence for create, a real diff for
  // update) — anything that finished before the interruption shows as
  // "already in QB" / "already up to date" and is skipped automatically.
  //
  // A7 — prepare's live check is necessary but not sufficient: persistSyncResult
  // already stamped qb_synced_at on every PO that settled BEFORE the
  // interruption, so read that first and drop those ids. An interrupted 50-PO
  // run then resumes with only the unsent tail instead of re-walking all 50
  // (and, with the memo stamp, re-PATCHing the ones that were already done).
  async function resumeInterruptedJob() {
    const job = qbInterruptedJob;
    if (!job) return;
    let ids = job.poIds || [];
    if (supabase && ids.length && job.startedAt) {
      try {
        const { data } = await supabase
          .from("running_line_purchase_orders")
          .select("id,qb_synced_at")
          .in("id", ids);
        const doneIds = new Set(
          (data || [])
            .filter(
              (r) => r.qb_synced_at && new Date(r.qb_synced_at).getTime() >= job.startedAt
            )
            .map((r) => r.id)
        );
        if (doneIds.size) ids = ids.filter((id) => !doneIds.has(id));
      } catch {
        /* best-effort — prepare still re-checks live QuickBooks state */
      }
    }
    const idSet = new Set(ids);
    useQbSyncJobStore.getState().dismissProcess(job.id);
    if (idSet.size === 0) {
      showAlert("Everything in that run already went through — nothing left to resume.", {
        title: "Nothing to resume",
        variant: "success",
      });
      return;
    }
    setSelectedIds(idSet);
    if (job.type.startsWith("create")) handleCreateSosInQb(idSet);
    // Resume must NOT force a memo stamp — only POs with a real change go out.
    else handleUpdateSosInQb(idSet, { forceMemoStamp: false });
  }

  // Sync the shipments board from QuickBooks — GET /views/open-po, and
  // nothing else. The sales-order report (all-so-zales) is NOT called here.
  //
  // Every purchase order in that report becomes a row on the shipments board,
  // and that row carries the link back to the Signet PO
  // (shipments.signet_po_number). A QB purchase order IS the vendor PO: its
  // payee is the vendor, its memo names the sales order. So the link is READ
  // from the source instead of inferred from a Signet PO's memo. Same upsert
  // the "All Purchase orders.xlsx" import uses — one implementation.
  //
  // GATED: no QuickBooks call unless the integration is on.
  async function handleSyncMemos() {
    if (!qbOn || memoSyncBusy) return;
    setMemoStatus("Syncing purchase orders from QuickBooks…");
    try {
      const imp = await importQbPosFromQb(supabase, { settings });
      console.info(
        `[QB] ${imp.view} import: parsed ${imp.parsed}, inserted ${imp.inserted}, updated ${imp.updated}`
      );
      if (imp.conflicts.length) console.warn("[QB] PO link conflicts:", imp.conflicts);
      if (imp.errors.length) console.warn("[QB] PO import errors:", imp.errors);

      if (imp.inserted || imp.updated) {
        const { data: ship } = await supabase
          .from(SHIPMENTS_TABLE)
          .select("vendor_po, signet_po_number, vendor, status, route, carton_count, factory_shipped_at, hk_arrived_at, hk_departed_at, received_confirmed_at, memo_unlinked_at")
          .is("deleted_at", null);
        setShipments(ship ?? []);
      }

      if (!imp.parsed && imp.errors.length) {
        setMemoStatus("Failed: " + imp.errors[0]);
        return;
      }
      const bits = [];
      if (imp.inserted) bits.push(`${imp.inserted} added`);
      if (imp.updated) bits.push(`${imp.updated} updated`);
      const conflictNote = imp.conflicts.length
        ? ` — ⚠ ${imp.conflicts.length} conflict${imp.conflicts.length === 1 ? "" : "s"} flagged, nothing overwritten`
        : "";
      setMemoStatus(
        `✓ ${imp.parsed} purchase order${imp.parsed === 1 ? "" : "s"} from QuickBooks` +
          (bits.length ? ` · ${bits.join(", ")}` : " · board already current") +
          conflictNote
      );
    } catch (e) {
      setMemoStatus("Failed: " + (e?.message || e));
    } finally {
      setTimeout(() => setMemoStatus(""), 6000);
    }
  }

  function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Export PO lines to one CSV. For each PO we detect the implied tariff
  // and back-engineered lock (best-fit), then predict each line and show
  // Signet-vs-Predicted, so a sort/filter on "Anomaly >10c" surfaces the real
  // data issues regardless of the stored tariff.
  // onlyIds: optional Set of PO ids — when present, export just those; else all.
  async function exportLines(onlyIds = null) {
    if (!supabase || exporting) return;
    setExporting(true);
    // resolve the rebills folder FIRST — the permission prompt needs the click
    // gesture fresh, and the line fetches below can take a few seconds
    const docDir = await getWritableDocFolder("rebills");
    try {
      const fetchAll = async (table, cols) => {
        let out = [];
        let from = 0;
        const step = 1000;
        for (;;) {
          const { data, error } = await supabase
            .from(table)
            .select(cols)
            .range(from, from + step - 1);
          if (error) throw error;
          out = out.concat(data || []);
          if (!data || data.length < step) break;
          from += step;
        }
        return out;
      };

      const [allPos, items, skus, mats, finds, chains, locks] = await Promise.all([
        fetchAll("running_line_purchase_orders", "*"),
        fetchAll("running_line_po_items", "*"),
        fetchAll(
          "running_line_skus",
          "sku_number,vendor_style_number,ssp_number,piece_cost_subtotal,discount_piece_cost_subtotal,vendor_discount_perc,total_net_weight,duty_rate,labor_delta,weight_delta,item_count,known_issue,known_issue_exact,last_scraped_at,updated_at"
        ),
        fetchAll(
          "running_line_materials",
          "ssp_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight,metal_base_price,metal_loss_percent,material_cost"
        ),
        fetchAll(
          "running_line_findings",
          "ssp_number,finding_type,finding_net_weight,metal_purity,metal_base_price,metal_loss_percent,finding_material_cost"
        ),
        fetchAll(
          "running_line_chains",
          "ssp_number,chain_type,chain_net_weight,metal_purity,metal_karat,metal_base_price,metal_loss_percent,chain_material_cost"
        ),
        fetchAll("metal_lock_history", "date,silver_lock,gold_lock"),
      ]);

      const skuMap = buildSkuMap(skus);
      const compMap = groupComponents(mats, finds, chains);
      const lockByDate = new Map((locks || []).map((l) => [l.date, l]));
      const itemsByPo = new Map();
      for (const it of items) {
        if (!itemsByPo.has(it.po_id)) itemsByPo.set(it.po_id, []);
        itemsByPo.get(it.po_id).push(it);
      }

      const BILL_UPCHARGE = 4; // Brian's standard upcharge on the rebill
      // Export date (ET) — stamped into each line's Memo cell per Brian.
      const exportMD = (() => {
        const iso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const p = iso.split("-");
        return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso;
      })();

      const header = [
        "PO #",
        "PO Date",
        "Ship Date",
        "Due Date",
        "Lock Date Used",
        "SKU",
        "Style #",
        "Qty",
        "Signet Price",
        "New Price",
        "Memo",
      ];
      const out = [header];

      const posForExport =
        onlyIds && onlyIds.size > 0
          ? allPos.filter((p) => onlyIds.has(p.id))
          : allPos;
      const sortedPos = [...posForExport].sort((a, b) =>
        String(b.po_date || "").localeCompare(String(a.po_date || ""))
      );
      for (const po of sortedPos) {
        const lines = (itemsByPo.get(po.id) || [])
          .slice()
          .sort((a, b) => (a.line_number || 0) - (b.line_number || 0));
        if (lines.length === 0) continue;
        const published = publishedLockFor(lockByDate, po.po_date);
        const impliedTariff = detectTariff(po, lines, skuMap, compMap, published);
        const { silverLock, goldLock, rows } = reconcilePO(
          po,
          lines,
          skuMap,
          compMap,
          impliedTariff,
          published
        );
        const chosenDate = po.lock_date || po.po_date || "";
        // Memo carries the EXPORT date (per Brian), not the QB import date.
        const memoCell = po.memo ? `updated ${exportMD} ${po.memo}` : "";
        // Tariff Brian actually bills at = the PO's stored tariff.
        const billTariff = Number(po.tariff_percent ?? 0);
        // New Price must equal what Brian sees when he opens the PO. The modal
        // fills new silver/gold from the EXACT published lock on the saved lock
        // date; if that date has no row (weekend/holiday), it leaves them at
        // today's spot. Mirror that exactly here.
        const exactLock = lockByDate.get(String(chosenDate).slice(0, 10));
        const billSilver =
          exactLock?.silver_lock != null
            ? Number(exactLock.silver_lock)
            : Number(prices?.silver?.price ?? 30);
        const billGold =
          exactLock?.gold_lock != null
            ? Number(exactLock.gold_lock)
            : Number(prices?.gold?.price ?? 2400);
        for (const r of rows) {
          // New bill at the saved lock — mirrors POLinesView: forward PO lines
          // (all of these) recompute from SSP at the lock; reverse lines anchor
          // on Signet's actual price. Then floor to Signet's billed price so we
          // never hand back a number below theirs.
          let newBill = null;
          if (r.sku && r.comps && r.comps.length > 0) {
            const lineLock =
              r.metal?.metalType === "Gold"
                ? goldLock
                : r.metal?.metalType === "Brass"
                  ? null
                  : silverLock;
            if (po.direction === "reverse" && r.line.unit_price != null) {
              newBill = rebillFromActualPrice(r.line, r.sku, r.comps, {
                oldTariffPct: billTariff,
                oldUpchargePct: Number(po.upcharge_percent ?? 0),
                oldLockRate: r.impliedRate || lineLock,
                newSilver: billSilver,
                newGold: billGold,
                newTariffPct: billTariff,
                newUpchargePct: BILL_UPCHARGE,
              });
            } else {
              newBill = recomputeSignetBill(r.sku, r.comps, {
                silver: billSilver,
                gold: billGold,
                tariffPct: billTariff,
                upchargePct: BILL_UPCHARGE,
              });
            }
            if (
              newBill != null &&
              r.line.unit_price != null &&
              Number(r.line.unit_price) > newBill
            ) {
              newBill = Number(r.line.unit_price);
            }
          }

          out.push([
            po.po_number || "",
            po.po_date || "",
            po.ship_date || "",
            po.due_date || "",
            chosenDate || "",
            r.line.sku_number || "",
            r.line.vendor_style_number || "",
            r.line.quantity ?? "",
            r.line.unit_price ?? "",
            newBill != null ? newBill.toFixed(2) : "",
            memoCell,
          ]);
        }
      }

      const csv = out.map((row) => row.map(csvEscape).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename =
        onlyIds && onlyIds.size > 0
          ? `PO_selected_lines_${stamp}.csv`
          : `PO_all_lines_${stamp}.csv`;
      if (await writeToFolder(docDir, filename, blob)) {
        showAlert(`Saved ${filename} to "${rebillFolderName || "your rebills folder"}"`, { variant: "success" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error("export failed:", e);
      showAlert(String(e?.message || e), { title: "Export failed", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Sales Orders</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a PO. Reconcile against SSP data, decode the metal lock, and
          recompute at any rate.
        </p>
      </div>

      {/* Uploader — no direction toggle, everything defaults to forward */}
      <POUploader
        direction="forward"
        onUploaded={(po) => setPos((prev) => [po, ...prev])}
      />

      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm font-medium text-gray-700">
            Past uploads {pos.length > 0 && <span className="text-gray-400">({filteredPos.length}/{pos.length})</span>}
          </div>
          <div className="flex items-center gap-1">
            {[
              ["open", `Open (${viewCounts.open})`],
              ["shipped", `Shipped (${viewCounts.shipped})`],
              ["all", `All (${viewCounts.all})`],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setViewFilter(key)}
                className={`text-xs px-2.5 py-1 rounded-full ${
                  viewFilter === key
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                title={key === "open"
                  ? "SOs not fully shipped out yet — partial, in transit, at HK, or nothing on the shipments board"
                  : key === "shipped"
                    ? "SOs fully shipped: every vendor PO closed, or manually marked shipped ✓"
                    : "Everything"}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1 max-w-md max-md:order-last max-md:basis-full max-md:max-w-none">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search PO number..."
                className="input w-full pl-8 text-sm"
              />
            </div>
          </div>
          {memoStatus && (
            <span className="text-xs text-gray-500 self-center whitespace-nowrap">{memoStatus}</span>
          )}
          {/* Every action lives in one menu. The header used to carry seven
              buttons, several of which appeared only with a selection — so it
              reflowed as you clicked. Items that don't apply are hidden
              rather than disabled, and the badge shows the selection count so
              the closed button still says what it will act on. */}
          <ActionMenu
            label="Actions"
            count={selectedIds.size}
            items={[
              { key: "sec-qb", section: "QuickBooks" },
              {
                key: "qb-create",
                label: qbBusy ? "Creating…" : "Create sales orders in QB",
                icon: Landmark,
                // Shown even with nothing selected. Hiding these made the
                // whole integration look like it had disappeared; a greyed
                // item that says what it needs reads as waiting, not broken.
                hidden: !qbOn,
                disabled: qbBusy || selectedIds.size === 0,
                busy: qbBusy,
                hint:
                  selectedIds.size === 0
                    ? "select POs first"
                    : `${selectedIds.size} selected · skips ones already in QB`,
                onClick: () => handleCreateSosInQb(),
              },
              {
                key: "qb-update",
                label: qbUpdateBusy
                  ? qbProgress
                    ? `${qbProgress.phase} ${qbProgress.done}/${qbProgress.total}…`
                    : "Working…"
                  : "Update sales orders in QB",
                icon: RefreshCw,
                hidden: !qbOn,
                disabled: qbUpdateBusy || selectedIds.size === 0,
                busy: qbUpdateBusy,
                hint:
                  selectedIds.size === 0
                    ? "select POs first"
                    : `${selectedIds.size} selected · review before sending`,
                onClick: () => handleUpdateSosInQb(),
              },
              {
                key: "sync-pos",
                label: memoSyncBusy ? "Syncing…" : "Sync POs from QuickBooks",
                icon: RefreshCw,
                hidden: !qbOn,
                disabled: memoSyncBusy,
                busy: memoSyncBusy,
                hint: "pulls open POs onto the shipments board",
                onClick: handleSyncMemos,
              },
              {
                key: "qb-off",
                label: "QuickBooks integration is off",
                icon: Landmark,
                hidden: qbOn,
                disabled: true,
                hint: "turn it on in Settings",
              },
              { key: "sec-export", section: "Export" },
              {
                key: "export-selected",
                label: exporting ? "Exporting…" : "Export selected lines",
                icon: Download,
                disabled: exporting || selectedIds.size === 0,
                hint:
                  selectedIds.size === 0
                    ? "select POs first"
                    : `${selectedIds.size} PO${selectedIds.size === 1 ? "" : "s"} to one CSV`,
                onClick: () => exportLines(selectedIds),
              },
              {
                key: "export-all",
                label: exporting ? "Exporting…" : "Export all lines",
                icon: Download,
                hidden: pos.length === 0,
                disabled: exporting,
                hint: "every PO, with tariff, lock and Signet-vs-predicted",
                onClick: () => exportLines(),
              },
              { key: "sec-data", section: "Data" },
              {
                key: "memo-upload",
                label: "Upload memo file…",
                icon: StickyNote,
                disabled: memoBusy,
                hint: "xlsx with Num + Memo columns",
                file: { accept: ".xlsx,.xls", onChange: handleMemoUpload },
              },
            ]}
          />
          {folderApiSupported() && (
            <span className="text-xs text-gray-500 self-center flex items-center gap-1.5 whitespace-nowrap">
              {rebillFolderName ? (
                <>
                  → <b className="text-gray-700">{rebillFolderName}</b>
                  <button onClick={chooseRebillFolder} className="text-blue-500 hover:underline">change</button>
                  <button onClick={forgetRebillFolder} title="Back to normal downloads"
                    className="text-gray-400 hover:text-gray-600">×</button>
                </>
              ) : (
                <button onClick={chooseRebillFolder} className="text-blue-500 hover:underline"
                  title="Pick the OneDrive ReBill From PLM folder — rebill CSVs save straight there instead of Downloads">
                  save exports to a folder…
                </button>
              )}
            </span>
          )}
        </div>
        {qbInterruptedJob && (
          <div className="px-4 py-2 border-b bg-amber-50 text-xs text-amber-800 flex items-center gap-3 flex-wrap">
            <span>
              A QuickBooks {qbInterruptedJob.type.startsWith("create") ? "create" : "update"} sync was{" "}
              {qbInterruptedJob.status === "cancelled" ? "stopped" : "interrupted"} at{" "}
              <b>
                {qbInterruptedJob.done}/{qbInterruptedJob.total}
              </b>
              .
            </span>
            <button
              onClick={resumeInterruptedJob}
              className="px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700"
            >
              Resume ({qbInterruptedJob.total - qbInterruptedJob.done} left)
            </button>
            <button
              onClick={() => useQbSyncJobStore.getState().dismissProcess(qbInterruptedJob.id)}
              className="ml-auto text-amber-400 hover:text-amber-600"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {qbSummary && (
          <div className="px-4 py-2 border-b bg-[#faf6ef] text-xs text-gray-700 flex items-start gap-3 flex-wrap">
            <span className="font-medium">QuickBooks:</span>
            <span className="text-green-700">{qbSummary.created.length} created</span>
            <span className="text-amber-700">{qbSummary.existed.length} already existed</span>
            {qbSummary.failed.length > 0 && (
              <span className="text-red-700">
                {qbSummary.failed.length} failed:{" "}
                {qbSummary.failed
                  .slice(0, 6)
                  .map((f) => `${f.po} (${f.error})`)
                  .join("; ")}
                {qbSummary.failed.length > 6 ? "…" : ""}
              </span>
            )}
            <button
              onClick={() => setQbSummary(null)}
              className="ml-auto text-gray-400 hover:text-gray-600"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {qbUpdateSummary && (
          <div className="px-4 py-2 border-b bg-[#faf6ef] text-xs text-gray-700 flex items-start gap-3 flex-wrap">
            <span className="font-medium">QuickBooks update:</span>
            <span className="text-green-700">{qbUpdateSummary.updated.length} updated</span>
            {qbUpdateSummary.unchanged?.length > 0 && (
              <span className="text-gray-500">
                {qbUpdateSummary.unchanged.length} already up to date
              </span>
            )}
            {qbUpdateSummary.updated.some((u) => u.orphans?.length) && (
              <span className="text-amber-700">
                ⚠ extra QB lines left untouched on{" "}
                {qbUpdateSummary.updated
                  .filter((u) => u.orphans?.length)
                  .map((u) => u.po)
                  .join(", ")}{" "}
                — check for duplicates
              </span>
            )}
            {qbUpdateSummary.notFound.length > 0 && (
              <span className="text-amber-700">
                {qbUpdateSummary.notFound.length} not in QB yet:{" "}
                {qbUpdateSummary.notFound.slice(0, 8).map((f) => f.po).join(", ")}
                {qbUpdateSummary.notFound.length > 8 ? "…" : ""}
              </span>
            )}
            {qbUpdateSummary.failed.length > 0 && (
              <span className="text-red-700">
                {qbUpdateSummary.failed.length} failed:{" "}
                {qbUpdateSummary.failed
                  .slice(0, 6)
                  .map((f) => `${f.po} (${f.error})`)
                  .join("; ")}
                {qbUpdateSummary.failed.length > 6 ? "…" : ""}
              </span>
            )}
            <button
              onClick={() => setQbUpdateSummary(null)}
              className="ml-auto text-gray-400 hover:text-gray-600"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : pos.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no purchase orders yet. upload one above to get started.
          </div>
        ) : (
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2 w-8">
                  <SelectAllCheckbox
                    total={visibleIds.length}
                    selected={visibleIds.filter((id) => selectedIds.has(id)).length}
                    onToggle={(checked) => setSelectedIds((prev) => {
                      const next = new Set(prev);
                      for (const id of visibleIds) checked ? next.add(id) : next.delete(id);
                      return next;
                    })}
                  />
                </th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("po_number")}>PO #{sortArrow("po_number")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("po_date")}>Date{sortArrow("po_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("ship_date")}>Ship Date{sortArrow("ship_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("due_date")}>Due Date{sortArrow("due_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("line_count")}>Lines{sortArrow("line_count")}</th>
                <th className="px-4 py-2">Tariff %</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("confidence_score")}>Confidence{sortArrow("confidence_score")}</th>
                <th className="px-4 py-2">Shipments</th>
                <th className="px-4 py-2 text-right cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("total_amount")}>Total{sortArrow("total_amount")}</th>
                <th className="px-4 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sortedPos.map((po) => {
                const ships = shipsBySO.get(String(po.po_number || "")) || [];
                const stages = ships.map((s) => stageOf(s));
                const shippedCount = stages.filter((s) => s !== "ordered").length;
                // marked_shipped_at = manual "fully shipped" override (old SOs
                // that predate the shipments board)
                const marked = !!po.marked_shipped_at;
                const allShipped = marked || (ships.length > 0 && shippedCount === ships.length);
                const allClosed = marked || (ships.length > 0 && stages.every((s) => s === "closed"));
                // whole-PO color (Brian 7/23): grey = fully done · GREEN = at
                // least one PO in transit RIGHT NOW (green beats blue) · BLUE =
                // anything sitting at Hong Kong · white = nothing moving (incl.
                // transit PO shipped out while other POs on the SO are still
                // open — drops back to white)
                const rowTint = allClosed
                  ? "opacity-40"
                  : stages.includes("in_transit")
                  ? "bg-green-50"
                  : stages.includes("hong_kong")
                  ? "bg-blue-50"
                  : "";
                return (
                <React.Fragment key={po.id}>
                <tr
                  className={`${selectedIds.has(po.id) ? "bg-amber-50 " : ""}hover:bg-gray-50 ${rowTint}`}
                >
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(po.id)}
                      onChange={() => toggleSelect(po.id)}
                      className="cursor-pointer align-middle"
                    />
                  </td>
                  <td
                    className="px-4 py-2 font-mono cursor-pointer whitespace-nowrap"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.po_number || "—"}
                    <QbStatusBadge po={po} />
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {fmtDate(po.po_date)}
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer whitespace-nowrap"
                    onClick={() => setSelectedPo(po)}
                  >
                    {fmtDate(po.ship_date)}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="date"
                      defaultValue={String(po.due_date || "").slice(0, 10)}
                      onBlur={(e) => updateDueDate(po, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      title="Cancel date — edit here when a buyer grants an extension"
                      className="px-1 py-0.5 border border-gray-200 rounded text-sm bg-transparent focus:border-[#C5A572] focus:outline-none"
                    />
                  </td>
                  <td
                    className="px-4 py-2 cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.line_count ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      defaultValue={po.tariff_percent ?? 0}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => updateTariff(po, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      className="w-16 px-1 py-0.5 border border-gray-200 rounded text-sm focus:border-[#C5A572] focus:outline-none"
                      step="0.1"
                    />
                    <span className="text-gray-500 ml-1">%</span>
                  </td>
                  <td
                    className={`px-4 py-2 cursor-pointer font-semibold ${confidenceColor(po.confidence_score)}`}
                    onClick={() => setSelectedPo(po)}
                    title="Open PO to recompute"
                  >
                    {po.confidence_score != null
                      ? `${Number(po.confidence_score).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    {marked ? (
                      <span
                        className="text-green-700 text-xs font-medium whitespace-nowrap"
                        title={`Marked fully shipped ${fmtDate(po.marked_shipped_at)}`}
                      >
                        shipped ✓
                      </span>
                    ) : ships.length === 0 ? (
                      <span className="text-gray-300 text-xs">—</span>
                    ) : (
                      <button
                        onClick={() => toggleShip(po.id)}
                        className={`flex items-center gap-1 text-xs font-medium ${allShipped ? "text-green-700" : "text-amber-700"} hover:underline`}
                      >
                        {expandedShip.has(po.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {shippedCount}/{ships.length} shipped
                      </button>
                    )}
                  </td>
                  <td
                    className="px-4 py-2 text-right cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {dollar(po.total_amount)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deletePo(po)}
                      disabled={deletingId === po.id}
                      className="text-gray-400 hover:text-red-600 disabled:opacity-50 max-md:p-2"
                      title="Delete PO"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
                {expandedShip.has(po.id) && (
                  <tr className="bg-gray-50/60">
                    <td />
                    <td colSpan={10} className="px-4 py-2">
                      <div className="space-y-0.5">
                        {(shipsBySO.get(String(po.po_number || "")) || []).map((s) => {
                          const st = shipStageText(s);
                          return (
                            <div key={s.vendor_po} className="text-xs flex items-center gap-2">
                              <span className="font-mono font-medium">{s.vendor_po}</span>
                              <span className="text-gray-600">{s.vendor || "—"}</span>
                              <span className={`font-medium ${st.cls}`}>{st.text}</span>
                              {s.carton_count ? <span className="text-gray-400">{s.carton_count} bx</span> : null}
                              {s.factory_shipped_at && stageOf(s) !== "ordered" ? (
                                <span className="text-gray-400">{fmtDate(s.factory_shipped_at)}</span>
                              ) : null}
                              {/* Named on this SO before, absent from the memo
                                  now. The row is deliberately left linked and
                                  intact — this is a prompt to check whether the
                                  memo edit was a mistake, not an auto-unlink. */}
                              {s.memo_unlinked_at ? (
                                <span
                                  className="text-amber-700 font-medium"
                                  title={`This vendor PO is no longer named in the QuickBooks memo (noticed ${fmtDate(s.memo_unlinked_at)}). It stays linked — check whether the memo was edited by mistake.`}
                                >
                                  ⚠ removed from memo {fmtDate(s.memo_unlinked_at)}
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedPo && (
        <POLinesView
          po={selectedPo}
          onClose={() => setSelectedPo(null)}
          onUpdate={(patch) => {
            // Sync any change made inside the modal (e.g. tariff edit) back
            // to the row in the list, in real-time.
            setPos((prev) =>
              prev.map((p) => (p.id === patch.id ? { ...p, ...patch } : p))
            );
            // Also keep selectedPo's local reference current so reopening
            // shows the latest value
            setSelectedPo((sp) => (sp && sp.id === patch.id ? { ...sp, ...patch } : sp));
          }}
        />
      )}

      {/* Batch update preview — everything that will change, before any of it
          is sent. The payloads shown here are the exact ones transmitted on
          confirm (see prepareSalesOrderUpdatesForPos / sendPrepared...). */}
      {qbPreview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Landmark className="w-4 h-4 text-[#C5A572]" />
                {qbPreview.mode === "create"
                  ? "Review new QuickBooks sales orders"
                  : "Review QuickBooks update"}
              </h2>
              <button
                onClick={() => setQbPreview(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                title="Cancel"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-2 border-b bg-[#faf6ef] text-xs text-gray-700 flex gap-3 flex-wrap">
              <span>
                <b>{qbPreview.prepared.length}</b> sales order
                {qbPreview.prepared.length === 1 ? "" : "s"}{" "}
                {qbPreview.mode === "create" ? "will be created" : "will change"}
              </span>
              {qbPreview.unchanged?.length > 0 && (
                <span className="text-gray-500">
                  {qbPreview.unchanged.length} already up to date (skipped)
                </span>
              )}
              {qbPreview.existed?.length > 0 && (
                <span className="text-gray-500">
                  {qbPreview.existed.length} already in QB (skipped)
                </span>
              )}
              {qbPreview.notFound?.length > 0 && (
                <span className="text-amber-700">
                  {qbPreview.notFound.length} not in QB yet (skipped)
                </span>
              )}
              {qbPreview.failed.length > 0 && (
                <span className="text-red-700">
                  {qbPreview.failed.length} couldn't be read
                </span>
              )}
            </div>

            <div className="overflow-auto px-5 py-3 flex-1 text-sm">
              {qbPreview.prepared.map((p) => (
                <div key={p.po.id} className="mb-4 last:mb-0">
                  <div className="font-medium text-gray-800 mb-1">PO {p.label}</div>
                  <div className="border rounded-md divide-y">
                    {/* create: every value as it will be written (nothing to
                        diff against — the sales order doesn't exist yet) */}
                    {qbPreview.mode === "create" &&
                      p.summary.header.map((h) => (
                        <div
                          key={h.field}
                          className="px-3 py-1.5 flex items-center gap-2 text-xs"
                        >
                          <span className="text-gray-500 w-44 flex-shrink-0">{h.label}</span>
                          <span className="text-gray-900 font-medium">{h.value}</span>
                        </div>
                      ))}
                    {qbPreview.mode === "create" &&
                      p.summary.lines.map((l, i) => (
                        <div key={`cl-${i}`} className="px-3 py-1.5 text-xs">
                          <span className="font-mono text-gray-700">{l.item}</span>
                          <span className="text-gray-500">
                            {" "}· qty {l.quantity ?? "—"} @ {l.rate ?? "—"}
                            {l.other1 ? ` · Other1 ${l.other1}` : ""}
                          </span>
                        </div>
                      ))}
                    {qbPreview.mode !== "create" &&
                      p.diff.header.map((h) => (
                      <div
                        key={h.field}
                        className="px-3 py-1.5 flex items-center gap-2 text-xs"
                      >
                        <span className="text-gray-500 w-44 flex-shrink-0">{h.label}</span>
                        <span className="text-gray-400 line-through">{h.from ?? "—"}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-gray-900 font-medium">{h.to}</span>
                      </div>
                    ))}
                    {qbPreview.mode !== "create" &&
                      p.diff.lines.map((l) => (
                      <div key={l.txn_line_id} className="px-3 py-1.5 text-xs">
                        <div className="font-mono text-gray-700">
                          {l.item}
                          {l.sku ? (
                            <span className="text-gray-400"> · SKU {l.sku}</span>
                          ) : null}
                        </div>
                        {l.fields.map((f) => (
                          <div key={f.field} className="flex items-center gap-2 pl-3 mt-0.5">
                            <span className="text-gray-500 w-20 flex-shrink-0">{f.field}</span>
                            <span className="text-gray-400 line-through">{f.from ?? "—"}</span>
                            <span className="text-gray-400">→</span>
                            <span className="text-gray-900 font-medium">{f.to}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {qbPreview.mode !== "create" &&
                      p.diff.addLines.map((a, i) => (
                      <div key={`add-${i}`} className="px-3 py-1.5 text-xs text-blue-700">
                        + new line {a.item} · qty {a.quantity ?? "—"} @ {a.rate ?? "—"}
                      </div>
                    ))}
                    {qbPreview.mode !== "create" && p.orphans.length > 0 && (
                      <div className="px-3 py-1.5 text-xs text-amber-700">
                        ⚠ {p.orphans.length} extra line
                        {p.orphans.length === 1 ? "" : "s"} in QuickBooks with no PLM
                        match — left untouched (
                        {p.orphans.map((o) => `${o.item ?? "?"} @ ${o.rate ?? "?"}`).join(", ")})
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {qbPreview.failed.length > 0 && (
                <div className="mt-3 text-xs text-red-700">
                  {qbPreview.failed.map((f) => (
                    <div key={f.po}>
                      PO {f.po}: {f.error}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                {qbProgress
                  ? `${qbProgress.phase} ${qbProgress.done}/${qbProgress.total}…`
                  : "Nothing has been sent to QuickBooks yet."}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setQbPreview(null)}
                  disabled={previewBusy}
                  className="px-4 py-2 rounded border text-sm disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={qbPreview.mode === "create" ? sendQbCreatePreview : sendQbPreview}
                  disabled={previewBusy}
                  className="px-5 py-2 rounded bg-[#C5A572] text-white text-sm disabled:opacity-50"
                >
                  {previewBusy
                    ? (qbPreview.mode === "create" ? "Creating…" : "Sending…")
                    : qbPreview.mode === "create"
                      ? `Create ${qbPreview.prepared.length} in QuickBooks`
                      : `Send ${qbPreview.prepared.length} to QuickBooks`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
