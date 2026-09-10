import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * SSP category picker — the second level under a product type.
 *
 * Our "type" is what SSP calls product type (earrings, rings, charms); our
 * "category" is what SSP calls category (fashion, hoop, cartilage). The
 * options come from `ssp_product_categories`, seeded from SSP's own
 * /item/get-filters response, so anything picked here is a value SSP
 * accepts. The type row supplies a default; this control is the override.
 */
export default function CategorySelect({ productType, value, defaultValue, onChange }) {
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

  const options = useMemo(
    () =>
      rows
        .filter((r) => r.product_type === productType)
        .map((r) => r.category),
    [rows, productType]
  );

  const effective = value || defaultValue || "";

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">Category</label>
      <select
        className="input mt-1"
        value={effective}
        disabled={loading || !productType}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">
          {productType ? (defaultValue ? `${defaultValue} (default)` : "(none)") : "pick a type first"}
        </option>
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}
