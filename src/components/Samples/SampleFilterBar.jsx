import React, { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useSupabase } from "../SupaBaseProvider";
import { useGenericStore } from "../../store/VendorStore";
import { purity } from "../../utils/MetalTypeUtil";

// One bar that drives ALL sample filtering server-side via URL params:
// q, vendor, metal, karat, category, collection, stone, stonecolor, back, chain, sort
// SampleList reads the same params and builds the query.

const SORTS = [
  { v: "newest", label: "Newest" },
  { v: "style", label: "Style #" },
  { v: "cost_desc", label: "Cost: high to low" },
  { v: "cost_asc", label: "Cost: low to high" },
  { v: "weight_desc", label: "Weight: heaviest" },
];

export default function SampleFilterBar({ resultCount }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { supabase } = useSupabase();
  const { getEntity } = useGenericStore();
  const vendors = getEntity("vendors") || [];
  const { stonePropertiesForm, formFields } = getEntity("settings")?.options || {};

  const [dropdowns, setDropdowns] = useState({ category: [], collection: [] });
  const [q, setQ] = useState(searchParams.get("q") || "");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("get_dropdown_options");
      if (data) {
        setDropdowns({
          category: data.category || [],
          collection: data.collection || [],
        });
      }
    })();
  }, [supabase]);

  // debounce the text search into the URL
  useEffect(() => {
    const t = setTimeout(() => {
      const current = searchParams.get("q") || "";
      if (q.trim() === current) return;
      setParam("q", q.trim());
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "" || value == null) next.delete(key);
    else next.set(key, value);
    next.delete("page"); // any filter change goes back to page 1
    setSearchParams(next, { replace: true });
  };

  const optName = (o) => (typeof o === "string" ? o : o?.name ?? String(o?.id ?? ""));
  const optId = (o) => (typeof o === "object" && o !== null && "id" in o ? String(o.id) : optName(o));

  const active = useMemo(() => {
    const labels = [];
    const vendorId = searchParams.get("vendor");
    if (searchParams.get("q")) labels.push({ key: "q", label: `"${searchParams.get("q")}"` });
    if (vendorId) {
      const v = vendors.find((x) => String(x.id) === vendorId);
      labels.push({ key: "vendor", label: v ? v.name : `vendor ${vendorId}` });
    }
    for (const key of ["metal", "karat", "stone", "stonecolor", "back"]) {
      if (searchParams.get(key)) labels.push({ key, label: searchParams.get(key) });
    }
    if (searchParams.get("category")) {
      const c = dropdowns.category.find((x) => optId(x) === searchParams.get("category"));
      labels.push({ key: "category", label: c ? optName(c) : "category" });
    }
    if (searchParams.get("collection")) {
      const c = dropdowns.collection.find((x) => optId(x) === searchParams.get("collection"));
      labels.push({ key: "collection", label: c ? optName(c) : "collection" });
    }
    if (searchParams.get("chain") === "true") labels.push({ key: "chain", label: "has chain" });
    return labels;
  }, [searchParams, vendors, dropdowns]);

  const clearAll = () => {
    const next = new URLSearchParams();
    const sort = searchParams.get("sort");
    if (sort) next.set("sort", sort);
    setSearchParams(next, { replace: true });
    setQ("");
  };

  const sel = "border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white max-w-[150px]";

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search style #, name, description..."
            className="pl-8 pr-8 py-1.5 border border-gray-300 rounded-md text-sm w-64 max-md:w-full"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <select className={sel} value={searchParams.get("vendor") || ""} onChange={(e) => setParam("vendor", e.target.value)}>
          <option value="">Vendor</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("metal") || ""} onChange={(e) => setParam("metal", e.target.value)}>
          <option value="">Metal</option>
          {["Gold", "Silver", "Brass"].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("karat") || ""} onChange={(e) => setParam("karat", e.target.value)}>
          <option value="">Karat</option>
          {Object.keys(purity).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("category") || ""} onChange={(e) => setParam("category", e.target.value)}>
          <option value="">Category</option>
          {dropdowns.category.map((c) => (
            <option key={optId(c)} value={optId(c)}>{optName(c)}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("collection") || ""} onChange={(e) => setParam("collection", e.target.value)}>
          <option value="">Collection</option>
          {dropdowns.collection.map((c) => (
            <option key={optId(c)} value={optId(c)}>{optName(c)}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("stone") || ""} onChange={(e) => setParam("stone", e.target.value)}>
          <option value="">Stone</option>
          {(stonePropertiesForm?.type || []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("stonecolor") || ""} onChange={(e) => setParam("stonecolor", e.target.value)}>
          <option value="">Stone color</option>
          {(stonePropertiesForm?.color || []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select className={sel} value={searchParams.get("back") || ""} onChange={(e) => setParam("back", e.target.value)}>
          <option value="">Back type</option>
          {(formFields?.backType || []).map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-sm text-gray-600 px-1">
          <input
            type="checkbox"
            checked={searchParams.get("chain") === "true"}
            onChange={(e) => setParam("chain", e.target.checked ? "true" : "")}
          />
          Chain
        </label>

        <select
          className={sel}
          value={searchParams.get("sort") || "newest"}
          onChange={(e) => setParam("sort", e.target.value === "newest" ? "" : e.target.value)}
          title="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.v} value={s.v}>{s.label}</option>
          ))}
        </select>
      </div>

      {(active.length > 0 || resultCount != null) && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {active.map((a) => (
            <span
              key={a.key}
              className="flex items-center gap-1 bg-[#faf6ef] border border-[#C5A572]/40 text-[#8a6d3b] rounded-full px-3 py-0.5 text-xs"
            >
              {a.label}
              <button
                onClick={() => {
                  if (a.key === "q") setQ("");
                  setParam(a.key, "");
                }}
                className="hover:text-red-600"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {active.length > 0 && (
            <button onClick={clearAll} className="text-xs text-gray-500 underline">
              clear all
            </button>
          )}
          {resultCount != null && (
            <span className="text-xs text-gray-400 ml-auto">
              {resultCount.toLocaleString()} sample{resultCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
