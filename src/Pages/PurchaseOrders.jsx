import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import POUploader from "../components/RunningLines/POUploader";
import POLinesView from "../components/RunningLines/POLinesView";
import { reconcilePO, detectTariff, buildSkuMap, groupComponents, publishedLockFor } from "../utils/reconcilePOLines";
import { Trash2, Search, Download } from "lucide-react";

export default function PurchaseOrders() {
  const { supabase } = useSupabase();
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPo, setSelectedPo] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState({ key: "po_date", dir: "desc" });
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data, error } = await supabase
        .from("running_line_purchase_orders")
        .select("*")
        .order("po_date", { ascending: false });
      if (error) console.error(error.message);
      setPos(data ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  const dollar = (n) =>
    n == null
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

  const filteredPos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pos;
    return pos.filter((p) => String(p.po_number || "").toLowerCase().includes(q));
  }, [pos, search]);

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
    if (!confirm(`Delete PO ${po.po_number || po.id.slice(0, 8)}? This can't be undone.`)) return;
    setDeletingId(po.id);
    // Delete line items first, then the PO itself.
    const { error: e1 } = await supabase
      .from("running_line_po_items")
      .delete()
      .eq("po_id", po.id);
    if (e1) {
      console.error("delete items failed:", e1.message);
      alert("Failed to delete line items: " + e1.message);
      setDeletingId(null);
      return;
    }
    const { error: e2 } = await supabase
      .from("running_line_purchase_orders")
      .delete()
      .eq("id", po.id);
    if (e2) {
      console.error("delete PO failed:", e2.message);
      alert("Failed to delete PO: " + e2.message);
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
      alert("Failed to update tariff: " + error.message);
      return;
    }
    setPos((prev) =>
      prev.map((p) =>
        p.id === po.id ? { ...p, tariff_percent: newTariff, confidence_score: null } : p
      )
    );
  }

  async function clearAll() {
    if (!supabase) return;
    if (!confirm(`Delete ALL ${pos.length} purchase orders? This can't be undone.`)) return;
    if (!confirm("Are you sure? This will wipe every PO and its line items.")) return;
    // Bulk delete: items first, then POs.
    const { error: e1 } = await supabase
      .from("running_line_po_items")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (e1) {
      alert("Failed to delete items: " + e1.message);
      return;
    }
    const { error: e2 } = await supabase
      .from("running_line_purchase_orders")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (e2) {
      alert("Failed to delete POs: " + e2.message);
      return;
    }
    setPos([]);
    setSelectedIds(new Set());
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
      // Lock for a chosen date: exact match, walking back up to 7 days to catch
      // weekly / forward-filled locks if the exact day has no row.
      const lockOnOrBefore = (dateStr) => {
        if (!dateStr) return null;
        let d = dateStr;
        for (let j = 0; j <= 7; j++) {
          const row = lockByDate.get(d);
          if (row) return row;
          const x = new Date(`${d}T00:00:00Z`);
          x.setUTCDate(x.getUTCDate() - 1);
          d = x.toISOString().slice(0, 10);
        }
        return null;
      };
      const itemsByPo = new Map();
      for (const it of items) {
        if (!itemsByPo.has(it.po_id)) itemsByPo.set(it.po_id, []);
        itemsByPo.get(it.po_id).push(it);
      }

      const header = [
        "PO #",
        "PO Date",
        "Ship Date",
        "Due Date",
        "Stored Tariff %",
        "Implied Tariff %",
        "Implied Silver Lock",
        "Implied Gold Lock",
        "Lock Date Used",
        "SKU",
        "Style #",
        "Description",
        "Metal",
        "Qty",
        "Signet Price",
        "Predicted Price",
        "Signet vs Predicted",
        "Abs Diff",
        "Anomaly >10c",
        "Line Implied $/oz",
        "Lock $/oz @ date",
        "Reconcile",
        "Known Issue",
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
        const chosenLockRow = lockOnOrBefore(chosenDate);
        for (const r of rows) {
          const diff = r.signetVsOurs;
          const absd = diff != null ? Math.abs(diff) : null;
          out.push([
            po.po_number || "",
            po.po_date || "",
            po.ship_date || "",
            po.due_date || "",
            po.tariff_percent ?? 0,
            impliedTariff,
            silverLock != null ? silverLock.toFixed(2) : "",
            goldLock != null ? goldLock.toFixed(2) : "",
            chosenDate || "",
            r.line.sku_number || "",
            r.line.vendor_style_number || "",
            r.line.description || "",
            r.metal ? `${r.metal.metalType} ${r.metal.karat || ""}`.trim() : "",
            r.line.quantity ?? "",
            r.line.unit_price ?? "",
            r.predicted != null ? r.predicted.toFixed(2) : "",
            diff != null ? diff.toFixed(2) : "",
            absd != null ? absd.toFixed(2) : "",
            absd != null && absd > 0.1 ? "YES" : "",
            r.impliedRate ? r.impliedRate.toFixed(2) : "",
            (() => {
              const mt = r.metal?.metalType;
              const v =
                mt === "Silver"
                  ? chosenLockRow?.silver_lock
                  : mt === "Gold"
                    ? chosenLockRow?.gold_lock
                    : null;
              return v != null ? Number(v).toFixed(2) : "";
            })(),
            !r.sku
              ? "NO SSP MATCH"
              : r.reconcile === true
                ? "OK"
                : r.reconcile === false
                  ? r.sku.known_issue
                    ? "KNOWN ISSUE"
                    : "MISMATCH"
                  : "",
            r.sku?.known_issue
              ? r.sku.known_issue_exact
                ? r.sku.known_issue
                : "Flagged — cause not confirmed to the penny"
              : "",
          ]);
        }
      }

      const csv = out.map((row) => row.map(csvEscape).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download =
        onlyIds && onlyIds.size > 0
          ? `PO_selected_lines_${stamp}.csv`
          : `PO_all_lines_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("export failed:", e);
      alert("Export failed: " + (e?.message || e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Purchase Orders</h1>
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
          <div className="flex items-center gap-2 flex-1 max-w-md">
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
          {selectedIds.size > 0 && (
            <button
              onClick={() => exportLines(selectedIds)}
              disabled={exporting}
              className="text-xs px-3 py-1.5 bg-[#C5A572] hover:bg-[#B89660] text-white rounded inline-flex items-center gap-1 disabled:opacity-50"
              title="Export only the selected POs' lines to one CSV"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? "Exporting…" : `Export selected (${selectedIds.size})`}
            </button>
          )}
          {pos.length > 0 && (
            <button
              onClick={() => exportLines()}
              disabled={exporting}
              className="text-xs px-3 py-1.5 bg-white border border-[#C5A572] text-[#9a7b48] hover:bg-[#faf6ef] rounded inline-flex items-center gap-1 disabled:opacity-50"
              title="Export every PO's lines (with implied tariff, lock, and Signet-vs-predicted) to one CSV"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? "Exporting…" : "Export all lines"}
            </button>
          )}
          {pos.length > 0 && (
            <button
              onClick={clearAll}
              className="text-xs text-red-600 hover:text-red-700 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : pos.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no purchase orders yet. upload one above to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                    }}
                    onChange={toggleSelectAllVisible}
                    className="cursor-pointer align-middle"
                    title="Select all"
                  />
                </th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("po_number")}>PO #{sortArrow("po_number")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("po_date")}>Date{sortArrow("po_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("ship_date")}>Ship Date{sortArrow("ship_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("due_date")}>Due Date{sortArrow("due_date")}</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("line_count")}>Lines{sortArrow("line_count")}</th>
                <th className="px-4 py-2">Tariff %</th>
                <th className="px-4 py-2 cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("confidence_score")}>Confidence{sortArrow("confidence_score")}</th>
                <th className="px-4 py-2 text-right cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort("total_amount")}>Total{sortArrow("total_amount")}</th>
                <th className="px-4 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sortedPos.map((po) => (
                <tr
                  key={po.id}
                  className={`${selectedIds.has(po.id) ? "bg-amber-50 " : ""}hover:bg-gray-50`}
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
                    className="px-4 py-2 font-mono cursor-pointer"
                    onClick={() => setSelectedPo(po)}
                  >
                    {po.po_number || "—"}
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
                  <td
                    className="px-4 py-2 cursor-pointer whitespace-nowrap"
                    onClick={() => setSelectedPo(po)}
                  >
                    {fmtDate(po.due_date)}
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
                      className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                      title="Delete PO"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
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
    </div>
  );
}
