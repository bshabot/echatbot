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

  // Global inputs (default to current metal-prices store; user can override on this page only)
  const [silverInput, setSilverInput] = useState(prices?.silver?.price ?? 30);
  const [goldInput, setGoldInput] = useState(prices?.gold?.price ?? 2400);
  const [tariffPct, setTariffPct] = useState(10);
  const [upchargePct, setUpchargePct] = useState(3);

  // Data
  const [skus, setSkus] = useState([]);
  const [samples, setSamples] = useState([]);
  const [materialsBySsp, setMaterialsBySsp] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("dashboard"); // dashboard | detail
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
            "ssp_number,item_number,material_type,metal_purity,metal_karat,metal_color,material_net_weight"
          ),
      ]);
      if (e1) console.error("running_line_skus fetch failed:", e1.message);
      if (e2) console.error("samples fetch failed:", e2.message);
      if (e3) console.error("running_line_materials fetch failed:", e3.message);

      // Group materials by ssp_number
      const matMap = new Map();
      for (const m of matRows ?? []) {
        if (!matMap.has(m.ssp_number)) matMap.set(m.ssp_number, []);
        matMap.get(m.ssp_number).push(m);
      }
      setMaterialsBySsp(matMap);
      setSkus(skuRows ?? []);
      setSamples(sampleRows ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  // Build a fast lookup from styleNumber → sample
  const sampleByStyle = useMemo(() => {
    const m = new Map();
    for (const s of samples) {
      if (s.styleNumber) m.set(String(s.styleNumber).trim(), s);
    }
    return m;
  }, [samples]);

  // Decorate each sku with margin math at current inputs
  const decorated = useMemo(() => {
    const out = [];
    for (const sku of skus) {
      const sample = sku.vendor_style_number
        ? sampleByStyle.get(String(sku.vendor_style_number).trim())
        : null;

      // Resolve metal from materials (gold / silver / brass + actual purity)
      const metal = resolveMetal(materialsBySsp.get(sku.ssp_number) || []);
      const skuWithMetal = { ...sku, metal };

      const signetBill = recomputeSignetBill(skuWithMetal, {
        silver: silverInput,
        gold: goldInput,
        tariffPct,
        upchargePct,
      });

      const factoryCost = sample
        ? recomputeFactoryCost(sample, { silver: silverInput, gold: goldInput })
        : null;

      const margin = computeMargin(signetBill, factoryCost);
      const variance = signetBill - (Number(sku.vendor_purch_cost) || 0);

      out.push({
        ...skuWithMetal,
        sample,
        signetBill,
        factoryCost,
        margin,
        variance,
        matched: !!sample,
      });
    }
    return out;
  }, [skus, sampleByStyle, materialsBySsp, silverInput, goldInput, tariffPct, upchargePct]);

  // Aggregate tiles
  const tiles = useMemo(() => {
    const matched = decorated.filter((d) => d.matched && d.margin != null);
    const totalMargin = matched.reduce((sum, d) => sum + (d.margin || 0), 0);
    const totalVariance = decorated.reduce((sum, d) => sum + (d.variance || 0), 0);
    const avgMarginPct = matched.length
      ? (matched.reduce(
          (sum, d) => sum + (d.signetBill > 0 ? d.margin / d.signetBill : 0),
          0
        ) /
          matched.length) *
        100
      : 0;
    return {
      totalMargin,
      totalVariance,
      avgMarginPct,
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
      variance_desc: (a, b) => (b.variance ?? 0) - (a.variance ?? 0),
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

  const pct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Running Lines</h1>
          <p className="text-sm text-gray-500 mt-1">
            Banter SKUs scraped from Signet SSP. Type a metal price, see what you should be billing.
          </p>
        </div>
        <div className="text-sm text-gray-500">
          {loading
            ? "loading..."
            : `${tiles.matchedCount} of ${tiles.total} matched`}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          {[
            { id: "dashboard", label: "Dashboard" },
            { id: "detail", label: `Detail (${tiles.total})` },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`pb-3 text-sm font-medium border-b-2 -mb-px ${
                activeTab === t.id
                  ? "border-[#C5A572] text-[#C5A572]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Global inputs */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Tariff %
            </label>
            <input
              type="number"
              value={tariffPct}
              onChange={(e) => setTariffPct(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Upcharge %
            </label>
            <input
              type="number"
              value={upchargePct}
              onChange={(e) => setUpchargePct(Number(e.target.value) || 0)}
              className="input w-full"
              step="0.1"
            />
          </div>
        </div>
      </div>

      {/* Dashboard tab */}
      {activeTab === "dashboard" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="text-xs text-gray-500 uppercase tracking-wider">
              Total Margin
            </div>
            <div className="text-3xl font-semibold text-gray-900 mt-2">
              {dollar(tiles.totalMargin)}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              across {tiles.matchedCount} matched SKUs
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="text-xs text-gray-500 uppercase tracking-wider">
              Variance vs Signet
            </div>
            <div
              className={`text-3xl font-semibold mt-2 ${
                tiles.totalVariance >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {tiles.totalVariance >= 0 ? "+" : ""}
              {dollar(tiles.totalVariance)}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              today's bill vs SSP-stored SPC
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="text-xs text-gray-500 uppercase tracking-wider">
              Avg Margin %
            </div>
            <div className="text-3xl font-semibold text-gray-900 mt-2">
              {pct(tiles.avgMarginPct)}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              weighted across matched
            </div>
          </div>
        </div>
      )}

      {/* Detail tab */}
      {activeTab === "detail" && (
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
              <option value="variance_desc">Variance (high → low)</option>
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
      )}

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
