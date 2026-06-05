import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMetalPriceStore } from "../store/MetalPrices";
import {
  recomputeSignetBill,
  recomputeFactoryCost,
  computeMargin,
  resolveMetal,
} from "../utils/runningLinesMath";
import SkuCard from "../components/RunningLines/SkuCard";
import CreateSamplePanel from "../components/RunningLines/CreateSamplePanel";

export default function RunningLines() {
  const { supabase } = useSupabase();
  const prices = useMetalPriceStore((s) => s.prices);

  // Spot rate inputs (default to current metal-prices store)
  const [silverInput, setSilverInput] = useState(prices?.silver?.price ?? 30);
  const [goldInput, setGoldInput] = useState(prices?.gold?.price ?? 2400);

  // Data
  const [skus, setSkus] = useState([]);
  const [samples, setSamples] = useState([]);
  const [componentsBySsp, setComponentsBySsp] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // all | matched | unmatched | flagged
  const [sortBy, setSortBy] = useState("margin_desc");
  const [searchText, setSearchText] = useState("");

  // Create-sample inline panel
  const [createPrefill, setCreatePrefill] = useState(null);

  // Fetch on mount
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      setLoading(true);
      const [
        { data: skuRows, error: e1 },
        { data: sampleRows, error: e2 },
        { data: matRows, error: e3 },
        { data: findRows, error: e4 },
        { data: chainRows, error: e5 },
      ] = await Promise.all([
        supabase.from("running_line_skus").select("*"),
        supabase
          .from("sample_with_stones_export")
          .select(
            "sample_id,styleNumber,name,metalType,karat,color,weight,laborCost,miscCost,platingCharge,totalCost,stones,plating,vendor"
          ),
        supabase
          .from("running_line_materials")
          .select(
            "ssp_number,item_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight,metal_base_price,metal_loss_percent,material_cost"
          ),
        supabase
          .from("running_line_findings")
          .select(
            "ssp_number,item_number,finding_type,finding_net_weight,metal_purity,metal_base_price,metal_loss_percent,finding_material_cost"
          ),
        supabase
          .from("running_line_chains")
          .select(
            "ssp_number,item_number,chain_type,chain_net_weight,metal_purity,metal_karat,metal_base_price,metal_loss_percent,chain_material_cost"
          ),
      ]);
      if (e1) console.error("running_line_skus fetch failed:", e1.message);
      if (e2) console.error("samples fetch failed:", e2.message);
      if (e3) console.error("running_line_materials fetch failed:", e3.message);
      if (e4) console.error("running_line_findings fetch failed:", e4.message);
      if (e5) console.error("running_line_chains fetch failed:", e5.message);

      // Combine ALL metal-bearing components per ssp_number (for delta calc)
      const compMap = new Map();
      const push = (rows) => {
        for (const r of rows ?? []) {
          if (!compMap.has(r.ssp_number)) compMap.set(r.ssp_number, []);
          compMap.get(r.ssp_number).push(r);
        }
      };
      push(matRows);
      push(findRows);
      push(chainRows);
      setComponentsBySsp(compMap);
      setSkus(skuRows ?? []);
      setSamples(sampleRows ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  // Build a fast lookup from styleNumber → sample. Normalized to lowercase + trim
  // so case differences ("N1742ANK" vs "n1742ank") still match.
  const normKey = (v) => String(v ?? "").trim().toLowerCase();
  const sampleByStyle = useMemo(() => {
    const m = new Map();
    for (const s of samples) {
      if (s.styleNumber) m.set(normKey(s.styleNumber), s);
    }
    return m;
  }, [samples]);

  // Decorate each sku with margin math at current inputs
  const decorated = useMemo(() => {
    const out = [];
    for (const sku of skus) {
      const sample = sku.vendor_style_number
        ? sampleByStyle.get(normKey(sku.vendor_style_number))
        : null;

      // Resolve metal from all components (materials are dominant for labeling).
      // For the recompute delta, we pass ALL components (materials + findings + chains).
      const skuComponents = componentsBySsp.get(sku.ssp_number) || [];
      const metal = resolveMetal(skuComponents);
      const skuWithMetal = { ...sku, metal };

      // /running-lines is the catalog view — no tariff/upcharge layered on.
      // Those belong on PO pages where they're deal-specific.
      const signetBill = recomputeSignetBill(skuWithMetal, skuComponents, {
        silver: silverInput,
        gold: goldInput,
        tariffPct: 0,
        upchargePct: 0,
      });

      const factoryCost = sample
        ? recomputeFactoryCost(sample, { silver: silverInput, gold: goldInput })
        : null;

      const margin = computeMargin(signetBill, factoryCost);

      out.push({
        ...skuWithMetal,
        sample,
        signetBill,
        factoryCost,
        margin,
        matched: !!sample,
      });
    }
    return out;
  }, [skus, sampleByStyle, componentsBySsp, silverInput, goldInput]);

  // Aggregate counts only (no tiles UI on this page anymore)
  const tiles = useMemo(() => {
    const matched = decorated.filter((d) => d.matched && d.margin != null);
    const totalMargin = matched.reduce((sum, d) => sum + (d.margin || 0), 0);
    return {
      totalMargin,
      matchedCount: matched.length,
      total: decorated.length,
    };
  }, [decorated]);

  // Filter + sort for detail tab
  const visible = useMemo(() => {
    let rows = decorated;
    if (filter === "matched") rows = rows.filter((d) => d.matched);
    if (filter === "unmatched") rows = rows.filter((d) => !d.matched);
    if (filter === "flagged") rows = rows.filter((d) => d.flagged);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      rows = rows.filter(
        (d) =>
          d.ssp_number?.toLowerCase().includes(q) ||
          d.sku_number?.toLowerCase().includes(q) ||
          d.vendor_style_number?.toLowerCase().includes(q) ||
          d.description?.toLowerCase().includes(q)
      );
    }
    const sorters = {
      margin_desc: (a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity),
      margin_asc: (a, b) => (a.margin ?? Infinity) - (b.margin ?? Infinity),
      ssp_asc: (a, b) => String(a.ssp_number).localeCompare(String(b.ssp_number)),
    };
    return [...rows].sort(sorters[sortBy] ?? sorters.margin_desc);
  }, [decorated, filter, sortBy, searchText]);

  // ----- Handlers -----
  const onTogglePersist = async (sspNumber, patch) => {
    setSkus((prev) =>
      prev.map((s) => (s.ssp_number === sspNumber ? { ...s, ...patch } : s))
    );
    const { error } = await supabase
      .from("running_line_skus")
      .update(patch)
      .eq("ssp_number", sspNumber);
    if (error) console.error("Update failed:", error.message);
  };

  const onCreateSample = (sku) => {
    setCreatePrefill({
      name: sku.sku_number ?? "",
      styleNumber: sku.vendor_style_number ?? "",
      weight: sku.total_net_weight ?? "",
      laborCost: sku.total_labor_cost ?? "",
      platingCharge: sku.total_plating_cost ?? "",
      metalType: sku.raw_data?.["skuSummary.data.header.brand"]?.includes("Gold")
        ? "Gold"
        : "Silver",
      karat: "925",
      sspNumber: sku.ssp_number,
    });
  };

  const dollar = (n) =>
    n == null
      ? "—"
      : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Running Lines</h1>
          <p className="text-sm text-gray-500 mt-1">
            Banter SKUs scraped from Signet SSP. Type a metal price, see margin per SKU.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500 uppercase tracking-wider">
            Total margin at current spot
          </div>
          <div className="text-lg font-semibold text-gray-900">
            {loading ? "—" : dollar(tiles.totalMargin)}
          </div>
          <div className="text-xs text-gray-500">
            {tiles.matchedCount} of {tiles.total} matched
          </div>
        </div>
      </div>

      {/* Spot rate inputs only — tariff/upcharge live on the PO pages */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-2 gap-4 max-w-md">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Silver $/oz
            </label>
            <input
              type="number"
              value={silverInput}
              onChange={(e) => setSilverInput(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Gold $/oz
            </label>
            <input
              type="number"
              value={goldInput}
              onChange={(e) => setGoldInput(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.01"
            />
          </div>
        </div>
      </div>

      {/* Filters + cards (no tabs) */}
      <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Search SSP / SKU / style #"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="input w-64"
            />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="input"
            >
              <option value="all">All ({tiles.total})</option>
              <option value="matched">Matched ({tiles.matchedCount})</option>
              <option value="unmatched">
                Unmatched ({tiles.total - tiles.matchedCount})
              </option>
              <option value="flagged">Flagged</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input"
            >
              <option value="margin_desc">Margin (high → low)</option>
              <option value="margin_asc">Margin (low → high)</option>
              <option value="ssp_asc">SSP #</option>
            </select>
            <div className="ml-auto text-sm text-gray-500">
              showing {visible.length} of {tiles.total}
            </div>
          </div>

          {loading ? (
            <div className="text-center text-gray-500 py-12">loading...</div>
          ) : visible.length === 0 ? (
            <div className="text-center text-gray-500 py-12">no SKUs match this filter</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {visible.map((sku) => (
                <SkuCard
                  key={sku.ssp_number}
                  sku={sku}
                  onToggleFlag={() =>
                    onTogglePersist(sku.ssp_number, { flagged: !sku.flagged })
                  }
                  onSaveNote={(note) => onTogglePersist(sku.ssp_number, { note })}
                  onCreateSample={() => onCreateSample(sku)}
                />
              ))}
            </div>
          )}
        </>

      {/* Create-sample inline panel */}
      {createPrefill && (
        <CreateSamplePanel
          prefill={createPrefill}
          onClose={() => setCreatePrefill(null)}
        />
      )}
    </div>
  );
}
