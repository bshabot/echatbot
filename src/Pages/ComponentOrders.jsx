import React, { useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Link2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";
import { createPurchaseOrder, QbError } from "../utils/qbClient";
import {
  attributeLine,
  normalizeModel,
  vendorLabelFor,
} from "../utils/labelOrderUtils";
import {
  COMPONENTS,
  buildComponentBatches,
  buildSpecMaps,
  componentsForLine,
} from "../utils/componentOrderUtils";

const LIVE_STATUSES = ["ACKNOWLEDGED", "MODIFIED", "NEW"];

export default function ComponentOrders() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();

  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]);
  const [soVendorsByPo, setSoVendorsByPo] = useState({});
  const [vendorsById, setVendorsById] = useState({});
  const [aliasMap, setAliasMap] = useState({});
  const [sampleMaps, setSampleMaps] = useState({ exactMap: {}, strippedMap: {} });
  const [backHints, setBackHints] = useState({}); // style -> {back_type, qty}
  const [specMaps, setSpecMaps] = useState({ exact: {}, stripped: {} });
  const [orders, setOrders] = useState([]);
  const [itemCatalog, setItemCatalog] = useState({}); // component key -> QB item

  const [selectedPos, setSelectedPos] = useState({});
  const [expandedPos, setExpandedPos] = useState({});
  const [hideOrdered, setHideOrdered] = useState(true);
  const [review, setReview] = useState(null);
  // sales orders the current on-screen component PO was built from.
  // null = nothing generated yet (pick orders, hit Generate).
  const [generatedFor, setGeneratedFor] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  // reset the QB-create state whenever a new order is generated (or cleared)
  // so a stale "created PO #x" badge doesn't linger onto a different order.
  useEffect(() => {
    setPoCreate({ busy: false, created: null, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedFor]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [posRes, shipRes, vendRes, aliasRes, sampRes, siRes, specRes, itemRes, ordRes] =
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
          supabase.from("vendors").select("id, name, supplies_own_components"),
          supabase.from("model_aliases").select("alias, vendor_id"),
          supabase
            .from("samples")
            .select("styleNumber, starting_info_id, back_type, back_type_quantity"),
          supabase.from("starting_info").select("id, vendor"),
          supabase
            .from("component_specs")
            .select("model, display_model, sb, scb, chain, gp_sb, back_note, source"),
          supabase
            .from("component_items")
            .select("component, item_code, description, unit_cost, supplier, sort_order"),
          supabase
            .from("component_orders")
            .select(
              "po_number, sku, model, qty, sb, scb, chain, gp_sb, batch_id, batch_tag, vendor_label, ordered_at"
            )
            .order("ordered_at", { ascending: false }),
        ]);
      const firstError =
        posRes.error || shipRes.error || vendRes.error || aliasRes.error ||
        sampRes.error || siRes.error || specRes.error || itemRes.error || ordRes.error;
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
      const hints = {};
      for (const s of sampRes.data || []) {
        if (!s.styleNumber) continue;
        const norm = normalizeModel(s.styleNumber);
        if (s.back_type && !(norm in hints))
          hints[norm] = {
            back_type: String(s.back_type).toLowerCase(),
            qty: Number(s.back_type_quantity || 0),
          };
        const vId = siVendor[s.starting_info_id];
        if (!vId) continue;
        if (!(norm in exactMap)) exactMap[norm] = vId;
        const stripped = norm.replace(/-NEW$/i, "").replace(/\/[0-9.]+$/, "");
        if (!(stripped in strippedMap)) strippedMap[stripped] = vId;
      }
      setSampleMaps({ exactMap, strippedMap });
      setBackHints(hints);
      setSpecMaps(buildSpecMaps(specRes.data || []));
      const cat = {};
      for (const it of itemRes.data || []) cat[it.component] = it;
      setItemCatalog(cat);
      setOrders(ordRes.data || []);
    } catch (e) {
      console.log("ComponentOrders fetch error", e);
      showMessage("Failed to load component ordering data: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supabase) fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const orderedBySku = useMemo(() => {
    const m = {};
    for (const o of orders) {
      const k = `${o.po_number}|${o.sku}`;
      if (!m[k]) m[k] = o;
    }
    return m;
  }, [orders]);

  const attributed = useMemo(() => {
    const ctx = { aliasMap, soVendorsByPo, vendorsById, ...sampleMaps };
    return lines.map((l) => {
      const a = attributeLine(l, ctx);
      let c = componentsForLine(l, specMaps);
      // some factories buy their own backs/chains (Inah) — never order for them,
      // and never ask for a per-piece count on their styles
      const selfSupplied = !!vendorsById[a.vendorId]?.supplies_own_components;
      if (selfSupplied) {
        const zero = Object.fromEntries(COMPONENTS.map((x) => [x.key, 0]));
        c = { ...c, per: zero, totals: zero, pieces: 0, specKnown: true };
      }
      const ordered = orderedBySku[`${l.po_number}|${l.sku}`] || null;
      return {
        ...a,
        ...c,
        selfSupplied,
        ordered,
        qtyChanged: ordered && Number(ordered.qty) !== Number(l.order_qty),
      };
    });
  }, [lines, aliasMap, soVendorsByPo, vendorsById, sampleMaps, specMaps, orderedBySku]);

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
    return Object.values(byPo)
      .map((g) => {
        const orderedCount = g.lines.filter((l) => l.ordered).length;
        const totals = Object.fromEntries(COMPONENTS.map((c) => [c.key, 0]));
        for (const l of g.lines)
          for (const c of COMPONENTS) totals[c.key] += l.totals[c.key];
        return {
          ...g,
          totals,
          units: g.lines.reduce((s, l) => s + Number(l.order_qty || 0), 0),
          vendors: [...new Set(g.lines.map((l) => l.vendorLabel || "?"))],
          qtyChanged: g.lines.some((l) => l.qtyChanged),
          needsReview: g.lines.some((l) => l.needsReview || !l.specKnown),
          status:
            orderedCount === 0
              ? "not ordered"
              : orderedCount === g.lines.length
                ? "ordered"
                : "partial",
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));
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

  /**
   * The pivot Esther runs in Excel: one row per VENDOR PO (our QB PO to the
   * factory), not per Signet sales order. Follows the selection — nothing
   * ticked shows every open order.
   */
  const vendorPoRows = useMemo(() => {
    const zero = () => Object.fromEntries(COMPONENTS.map((c) => [c.key, 0]));
    const by = {};
    if (!generatedFor) return [];
    for (const l of attributed) {
      if (l.ordered) continue;
      if (!generatedFor.includes(l.po_number)) continue;
      const label = l.vendorLabel || "?";
      const vpo = ((soVendorsByPo[l.po_number] || {})[label] || []).join(", ");
      const key = `${vpo}|${label}`;
      const r = (by[key] ??= {
        key,
        vendorPo: vpo,
        vendorLabel: label,
        selfSupplied: l.selfSupplied,
        salesOrders: new Set(),
        lines: 0,
        units: 0,
        totals: zero(),
      });
      r.lines += 1;
      r.units += Number(l.order_qty || 0);
      r.salesOrders.add(l.po_number);
      for (const c of COMPONENTS) r.totals[c.key] += l.totals[c.key];
    }
    return Object.values(by)
      .map((r) => ({ ...r, salesOrders: [...r.salesOrders].sort().join(", ") }))
      .sort((a, b) =>
        (a.vendorPo || "zzz").localeCompare(b.vendorPo || "zzz")
      );
  }, [attributed, generatedFor, soVendorsByPo]);

  /**
   * The component PO itself, line for line the way it gets keyed into QB:
   * one row per component item per destination vendor PO
   * ("SB-100 | Sterling Silver ... AOXIN PO 12860 | 51,670 | 0.11").
   * Item codes / rates live in component_items so they can change without code.
   */
  const poSheet = useMemo(() => {
    const rows = [];
    for (const c of COMPONENTS) {
      const item = itemCatalog[c.key] || {};
      for (const r of vendorPoRows.filter((x) => x.totals[c.key] > 0)) {
        const qty = r.totals[c.key];
        const rate = Number(item.unit_cost || 0);
        rows.push({
          key: `${c.key}|${r.key}`,
          component: c.label,
          item: item.item_code || "",
          description: `${item.description || c.label} ${r.vendorLabel.toUpperCase()} PO ${r.vendorPo || "(none yet)"}`,
          qty,
          rate,
          amount: qty * rate,
        });
      }
    }
    return rows;
  }, [vendorPoRows, itemCatalog]);

  const poSheetTotal = poSheet.reduce((s, r) => s + r.amount, 0);
  const poSupplier =
    itemCatalog.sb?.supplier || itemCatalog.scb?.supplier || "the backs supplier";

  const copyPoSheet = () => {
    const tsv = poSheet
      .map((r) => [r.item, r.description, r.qty, r.rate.toFixed(2)].join("\t"))
      .join("\n");
    navigator.clipboard?.writeText(tsv);
    showMessage(`${poSheet.length} lines copied — paste straight into QuickBooks`);
  };

  // creates the PO directly in QuickBooks from poSheet — same rows the "copy
  // lines" button copies, just posted through the connector instead of
  // pasted by hand. `vendor`/`item`/`rate` are all "static info": they come
  // straight off the component_items lookup table (itemCatalog), not
  // anything computed per-order — so this is safe to fire without QB doing
  // any guessing on its end, same as the manual paste was.
  const [poCreate, setPoCreate] = useState({ busy: false, created: null, error: null });

  const createComponentPo = async () => {
    if (poSheet.length === 0) return;
    const missingItem = poSheet.find((r) => !r.item);
    if (missingItem) {
      showMessage(`"${missingItem.component}" has no QB item code set — fix that in Settings first`);
      return;
    }
    if (!poSupplier || poSupplier === "the backs supplier") {
      showMessage("No vendor set for backs/chains components — set it in Settings first");
      return;
    }
    setPoCreate({ busy: true, created: null, error: null });
    try {
      const key = `component-po:${(generatedFor || []).slice().sort().join(",")}`;
      const result = await createPurchaseOrder(
        {
          vendor: poSupplier,
          memo: `Backs/Chains — SO ${(generatedFor || []).join(", ")}`,
          lines: poSheet.map((r) => ({
            item: r.item,
            description: r.description,
            quantity: String(r.qty),
            rate: r.rate ? String(r.rate) : undefined,
          })),
        },
        { idempotencyKey: key }
      );
      setPoCreate({ busy: false, created: result, error: null });
      showMessage(`Created PO ${result.ref_number || "(number pending)"} in QuickBooks`);
    } catch (e) {
      const msg = e instanceof QbError ? e.message : e?.message || String(e);
      setPoCreate({ busy: false, created: null, error: msg });
      showMessage("Couldn't create the PO in QuickBooks: " + msg);
    }
  };

  const vendorPoTotals = useMemo(() => {
    const t = Object.fromEntries(COMPONENTS.map((c) => [c.key, 0]));
    let units = 0;
    let lines = 0;
    for (const r of vendorPoRows) {
      units += r.units;
      lines += r.lines;
      for (const c of COMPONENTS) t[c.key] += r.totals[c.key];
    }
    return { ...t, units, lines };
  }, [vendorPoRows]);

  // ---------- generation ----------

  const suggestSpec = (model) => {
    const hint = backHints[normalizeModel(model)];
    const blank = { sb: 0, scb: 0, gp_sb: 0 };
    if (!hint) return blank;
    const q = hint.qty || 2;
    if (hint.back_type.includes("silicone")) return { ...blank, sb: q };
    if (hint.back_type.includes("screw")) return { ...blank, scb: q };
    // flat backs (SPFB / GPFB) are a product we sell, not a component we buy —
    // no prefill, let whoever's ordering decide
    return blank;
  };

  // PHASE 1 — build the component PO for the ticked sales orders.
  // Anything the PLM can't price (unknown vendor, no per-piece count) is asked
  // once here, saved, and never asked again.
  const runGenerate = () => {
    if (selectedGroups.length === 0) {
      showMessage("Tick the sales orders you're covering first");
      return;
    }
    const targetLines = selectedGroups
      .flatMap((g) => g.lines)
      .filter((l) => !l.ordered);
    if (targetLines.length === 0) {
      showMessage("Every line on the selected orders was already ordered");
      return;
    }
    const vendorItems = [];
    const specItems = [];
    const seenVendor = {};
    const seenSpec = {};
    for (const l of targetLines) {
      const key = normalizeModel(l.model);
      if (l.needsReview && !seenVendor[key]) {
        seenVendor[key] = true;
        vendorItems.push({
          model: l.model,
          reason: l.reviewReason,
          vendorId: l.vendorId || "",
          saveAlias: true,
        });
      }
      if (!l.specKnown && !seenSpec[key]) {
        seenSpec[key] = true;
        specItems.push({ model: l.model, ...suggestSpec(l.model) });
      }
    }
    if (vendorItems.length || specItems.length) {
      setReview({ vendorItems, specItems });
      return;
    }
    applyAndGenerate([], []);
  };

  const applyAndGenerate = async (vendorDecisions, specDecisions) => {
    setBusy(true);
    setReview(null);
    try {
      const specRows = specDecisions.map((d) => ({
        model: normalizeModel(d.model),
        display_model: d.model,
        sb: Number(d.sb || 0),
        scb: Number(d.scb || 0),
        gp_sb: Number(d.gp_sb || 0),
        source: "manual",
        updated_at: new Date().toISOString(),
      }));
      if (specRows.length) {
        const { error } = await supabase
          .from("component_specs")
          .upsert(specRows, { onConflict: "model" });
        if (error) throw error;
      }
      const aliasRows = vendorDecisions
        .filter((d) => d.saveAlias && d.vendorId)
        .map((d) => ({
          alias: normalizeModel(d.model),
          vendor_id: Number(d.vendorId),
          note: "assigned in Backs & Chains page",
        }));
      if (aliasRows.length) {
        const { error } = await supabase
          .from("model_aliases")
          .upsert(aliasRows, { onConflict: "alias" });
        if (error) throw error;
      }
      const scope = selectedGroups.map((g) => g.po);
      if (specRows.length || aliasRows.length) await fetchAll();
      setGeneratedFor(scope);
      setResult(null);
    } catch (e) {
      console.log("component generate error", e);
      showMessage("Could not build the order: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  // PHASE 2 — record what was just keyed into QuickBooks so those lines never
  // get ordered twice.
  const markOrdered = async () => {
    if (!generatedFor) return;
    setBusy(true);
    try {
      const finalLines = attributed.filter(
        (l) =>
          generatedFor.includes(l.po_number) &&
          !l.ordered &&
          l.vendorId &&
          !l.needsReview
      );
      const skipped =
        attributed.filter(
          (l) => generatedFor.includes(l.po_number) && !l.ordered
        ).length - finalLines.length;
      const batches = buildComponentBatches(finalLines, soVendorsByPo);
      if (batches.length === 0) {
        showMessage("Nothing to record — no line resolved to a vendor");
        setBusy(false);
        return;
      }

      // 3. record the batch — no files; the numbers live on screen
      const allRows = [];
      for (const b of batches) {
        const batchId = uuidv4();
        b.batchId = batchId;
        for (const l of b.lines) {
          allRows.push({
            batch_id: batchId,
            batch_tag: b.batchTag,
            vendor_id: b.vendorId || null,
            vendor_label: b.vendorLabel,
            po_number: l.po_number,
            vendor_po: (soVendorsByPo[l.po_number]?.[b.vendorLabel] || [])[0] || null,
            sku: l.sku,
            model: l.model,
            qty: Number(l.order_qty || 0),
            sb: l.totals.sb,
            scb: l.totals.scb,
            gp_sb: l.totals.gp_sb,
          });
        }
      }
      const { error: insErr } = await supabase
        .from("component_orders")
        .insert(allRows);
      if (insErr) throw insErr;

      setResult({ batches, skipped });
      setSelectedPos({});
      setGeneratedFor(null);
      await fetchAll();
      showMessage(`Marked ${allRows.length} lines as ordered`);
    } catch (e) {
      console.log("component order error", e);
      showMessage("Component order failed: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  // ---------- history ----------

  const batchHistory = useMemo(() => {
    const byBatch = {};
    for (const o of orders) {
      const b = (byBatch[o.batch_id] ??= {
        batchId: o.batch_id,
        tag: o.batch_tag,
        vendorLabel: o.vendor_label,
        orderedAt: o.ordered_at,
        rows: [],
        totals: Object.fromEntries(COMPONENTS.map((c) => [c.key, 0])),
      });
      b.rows.push(o);
      for (const c of COMPONENTS) b.totals[c.key] += Number(o[c.key] || 0);
    }
    return Object.values(byBatch)
      .sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))
      .slice(0, 12);
  }, [orders]);

  const undoBatch = async (batch) => {
    if (
      !window.confirm(
        `Un-mark "${batch.tag}" (${batch.rows.length} lines)? Do this only if the component order was never placed.`
      )
    )
      return;
    const { error } = await supabase
      .from("component_orders")
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
          <Link2 className="w-6 h-6 text-[#C5A572]" /> Backs &amp; Chains
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
          <button onClick={fetchAll} className="p-2 rounded hover:bg-gray-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          {generatedFor ? (
            <>
              <button
                onClick={() => setGeneratedFor(null)}
                className="px-3 py-2 rounded border text-gray-600"
              >
                Start over
              </button>
              <button
                onClick={markOrdered}
                disabled={busy}
                className="bg-[#C5A572] text-white px-4 py-2 rounded disabled:opacity-40"
              >
                {busy ? "Working..." : "Mark as ordered"}
              </button>
            </>
          ) : (
            <button
              onClick={runGenerate}
              disabled={busy || selectedGroups.length === 0}
              className="bg-[#C5A572] text-white px-4 py-2 rounded disabled:opacity-40"
            >
              {busy
                ? "Working..."
                : `Generate order (${selectedGroups.length} order${selectedGroups.length === 1 ? "" : "s"})`}
            </button>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-3">
        Replaces the QuickBooks SB / SCB report. Tick the sales orders you're
        covering, hit Generate, and the component PO builds itself below — line
        for line, by vendor PO, priced. Key it into QuickBooks, then hit Mark as
        ordered so those lines never get ordered twice. Styles with no per-piece
        count on file are asked once, then remembered.
      </p>

      {result && (
        <div className="mb-4 border border-green-300 bg-green-50 rounded p-4">
          <div className="font-medium mb-2">Marked as ordered:</div>
          {result.batches.map((b) => (
            <div key={b.vendorLabel} className="flex items-center gap-3 py-1 text-sm max-md:flex-wrap">
              <span className="font-medium w-16">{b.vendorLabel}</span>
              <span>{b.units.toLocaleString()} pcs</span>
              {COMPONENTS.filter((c) => b.totals[c.key] > 0).map((c) => (
                <span key={c.key}>
                  {c.label}: <b>{b.totals[c.key].toLocaleString()}</b>
                </span>
              ))}
              {b.pieces === 0 && <span className="text-gray-500">nothing needed</span>}
              <code className="bg-white border px-2 py-0.5 rounded">{b.batchTag}</code>
              <button onClick={() => copyTag(b.batchTag)} className="p-1 hover:bg-green-100 rounded" title="Copy tag">
                <Copy className="w-4 h-4" />
              </button>
              {b.fileName && <span className="text-gray-500">{b.fileName}</span>}
            </div>
          ))}
          {result.skipped > 0 && (
            <div className="text-sm text-yellow-800 mt-2">
              {result.skipped} line(s) skipped (no vendor assigned).
            </div>
          )}
          <button onClick={() => setResult(null)} className="text-sm text-gray-500 underline mt-2">
            dismiss
          </button>
        </div>
      )}

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2 w-8">
                <input
                  type="checkbox"
                  checked={visibleGroups.length > 0 && selectedGroups.length === visibleGroups.length}
                  onChange={(e) => toggleAllVisible(e.target.checked)}
                />
              </th>
              <th className="p-2">Sales order</th>
              <th className="p-2">PO date</th>
              <th className="p-2 text-right">Units</th>
              <th className="p-2 text-right">SB</th>
              <th className="p-2 text-right">SCB</th>
              <th className="p-2 text-right">GP backs</th>
              <th className="p-2">Vendors</th>
              <th className="p-2">Status</th>
              <th className="p-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((g) => (
              <React.Fragment key={g.po}>
                <tr
                  className="border-b hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedPos((p) => ({ ...p, [g.po]: !p[g.po] }))}
                >
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!selectedPos[g.po]}
                      onChange={(e) => setSelectedPos((p) => ({ ...p, [g.po]: e.target.checked }))}
                    />
                  </td>
                  <td className="p-2 font-medium">{g.po}</td>
                  <td className="p-2">{g.date}</td>
                  <td className="p-2 text-right">{g.units.toLocaleString()}</td>
                  <td className="p-2 text-right">{g.totals.sb.toLocaleString()}</td>
                  <td className="p-2 text-right">{g.totals.scb.toLocaleString()}</td>
                  <td className="p-2 text-right">{g.totals.gp_sb.toLocaleString()}</td>
                  <td className="p-2">{g.vendors.join(", ")}</td>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${badge(g.status)}`}>{g.status}</span>
                    {g.needsReview && (
                      <span title="has lines with no confirmed vendor or no per-piece count">
                        <TriangleAlert className="w-4 h-4 text-yellow-600 inline ml-1" />
                      </span>
                    )}
                    {g.qtyChanged && (
                      <span className="ml-1 px-2 py-0.5 rounded text-xs bg-red-100 text-red-700">qty changed</span>
                    )}
                  </td>
                  <td className="p-2">
                    {expandedPos[g.po] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </td>
                </tr>
                {expandedPos[g.po] && (
                  <tr className="border-b bg-gray-50">
                    <td></td>
                    <td colSpan={9} className="p-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="p-1">SKU</th>
                            <th className="p-1">Style</th>
                            <th className="p-1 text-right">Qty</th>
                            <th className="p-1 text-right">SB /pc</th>
                            <th className="p-1 text-right">SCB /pc</th>
                            <th className="p-1 text-right">GP /pc</th>
                            <th className="p-1 text-right">Total SB</th>
                            <th className="p-1 text-right">Total SCB</th>
                            <th className="p-1 text-right">Total GP</th>
                            <th className="p-1">Vendor</th>
                            <th className="p-1">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.lines.map((l) => (
                            <tr key={l.sku} className="border-t border-gray-200">
                              <td className="p-1">{l.sku}</td>
                              <td className="p-1">
                                {l.model}
                                {!l.specKnown && (
                                  <span className="text-yellow-700 ml-1" title="no per-piece count on file — you'll be asked once">
                                    ⚠ no count
                                  </span>
                                )}
                              </td>
                              <td className="p-1 text-right">
                                {Number(l.order_qty).toLocaleString()}
                                {l.qtyChanged && (
                                  <span className="text-red-600 ml-1">(was {l.ordered.qty})</span>
                                )}
                              </td>
                              <td className="p-1 text-right">{l.per.sb}</td>
                              <td className="p-1 text-right">{l.per.scb}</td>
                              <td className="p-1 text-right">{l.per.gp_sb}</td>
                              <td className="p-1 text-right">{l.totals.sb.toLocaleString()}</td>
                              <td className="p-1 text-right">{l.totals.scb.toLocaleString()}</td>
                              <td className="p-1 text-right">{l.totals.gp_sb.toLocaleString()}</td>
                              <td className="p-1">
                                {l.vendorLabel || "?"}
                                {l.selfSupplied && (
                                  <span className="text-gray-500 ml-1" title="this factory buys its own backs and chains">
                                    (supplies own)
                                  </span>
                                )}
                                {l.needsReview && (
                                  <span className="text-yellow-700 ml-1" title={l.reviewReason}>⚠</span>
                                )}
                              </td>
                              <td className="p-1">
                                {l.ordered ? (
                                  <span title={l.ordered.batch_tag} className="text-green-700">
                                    ordered {new Date(l.ordered.ordered_at).toLocaleDateString()}
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
                <td colSpan={10} className="p-6 text-center text-gray-400">
                  No open sales orders waiting on backs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!generatedFor && (
        <div className="mt-8 mb-2 bg-white rounded shadow p-6 text-center text-gray-500">
          Tick the sales orders you're covering above, then hit{" "}
          <b className="text-gray-700">Generate order</b> — the component PO and
          the vendor-PO breakdown show up here.
        </div>
      )}

      {generatedFor && (
        <>
      {/* the component PO itself — what to key into QB */}
      <div className="flex items-baseline gap-3 mt-8 mb-2 max-md:flex-wrap">
        <h2 className="text-lg font-medium">What to order</h2>
        <span className="text-sm text-gray-500">
          {poSupplier} — sales order{generatedFor && generatedFor.length === 1 ? "" : "s"}{" "}
          {(generatedFor || []).join(", ")}
        </span>
        {poSheet.length > 0 && (
          <button
            onClick={copyPoSheet}
            className="text-sm text-blue-600 hover:underline flex items-center gap-1"
            title="Copy as tab-separated lines"
          >
            <Copy className="w-3.5 h-3.5" /> copy lines
          </button>
        )}
        {poSheet.length > 0 && !poCreate.created && (
          <button
            onClick={createComponentPo}
            disabled={poCreate.busy}
            className="text-sm text-green-700 hover:underline flex items-center gap-1 disabled:opacity-50"
            title={`Create a PO in QuickBooks for ${poSupplier}, ${poSheet.length} line${poSheet.length === 1 ? "" : "s"}`}
          >
            <FileText className="w-3.5 h-3.5" />
            {poCreate.busy ? "Creating PO..." : "Create PO in QuickBooks"}
          </button>
        )}
        {poCreate.created && (
          <span className="text-sm text-green-700 flex items-center gap-1">
            <FileText className="w-3.5 h-3.5" />
            Created PO {poCreate.created.ref_number || "(pending)"} in QuickBooks
          </span>
        )}
        {poCreate.error && (
          <span className="text-xs text-red-600" title={poCreate.error}>
            QB error — see message
          </span>
        )}
      </div>
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2">Item</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-right">Qty</th>
              <th className="p-2 text-right">Rate</th>
              <th className="p-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {poSheet.map((r) => (
              <tr key={r.key} className="border-b">
                <td className="p-2 font-medium">
                  {r.item || (
                    <span className="text-yellow-700" title="no QB item code set for this component">
                      set item code
                    </span>
                  )}
                </td>
                <td className="p-2">{r.description}</td>
                <td className="p-2 text-right">{r.qty.toLocaleString()}</td>
                <td className="p-2 text-right">{r.rate ? r.rate.toFixed(2) : "—"}</td>
                <td className="p-2 text-right">
                  {r.amount ? `$${r.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                </td>
              </tr>
            ))}
            {poSheet.length > 0 && (
              <tr className="bg-gray-50 font-medium">
                <td className="p-2" colSpan={2}>
                  TOTAL
                </td>
                <td className="p-2 text-right">
                  {poSheet.reduce((s, r) => s + r.qty, 0).toLocaleString()}
                </td>
                <td></td>
                <td className="p-2 text-right">
                  ${poSheetTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            )}
            {poSheet.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-400">
                  Nothing to order on the selected sales orders.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* the Excel pivot, live: one row per vendor PO */}
      <div className="flex items-baseline gap-3 mt-8 mb-2">
        <h2 className="text-lg font-medium">By vendor PO</h2>
        <span className="text-sm text-gray-500">
          sales order{generatedFor && generatedFor.length === 1 ? "" : "s"}{" "}
          {(generatedFor || []).join(", ")}
        </span>
      </div>
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2">Vendor PO</th>
              <th className="p-2">Vendor</th>
              <th className="p-2">Sales order(s)</th>
              <th className="p-2 text-right">Lines</th>
              <th className="p-2 text-right">Pieces</th>
              <th className="p-2 text-right">SB</th>
              <th className="p-2 text-right">SCB</th>
              <th className="p-2 text-right">GP backs</th>
            </tr>
          </thead>
          <tbody>
            {vendorPoRows.map((r) => (
              <tr key={r.key} className="border-b">
                <td className="p-2 font-medium">
                  {r.vendorPo || <span className="text-gray-400">no vendor PO yet</span>}
                </td>
                <td className="p-2">
                  {r.vendorLabel}
                  {r.selfSupplied && (
                    <span className="text-gray-500 text-xs ml-1">(supplies own)</span>
                  )}
                </td>
                <td className="p-2">{r.salesOrders}</td>
                <td className="p-2 text-right">{r.lines}</td>
                <td className="p-2 text-right">{r.units.toLocaleString()}</td>
                {COMPONENTS.map((c) => (
                  <td key={c.key} className="p-2 text-right">
                    {r.totals[c.key] ? r.totals[c.key].toLocaleString() : "—"}
                  </td>
                ))}
              </tr>
            ))}
            {vendorPoRows.length > 0 && (
              <tr className="border-b bg-gray-50 font-medium">
                <td className="p-2" colSpan={3}>
                  TOTAL
                </td>
                <td className="p-2 text-right">{vendorPoTotals.lines}</td>
                <td className="p-2 text-right">{vendorPoTotals.units.toLocaleString()}</td>
                {COMPONENTS.map((c) => (
                  <td key={c.key} className="p-2 text-right">
                    {vendorPoTotals[c.key].toLocaleString()}
                  </td>
                ))}
              </tr>
            )}
            {vendorPoRows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-400">
                  Nothing open.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

        </>
      )}

      <h2 className="text-lg font-medium mt-8 mb-2">Recent component orders</h2>
      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="p-2">Ordered</th>
              <th className="p-2">Vendor</th>
              <th className="p-2">Internal PO tag</th>
              <th className="p-2 text-right">Lines</th>
              <th className="p-2 text-right">SB</th>
              <th className="p-2 text-right">SCB</th>
              <th className="p-2 text-right">GP backs</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {batchHistory.map((b) => (
              <tr key={b.batchId} className="border-b">
                <td className="p-2">{new Date(b.orderedAt).toLocaleDateString()}</td>
                <td className="p-2">{b.vendorLabel}</td>
                <td className="p-2">
                  <code>{b.tag}</code>
                  <button onClick={() => copyTag(b.tag)} className="p-1 hover:bg-gray-100 rounded ml-1" title="Copy tag">
                    <Copy className="w-3 h-3" />
                  </button>
                </td>
                <td className="p-2 text-right">{b.rows.length}</td>
                <td className="p-2 text-right">{b.totals.sb.toLocaleString()}</td>
                <td className="p-2 text-right">{b.totals.scb.toLocaleString()}</td>
                <td className="p-2 text-right">{b.totals.gp_sb.toLocaleString()}</td>
                <td className="p-2 text-right">
                  <button onClick={() => undoBatch(b)} className="p-1 hover:bg-gray-100 rounded ml-1" title="Undo (only if never placed)">
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </button>
                </td>
              </tr>
            ))}
            {batchHistory.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-400">
                  No component orders recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {review && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5">
            {review.vendorItems.length > 0 && (
              <>
                <h3 className="text-lg font-medium mb-1">Assign vendors</h3>
                <p className="text-sm text-gray-500 mb-3">
                  These styles have no confirmed vendor. Pick once — saved styles never ask again.
                </p>
                {review.vendorItems.map((item, i) => (
                  <div key={item.model} className="flex items-center gap-3 py-2 border-b max-md:flex-wrap">
                    <div className="w-48 font-medium">{item.model}</div>
                    <select
                      value={item.vendorId}
                      onChange={(e) =>
                        setReview((r) => {
                          const vendorItems = [...r.vendorItems];
                          vendorItems[i] = { ...vendorItems[i], vendorId: e.target.value };
                          return { ...r, vendorItems };
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
                    {item.reason && <span className="text-xs text-yellow-700">{item.reason}</span>}
                  </div>
                ))}
              </>
            )}

            {review.specItems.length > 0 && (
              <>
                <h3 className="text-lg font-medium mt-5 mb-1">
                  How many per piece?
                </h3>
                <p className="text-sm text-gray-500 mb-3">
                  No count on file for these styles. Leave all zeros if the style
                  needs nothing (rings, pendants). Saved once, remembered after.
                </p>
                <div className="grid grid-cols-[1fr_repeat(3,70px)] gap-2 text-xs text-gray-500 font-medium">
                  <div>Style</div>
                  <div>SB</div>
                  <div>SCB</div>
                  <div>GP backs</div>
                </div>
                {review.specItems.map((item, i) => (
                  <div key={item.model} className="grid grid-cols-[1fr_repeat(3,70px)] gap-2 items-center py-1 border-b">
                    <div className="font-medium text-sm">{item.model}</div>
                    {COMPONENTS.map((c) => (
                      <input
                        key={c.key}
                        type="number"
                        min="0"
                        value={item[c.key]}
                        onChange={(e) =>
                          setReview((r) => {
                            const specItems = [...r.specItems];
                            specItems[i] = { ...specItems[i], [c.key]: e.target.value };
                            return { ...r, specItems };
                          })
                        }
                        className="border rounded px-2 py-1 w-full"
                      />
                    ))}
                  </div>
                ))}
              </>
            )}

            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setReview(null)} className="px-4 py-2 rounded border">
                Cancel
              </button>
              <button
                onClick={() => applyAndGenerate(review.vendorItems, review.specItems)}
                className="px-4 py-2 rounded bg-[#C5A572] text-white"
                disabled={busy}
              >
                {busy ? "Working..." : "Generate order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
