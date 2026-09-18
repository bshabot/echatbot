import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * Finding picker -- a per-sample override of the type-level finding
 * default (Settings > SSP Templates > Category > Finding type).
 *
 * Kevin, 2026-09-16: slim the choices down to the ones he actually gave
 * per type, instead of the full 45-value SSP vocabulary (findingType in
 * ssp_vocabulary, still used for the free vocabulary in Settings). Options
 * here come straight from `ssp_finding_defaults` rows for this productType
 * -- the type-wide default plus any category-specific overrides (e.g.
 * bracelets: lobster, plus box/tongue for the tennis category) -- so a
 * type with no examples yet from Kevin shows no extra choices, just the
 * "(none)" default. Leaving this blank falls back to the type/category
 * default in ssp_finding_defaults (see sample_with_stones_export --
 * COALESCE(starting_info.finding_type, fd_cat, fd_type)).
 */
export default function FindingSelect({ productType, value, onChange }) {
  const { supabase } = useSupabase();
  const [defaults, setDefaults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("ssp_finding_defaults")
        .select("ssp_product_type,ssp_category,finding_type");
      if (cancelled) return;
      if (error) console.error("Error fetching finding defaults:", error);
      setDefaults(data || []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const rowsForType = useMemo(
    () => defaults.filter((d) => d.ssp_product_type === productType),
    [defaults, productType]
  );

  const defaultValue = rowsForType.find((d) => d.ssp_category === null)?.finding_type || null;

  const options = useMemo(
    () => [...new Set(rowsForType.map((d) => d.finding_type).filter(Boolean))],
    [rowsForType]
  );

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">Finding</label>
      <select
        className="input mt-1"
        value={value || ""}
        disabled={loading || !productType}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">
          {productType
            ? defaultValue
              ? `${defaultValue} (default)`
              : "(none)"
            : "pick a type first"}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
