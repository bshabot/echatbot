import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * Signet SSP product type + category picker.
 *
 * SSP's taxonomy is two-level: a product type (earrings, necklaces, …) and a
 * category drawn from that type's own list. The pairs are seeded in the
 * `ssp_product_categories` table straight from SSP's own
 * `/item/get-filters` response, so what we offer here is exactly what SSP
 * accepts — picking from this list is what keeps us from inventing values
 * SSP rejects.
 */
export default function SspCategorySelect({ productType, category, onChange }) {
  const { supabase } = useSupabase();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("ssp_product_categories")
        .select("product_type,category")
        .eq("is_active", true)
        .order("product_type")
        .order("category");
      if (cancelled) return;
      if (error) console.error("Error fetching SSP categories:", error);
      setRows(data || []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const productTypes = useMemo(
    () => [...new Set(rows.map((r) => r.product_type))],
    [rows]
  );

  const categories = useMemo(
    () => rows.filter((r) => r.product_type === productType).map((r) => r.category),
    [rows, productType]
  );

  return (
    <div className="flex flex-row gap-2 max-md:flex-col">
      <div className="w-full">
        <label className="block text-sm font-medium text-gray-700">
          SSP Product Type
        </label>
        <select
          className="input mt-1"
          value={productType || ""}
          disabled={loading}
          onChange={(e) =>
            // Changing the type invalidates the category — SSP's lists do not
            // overlap cleanly, so keeping the old one would send a pair that
            // does not exist.
            onChange({ ssp_product_type: e.target.value || null, ssp_category: null })
          }
        >
          <option value="">{loading ? "Loading…" : "(none)"}</option>
          {productTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="w-full">
        <label className="block text-sm font-medium text-gray-700">
          SSP Category
        </label>
        <select
          className="input mt-1"
          value={category || ""}
          disabled={loading || !productType}
          onChange={(e) =>
            onChange({
              ssp_product_type: productType || null,
              ssp_category: e.target.value || null,
            })
          }
        >
          <option value="">{productType ? "(none)" : "pick a type first"}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
