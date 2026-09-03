import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * Per type + metal + karat defaults for the SSP components.
 *
 * The catalog collapses to ~20 of these combinations, so filling them in once
 * covers the whole catalog instead of tagging 5,600 samples by hand. A sample
 * resolves its template at send time; anything set on the record itself wins.
 *
 * Plating is deliberately not part of the key -- it varies inside every
 * combination and already lives on the record.
 *
 * Every dropdown is fed from `ssp_vocabulary`, which is seeded from SSP's own
 * get-filters responses. A value that is not in that table cannot be picked,
 * which is what stops invented values reaching Signet.
 */

// field name in ssp_vocabulary -> the template columns that use it
const VOCAB_FIELDS = [
  "settingTypes",
  "settingMethods",
  "categories",
  "materialType",
  "metalNickelContent",
  "finishingType",
  "vdrPackagingDesc",
];

const NUM = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

export default function SspTemplatesCard() {
  const { supabase } = useSupabase();
  const [rows, setRows] = useState([]);
  const [vocab, setVocab] = useState({});
  const [categories, setCategories] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [saving, setSaving] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [t, v, c] = await Promise.all([
        supabase
          .from("ssp_templates")
          .select("*, category:type_id(id,name,ssp_product_type)")
          .order("id"),
        supabase.from("ssp_vocabulary").select("field,value").eq("is_active", true).order("value"),
        supabase.from("ssp_product_categories").select("product_type,category").order("category"),
      ]);
      if (cancelled) return;
      if (t.error || v.error || c.error) {
        setError(t.error?.message || v.error?.message || c.error?.message);
      }
      setRows(t.data || []);
      const grouped = {};
      for (const row of v.data || []) (grouped[row.field] ||= []).push(row.value);
      setVocab(grouped);
      setCategories(c.data || []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const patch = (id, key, value) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));

  const save = async (row) => {
    setSaving(row.id);
    setError("");
    const { category, ...rest } = row; // drop the joined relation
    const { error: err } = await supabase
      .from("ssp_templates")
      .update({
        ssp_category: rest.ssp_category,
        material_type: rest.material_type,
        metal_purity: NUM(rest.metal_purity),
        metal_karat: rest.metal_karat,
        metal_color: rest.metal_color,
        nickel_content: rest.nickel_content,
        metal_loss_percent: NUM(rest.metal_loss_percent),
        stone_category: rest.stone_category,
        stone_clarity: rest.stone_clarity,
        setting_type: rest.setting_type,
        setting_method: rest.setting_method,
        setting_charge_per_stone: NUM(rest.setting_charge_per_stone),
        finding_type: rest.finding_type,
        finding_material_type: rest.finding_material_type,
        finding_labor_cost: NUM(rest.finding_labor_cost),
        casting_cost: NUM(rest.casting_cost),
        assembly_charge: NUM(rest.assembly_charge),
        labor_per_gram: NUM(rest.labor_per_gram),
        finishing_type: rest.finishing_type,
        finishing_cost: NUM(rest.finishing_cost),
        packaging_desc: rest.packaging_desc,
        packaging_cost: NUM(rest.packaging_cost),
        tag_qty: NUM(rest.tag_qty),
        tag_cost: NUM(rest.tag_cost),
        duty_rate: NUM(rest.duty_rate),
        country_of_origin: rest.country_of_origin,
        notes: rest.notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (err) setError(err.message);
    setSaving(null);
  };

  // SSP categories legal for this row's product type
  const categoriesFor = (productType) =>
    categories.filter((c) => c.product_type === productType).map((c) => c.category);

  const missingCosts = (r) =>
    [r.casting_cost, r.assembly_charge, r.setting_charge_per_stone, r.packaging_cost].filter(
      (v) => v === null || v === undefined
    ).length;

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        `${a.category?.name || ""}${a.metal_type}${a.karat}`.localeCompare(
          `${b.category?.name || ""}${b.metal_type}${b.karat}`
        )
      ),
    [rows]
  );

  if (loading) return <div className="text-[13px] text-gray-500">Loading templates…</div>;

  return (
    <div>
      {error ? (
        <div className="mb-3 text-[13px] text-red-600">{error}</div>
      ) : null}

      <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
        {sorted.map((r) => {
          const open = openId === r.id;
          const gaps = missingCosts(r);
          return (
            <div key={r.id}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : r.id)}
                className="w-full flex items-center gap-2 p-3 text-left hover:bg-gray-50"
              >
                {open ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
                <span className="text-[13px] font-medium">
                  {r.category?.name || "(no type)"} · {r.metal_type} {r.karat}
                </span>
                <span className="text-[12px] text-gray-500">
                  {r.ssp_category ? `→ ${r.category?.ssp_product_type} / ${r.ssp_category}` : "no SSP category"}
                </span>
                {gaps ? (
                  <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    {gaps} cost{gaps === 1 ? "" : "s"} unset
                  </span>
                ) : (
                  <span className="ml-auto text-[11px] text-emerald-700">complete</span>
                )}
              </button>

              {open ? (
                <div className="p-3 pt-0 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Select
                    label="SSP category"
                    value={r.ssp_category}
                    options={categoriesFor(r.category?.ssp_product_type)}
                    onChange={(v) => patch(r.id, "ssp_category", v)}
                  />
                  <Select
                    label="Material type"
                    value={r.material_type}
                    options={vocab.materialType}
                    onChange={(v) => patch(r.id, "material_type", v)}
                  />
                  <Text label="Metal purity" value={r.metal_purity} onChange={(v) => patch(r.id, "metal_purity", v)} />
                  <Text label="Metal karat" value={r.metal_karat} onChange={(v) => patch(r.id, "metal_karat", v)} hint="blank for silver" />
                  <Text label="Metal color" value={r.metal_color} onChange={(v) => patch(r.id, "metal_color", v)} />
                  <Select
                    label="Nickel content"
                    value={r.nickel_content}
                    options={vocab.metalNickelContent}
                    onChange={(v) => patch(r.id, "nickel_content", v)}
                  />
                  <Text label="Metal loss %" value={r.metal_loss_percent} onChange={(v) => patch(r.id, "metal_loss_percent", v)} />

                  <Select
                    label="Stone category"
                    value={r.stone_category}
                    options={vocab.categories}
                    onChange={(v) => patch(r.id, "stone_category", v)}
                  />
                  <Text label="Stone clarity" value={r.stone_clarity} onChange={(v) => patch(r.id, "stone_clarity", v)} />
                  <Select
                    label="Setting type"
                    value={r.setting_type}
                    options={vocab.settingTypes}
                    onChange={(v) => patch(r.id, "setting_type", v)}
                  />
                  <Select
                    label="Setting method"
                    value={r.setting_method}
                    options={vocab.settingMethods}
                    onChange={(v) => patch(r.id, "setting_method", v)}
                  />
                  <Text label="Setting / stone $" value={r.setting_charge_per_stone} onChange={(v) => patch(r.id, "setting_charge_per_stone", v)} />

                  <Text label="Finding type" value={r.finding_type} onChange={(v) => patch(r.id, "finding_type", v)} />
                  <Select
                    label="Finding material"
                    value={r.finding_material_type}
                    options={vocab.materialType}
                    onChange={(v) => patch(r.id, "finding_material_type", v)}
                  />
                  <Text label="Finding labor $" value={r.finding_labor_cost} onChange={(v) => patch(r.id, "finding_labor_cost", v)} />

                  <Text label="Casting $" value={r.casting_cost} onChange={(v) => patch(r.id, "casting_cost", v)} />
                  <Text label="Assembly $" value={r.assembly_charge} onChange={(v) => patch(r.id, "assembly_charge", v)} />
                  <Text label="Labor / gram" value={r.labor_per_gram} onChange={(v) => patch(r.id, "labor_per_gram", v)} />
                  <Select
                    label="Finishing type"
                    value={r.finishing_type}
                    options={vocab.finishingType}
                    onChange={(v) => patch(r.id, "finishing_type", v)}
                  />
                  <Text label="Finishing $" value={r.finishing_cost} onChange={(v) => patch(r.id, "finishing_cost", v)} />

                  <Select
                    label="Packaging"
                    value={r.packaging_desc}
                    options={vocab.vdrPackagingDesc}
                    onChange={(v) => patch(r.id, "packaging_desc", v)}
                  />
                  <Text label="Packaging $" value={r.packaging_cost} onChange={(v) => patch(r.id, "packaging_cost", v)} />
                  <Text label="Tag qty" value={r.tag_qty} onChange={(v) => patch(r.id, "tag_qty", v)} />
                  <Text label="Tag $" value={r.tag_cost} onChange={(v) => patch(r.id, "tag_cost", v)} />
                  <Text label="Duty rate %" value={r.duty_rate} onChange={(v) => patch(r.id, "duty_rate", v)} />
                  <Text label="Country" value={r.country_of_origin} onChange={(v) => patch(r.id, "country_of_origin", v)} />

                  <div className="col-span-2 md:col-span-4 flex items-center gap-2">
                    <input
                      className="flex-1 border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
                      placeholder="Notes"
                      value={r.notes || ""}
                      onChange={(e) => patch(r.id, "notes", e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => save(r)}
                      disabled={saving === r.id}
                      className="px-3 py-2 rounded-lg bg-[#C5A572] text-white text-[13px] disabled:opacity-50"
                    >
                      {saving === r.id ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Text({ label, value, onChange, hint }) {
  return (
    <label className="block">
      <span className="text-[12px] text-gray-600">{label}</span>
      <input
        className="mt-1 block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      {hint ? <span className="text-[11px] text-gray-400">{hint}</span> : null}
    </label>
  );
}

function Select({ label, value, options, onChange }) {
  const list = options || [];
  return (
    <label className="block">
      <span className="text-[12px] text-gray-600">{label}</span>
      <select
        className="mt-1 block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">(none)</option>
        {list.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
