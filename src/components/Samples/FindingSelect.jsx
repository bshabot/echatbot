import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * Finding picker -- a per-sample override of the type-level finding
 * default (Settings > SSP Templates > Category > Finding type).
 *
 * Options come from `ssp_vocabulary` (field=findingType), pulled live from
 * SSP's finding/get-filters (2026-09-16) -- SSP returns the same flat list
 * regardless of the item's product type, so unlike Category this isn't
 * scoped by productType. Leaving this blank falls back to the type/
 * category default in ssp_finding_defaults (see sample_with_stones_export
 * -- COALESCE(starting_info.finding_type, fd_cat, fd_type)).
 */
export default function FindingSelect({ productType, value, onChange }) {
  const { supabase } = useSupabase();
  const [options, setOptions] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: vocab, error: vErr }, { data: fd, error: fErr }] = await Promise.all([
        supabase
          .from("ssp_vocabulary")
          .select("value")
          .eq("field", "findingType")
          .eq("is_active", true)
          .order("value"),
        supabase
          .from("ssp_finding_defaults")
          .select("ssp_product_type,finding_type")
          .is("ssp_category", null),
      ]);
      if (cancelled) return;
      if (vErr) console.error("Error fetching finding vocabulary:", vErr);
      if (fErr) console.error("Error fetching finding defaults:", fErr);
      setOptions((vocab || []).map((r) => r.value));
      setDefaults(fd || []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const defaultValue = useMemo(
    () => defaults.find((d) => d.ssp_product_type === productType)?.finding_type || null,
    [defaults, productType]
  );

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">Finding</label>
      <select
        className="input mt-1"
        value={value || ""}
        disabled={loading}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{defaultValue ? `${defaultValue} (default)` : "(none)"}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
