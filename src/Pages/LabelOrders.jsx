import React, { useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  RefreshCw,
  Tag,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";
import {
  attributeLine,
  buildBatches,
  downloadBlob,
  generateLabelFileBlob,
  labelFileName,
  normalizeModel,
  vendorLabelFor,
} from "../utils/labelOrderUtils";

const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];

export default function LabelOrders() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]); // signet_pos_latest live lines
  const [soVendorsByPo, setSoVendorsByPo] = useState({});
  const [vendorsById, setVendorsById] = useState({});
  const [aliasMap, setAliasMap] = useState({});
  const [sampleMaps, setSampleMaps] = useState({ exactMap: {}, strippedMap: {} });
  const [labelOrders, setLabelOrders] = useState([]);

  const [selectedPos, setSelectedPos] = useState({});
  const [expandedPos, setExpandedPos] = useState({});
  const [hideOrdered, setHideOrdered] = useState(true);
  const [review, setReview] = useState(null); // { items: [...] } pending assignment
  const [result, setResult] = useState(null); // batches just generated
  const [busy, setBusy] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [posRes, shipRes, vendRes, aliasRes, sampRes, siRes, ordRes] =
        await Promise.all([
          supabase
            .from("signet_pos_latest")
            .select("po_number, sku, model, order_qty, order_status, order_date")
            .in("order_status", LIVE_STATUSES)
            .order("order_date", { ascending: false }),
          supabase
            .from("shipments")
            .select("signet_po_number, vendor_po, vendor")
            .is("deleted_at", null),
          supabase.from("vendors").select("id, name"),
          supabase.from("model_aliases").select("alias, vendor_id"),
          supabase.from("samples").select("styleNumber, starting_info_id"),
          supabase.from("starting_info").select("id, vendor"),
          supabase
            .from("label_orders")
            .select(
              "po_number, sku, qty, batch_id, batch_tag, vendor_label, ordered_at"
            )
            .order("ordered_at", { ascending: false }),
        ]);
      const firstError =
        posRes.error || shipRes.error || vendRes.error || aliasRes.error ||
        sampRes.error || siRes.error || ordRes.error;
      if (firstError) throw firstError;

      setLines(posRes.data || []);

      const so = {};
      for (const s of shipRes.data || []) {
        if (!s.signet_po_number || !s.vendor_po) continue;
        const label = vendorLabelFor(s.vendor);
        if (!label) continue;
        const po = (so[s.signet_po_number] ??= {});
        (po[label] ??= []).push(String(s.vendor_po));
      }
      setSoVendorsByPo(so);

      const vById = {};
      for (const v of vendRes.data || []) vById[v.id] = v;
      setVendorsById(vById);

      const aMap = {};
      for (const a of aliasRes.data || []) aMap[normalizeModel(a.alias)] = a.vendor_id;
      setAliasMap(aMap);

      const siVendor = {};
      for (const si of siRes.data || []) siVendor[si.id] = si.vendor;
      const exactMap = {};
      const strippedMap = {};
      for (const s of sampRes.data || []) {
        const vId = siVendor[s.starting_info_id];
        if (!vId || !s.styleNumber) continue;
        const norm = normalizeModel(s.styleNumber);
        // exact map: first write wins (styleNumber is unique anyway)
        if (!(norm in exactMap)) exactMap[norm] = vId;
        const stripped = norm.replace(/-NEW$/i, "").replace(/\/[0-9.]+$/, "");
        if (!(stripped in strippedMap)) strippedMap[stripped] = vId;
      }
      setSampleMaps({ exactMap, strippedMap });

      setLabelOrders(ordRes.data || []);
    } catch (e) {
      console.log("LabelOrders fetch error", e);
      showMessage("Failed to load label ordering data: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supabase) fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  // ordered state per (po, sku)
  const orderedBySku = useMemo(() => {
    const m = {};
    for (const o of labelOrders) {
      const k = `${o.po_number}|${o.sku}`;
      if (!m[k]) m[k] = o; // newest first from query order
    }
    return m;
  }, [labelOrders]);

  const attributed = useMemo(() => {
    const ctx = { aliasMap, soVendorsByPo, vendorsById, ...sampleMaps };
    return lines.map((l) => {
      const a = attributeLine(l, ctx);
      const ordered = orderedBySku[`${l.po_number}|${l.sku}`] || null;
      return {
        ...a,
        ordered,
        qtyChanged:
          ordered && Number(ordered.qty) !== Number(l.order_qty) ? true : false,
      };
    });
  }, [lines, aliasMap, soVendorsByPo, vendorsById, sampleMaps, orderedBySku]);

  const poGroups = useMemo(() => {
    const byPo = {};
    for (const l of attributed) {
      const g = (byPo[l.po_number] ??= {
        po: l.po_number,
        date: l.order_date,
        lines: [],
      });
      g.lines.push(l);
    }
    const groups = Object.values(byPo).map((g) => {
      const orderedCount = g.lines.filter((l) => l.ordered).length;
      const units = g.lines.reduce((s, l) => s + Number(l.order_qty || 0), 0);
      const vendors = [...new Set(g.lines.map((l) => l.vendorLabel || "?"))];
      const qtyChanged = g.lines.some((l) => l.qtyChanged);
      const needsReview = g.lines.some((l) => l.needsReview);
      return {
        ...g,
        units,
        vendors,
        qtyChanged,
        needsReview,
        status:
          orderedCount === 0
            ? "not ordered"
            : orderedCount === g.lines.length
              ? "ordered"
              : "partial",
      };
    });
    return groups.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [attributed]);

  const visibleGroups = poGroups.filter(
    (g) => !hideOrdered || g.status !== "ordered"
  );
  const selectedGroups = visibleGroups.filter((g) => selectedPos[g.po]);

  const toggleAllVisible = (checked) => {
    const next = {};
    if (checked) for (const g of visibleGroups) next[g.po] = true;
    setSelectedPos(next);
  };

  // ---------- generation flow ----------

  const startGenerate = () => {
    if (selectedGroups.length === 0) {
      showMessage("Select at least one sales order first");
      return;
    }
    // only lines not already ordered go into the batch
    const targetLines = selectedGroups
      .flatMap((g) => g.lines)
      .filter((l) => !l.ordered);
    if (targetLines.length === 0) {
      showMessage("Labels for every line on the selected orders were already ordered");
      return;
    }
    const toReview = targetLines.filter((l) => l.needsReview);
    if (toReview.length > 0) {
      // unique per model — one decision covers every line of that style
      const seen = {};
      const items = [];
      for (const l of toReview) {
        const key = normalizeModel(l.model);
        if (seen[key]) continue;
        seen[key] = true;
        items.push({
          model: l.model,
          reason: l.reviewReason,
          suggestedVendorId: l.vendorId || "",
          vendorId: l.vendorId || "",
          saveAlias: true,
        });
      }
      setReview({ items, targetLines });
      return;
    }
    finishGenerate(targetLines, []);
  };

  const finishGenerate = async (targetLines, aliasDecisions) => {
    setBusy(true);
    setReview(null);
    try {
      // apply manual decisions
      const decisionByModel = {};
      for (const d of aliasDecisions) {
        if (!d.vendorId) continue;
        decisionByModel[normalizeModel(d.model)] = Number(d.vendorId);
      }
      const finalLines = targetLines
        .map((l) => {
          const manual = decisionByModel[normalizeModel(l.model)];
          if (manual) {
            const v = vendorsById[manual];
            return {
              ...l,
              vendorId: manual,
              vendorLabel: v ? vendorLabelFor(v.name) : l.vendorLabel,
              needsReview: false,
            };
          }
          return l;
        })
        .filter((l) => l.vendorId && !l.needsReview);

      const skipped = targetLines.length - finalLines.length;
      const batches = buildBatches(finalLines, soVendorsByPo);
      if (batches.length === 0) {
        showMessage("Nothing to order — no line resolved to a vendor");
        setBusy(false);
        return;
      }

      // save new aliases (upsert so re-deciding a style just updates it)
      const aliasRows = aliasDecisions
        .filter((d) => d.saveAlias && d.vendorId)
        .map((d) => ({
          alias: normalizeModel(d.model),
          vendor_id: Number(d.vendorId),
          note: "assigned in Label Orders page",
        }));
      if (aliasRows.length > 0) {
        const { error } = await supabase
          .from("model_aliases")
          .upsert(aliasRows, { onConflict: "alias" });
        if (error) throw error;
      }

      // generate + download one file per vendor, then record the batch
      const allRows = [];
      for (const b of batches) {
        const blob = await generateLabelFileBlob(b.skuRows);
        b.fileName = labelFileName(b.vendorLabel);
        downloadBlob(blob, b.fileName);
        const batchId = uuidv4();
        b.batchId = batchId;
        for (const l of b.lines) {
          allRows.push({
            batch_id: batchId,
            batch_tag: b.batchTag,
            vendor_id: b.vendorId || null,
            vendor_label: b.vendorLabel,
            po_number: l.po_number,
            sku: l.sku,
            model: l.model,
            qty: Number(l.order_qty || 0),
          });
        }
      }
      const { error: insErr } = await supabase.from("label_orders").insert(allRows);
      if (insErr) throw insErr;

      setResult({ batches, skipped });
      setSelectedPos({});
      await fetchAll();
      showMessage(
        `Generated ${batches.length} label order file${batches.length > 1 ? "s" : ""}`
      );
    } catch (e) {
      console.log("label generate error", e);
      showMessage("Label order failed: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- batch history ----------

  const batchHistory = useMemo(() => {
    const byBatch = {};
    for (const o of labelOrders) {
      const b = (byBatch[o.batch_id] ??= {
        batchId: o.batch_id,
        tag: o.batch_tag,
        vendorLabel: o.vendor_label,
        orderedAt: o.ordered_at,
        rows: [],
      });
      b.rows.push(o);
    }
    return Object.values(byBatch)
      .sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))
      .slice(0, 12);
  }, [labelOrders]);

  const redownloadBatch = async (batch) => {
    const qtyBySku = {};
    for (const r of batch.rows) qtyBySku[r.sku] = (qtyBySku[r.sku] || 0) + r.qty;
    const skuRows = Object.entries(qtyBySku)
      .map(([sku, qty]) => ({ sku, qty }))
      .sort((a, b) => a.sku.localeCompare(b.sku));
    const blob = await generateLabelFileBlob(skuRows);
    downloadBlob(blob, labelFileName(batch.vendorLabel, new Date(batch.orderedAt)));
  };

  const undoBatch = async (batch) => {
    if (
      !window.confirm(
        `Un-mark "${batch.tag}" (${batch.rows.length} lines) as ordered? Do this only if the order was never placed in FineLine.`
      )
    )
      return;
    const { error } = await supabase
      .from("label_orders")
      .delete()
      .eq("batch_id", batch.batchId);
    if (error) showMessage("Undo failed: " + error.message);
    else {
      showMessage("Batch removed — lines show as not ordered again");
      fetchAll();
    }
  };

  const copyTag = (tag) => {
    navigator.clipboard?.writeText(tag);
    showMessage("Internal PO tag copied");
  };

  // ---------- render ----------

  if (loading) return <Loading />;

  const badge = (status) =>
    status === "ordered"
      ? "bg-green-100 text-green-800"
      : status === "partial"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-gray-200 text-gray-700";

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-4 max-md:flex-col max-md:items-start max-md:gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Tag className="w-6 h-6 text-[#C5A572]" /> Label Orders
        </h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={hideOrdered}
              onChange={(e) => setHideOrdered(e.target.checked)}
            />
            Hide fully ordered
          </label>
          <button
            onClick={fetchAll}
            className="p-2 rounded hover:bg-gray-200"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={startGenerate}
            disabled={busy || selectedGroups.length === 0}
            className="bg-[#C5A572] text-white px-4 py-2 rounded disabled:opacity-40"
          >
            {busy
              ? "Working..."
              : `Order labels (${selectedGroups.length} SO${selectedGroups.length === 1 ? "" : "s"})`}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-3">
        Live Banter/Pagoda sales orders from the Signet scrape. Select orders,
        click Order labels — you get one FineLine upload file per vendor plus the
        internal PO tag to paste at checkout. Lines already ordered are skipped
        automatically.
      </p>

      {/* result panel */}
      {result && (
        <div className="mb-4 border border-green-300 bg-green-50 rounded p-4">
          <div className="font-medium mb-2">
            Files generated — upload each in FASTtrak, and paste its internal PO
            tag on the shipping page:
          </div>
          {result.batches.map((b) => (
            <div
              key={b.vendorLabel}
              className="flex items-center gap-3 py-1 text-sm max-md:flex-wrap"
            >
              <span className="font-medium w-16">{b.vendorLabel}</span>
              <span>{b.skuRows.length} SKUs</span>
              <span>{b.units.toLocaleString()} units</span>
              <code className="bg-white border px-2 py-0.5 rounded">{b.batchTag}</code>
              <button
                onClick={() => copyTag(b.batchTag)}
                className="p-1 hover:bg-green-100 rounded"
                title="Copy tag"
              >
                <Copy className="w-4 h-4" />
              </button>
              <span className="text-gray-500">{b.fileName}</span>
            </div>
          ))}
          {result.skipped > 0 && (
            <div className="text-sm text-yellow-800 mt-2">
              {result.skipped} line(s) skipped (no vendor assigned).
            </div>
          )}
          <button
            onClick={() => setResult(null)}
            className="text-sm text-gray-500 underline mt-2"
          >
            dismiss
          </button>
        </div>
      )}

      {/* PO table */}
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2 w-8">
                <input
                  type="checkbox"
                  checked={
                    visibleGroups.length > 0 &&
                    selectedGroups.length === visibleGroups.length
                  }
                  onChange={(e) => toggleAllVisible(e.target.checked)}
                />
              </th>
              <th className="p-2">Sales order</th>
              <th className="p-2">PO date</th>
              <th className="p-2 text-right">Lines</th>
              <th className="p-2 text-right">Units</th>
              <th className="p-2">Vendors</th>
              <th className="p-2">Labels</th>
              <th className="p-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((g) => (
              <React.Fragment key={g.po}>
                <tr
                  className="border-b hover:bg-gray-50 cursor-pointer"
                  onClick={() =>
                    setExpandedPos((p) => ({ ...p, [g.po]: !p[g.po] }))
                  }
                >
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!selectedPos[g.po]}
                      onChange={(e) =>
                        setSelectedPos((p) => ({ ...p, [g.po]: e.target.checked }))
                      }
                    />
                  </td>
                  <td className="p-2 font-medium">{g.po}</td>
                  <td className="p-2">{g.date}</td>
                  <td className="p-2 text-right">{g.lines.length}</td>
                  <td className="p-2 text-right">{g.units.toLocaleString()}</td>
                  <td className="p-2">{g.vendors.join(", ")}</td>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${badge(g.status)}`}>
                      {g.status}
                    </span>
                    {g.needsReview && (
                      <span title="has lines with no confirmed vendor">
                        <TriangleAlert className="w-4 h-4 text-yellow-600 inline ml-1" />
                      </span>
                    )}
                    {g.qtyChanged && (
                      <span className="ml-1 px-2 py-0.5 rounded text-xs bg-red-100 text-red-700">
                        qty changed
                      </span>
                    )}
                  </td>
                  <td className="p-2">
                    {expandedPos[g.po] ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </td>
                </tr>
                {expandedPos[g.po] && (
                  <tr className="border-b bg-gray-50">
                    <td></td>
                    <td colSpan={7} className="p-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="p-1">SKU</th>
                            <th className="p-1">Style</th>
                            <th className="p-1 text-right">Qty</th>
                            <th className="p-1">Vendor</th>
                            <th className="p-1">Labels</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.lines.map((l) => (
                            <tr key={l.sku} className="border-t border-gray-200">
                              <td className="p-1">{l.sku}</td>
                              <td className="p-1">{l.model}</td>
                              <td className="p-1 text-right">
                                {Number(l.order_qty).toLocaleString()}
                                {l.qtyChanged && (
                                  <span className="text-red-600 ml-1">
                                    (was {l.ordered.qty})
                                  </span>
                                )}
                              </td>
                              <td className="p-1">
                                {l.vendorLabel || "?"}
                                {l.needsReview && (
                                  <span
                                    className="text-yellow-700 ml-1"
                                    title={l.reviewReason}
                                  >
                                    ⚠ {l.reviewReason}
                                  </span>
                                )}
                              </td>
                              <td className="p-1">
                                {l.ordered ? (
                                  <span
                                    title={l.ordered.batch_tag}
                                    className="text-green-700"
                                  >
                                    ordered{" "}
                                    {new Date(
                                      l.ordered.ordered_at
                                    ).toLocaleDateString()}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">not ordered</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {visibleGroups.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-gray-400">
                  No open sales orders with unordered labels.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* batch history */}
      <h2 className="text-lg font-medium mt-8 mb-2">Recent label orders</h2>
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2">Ordered</th>
              <th className="p-2">Vendor</th>
              <th className="p-2">Internal PO tag</th>
              <th className="p-2 text-right">Lines</th>
              <th className="p-2 text-right">Units</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {batchHistory.map((b) => (
              <tr key={b.batchId} className="border-b">
                <td className="p-2">
                  {new Date(b.orderedAt).toLocaleDateString()}
                </td>
                <td className="p-2">{b.vendorLabel}</td>
                <td className="p-2">
                  <code>{b.tag}</code>
                  <button
                    onClick={() => copyTag(b.tag)}
                    className="p-1 hover:bg-gray-100 rounded ml-1"
                    title="Copy tag"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </td>
                <td className="p-2 text-right">{b.rows.length}</td>
                <td className="p-2 text-right">
                  {b.rows.reduce((s, r) => s + r.qty, 0).toLocaleString()}
                </td>
                <td className="p-2 text-right">
                  <button
                    onClick={() => redownloadBatch(b)}
                    className="p-1 hover:bg-gray-100 rounded"
                    title="Download file again"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => undoBatch(b)}
                    className="p-1 hover:bg-gray-100 rounded ml-1"
                    title="Undo (only if never placed in FineLine)"
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </button>
                </td>
              </tr>
            ))}
            {batchHistory.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-400">
                  No label orders recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* review modal */}
      {review && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-5">
            <h3 className="text-lg font-medium mb-1">Assign vendors</h3>
            <p className="text-sm text-gray-500 mb-4">
              These styles have no confirmed vendor. Pick once — saved styles
              never ask again.
            </p>
            {review.items.map((item, i) => (
              <div
                key={item.model}
                className="flex items-center gap-3 py-2 border-b max-md:flex-wrap"
              >
                <div className="w-48 font-medium">{item.model}</div>
                <select
                  value={item.vendorId}
                  onChange={(e) =>
                    setReview((r) => {
                      const items = [...r.items];
                      items[i] = { ...items[i], vendorId: e.target.value };
                      return { ...r, items };
                    })
                  }
                  className="border rounded px-2 py-1"
                >
                  <option value="">— skip this style —</option>
                  {Object.values(vendorsById)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {vendorLabelFor(v.name)}
                      </option>
                    ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={item.saveAlias}
                    onChange={(e) =>
                      setReview((r) => {
                        const items = [...r.items];
                        items[i] = { ...items[i], saveAlias: e.target.checked };
                        return { ...r, items };
                      })
                    }
                  />
                  remember
                </label>
                {item.reason && (
                  <span className="text-xs text-yellow-700">{item.reason}</span>
                )}
              </div>
            ))}
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setReview(null)}
                className="px-4 py-2 rounded border"
              >
                Cancel
              </button>
              <button
                onClick={() => finishGenerate(review.targetLines, review.items)}
                className="px-4 py-2 rounded bg-[#C5A572] text-white"
                disabled={busy}
              >
                {busy ? "Working..." : "Generate files"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
