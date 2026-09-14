import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";

/**
 * SSP defaults, assembled from three interlocking pieces rather than one
 * template per combination:
 *
 *   material  -> ssp_metal_defaults   (4 rows: 925, 10K, 14K, brass)
 *   category  -> the type list        (9 rows, the `category` table)
 *   plating   -> the plating list     (9 rows, sits on top of the metal)
 *
 * A sample resolves all three at send time and anything set on the record
 * itself wins. Nothing repeats between the pieces, so each value is edited in
 * exactly one place.
 *
 * Every dropdown is fed from `ssp_vocabulary`, seeded from SSP's own
 * get-filters responses -- a value SSP does not recognise cannot be picked.
 * platingColor and metalAlloyColor are dependent lists (keyed by the parent
 * material), which is why vocabulary rows carry a `parent`.
 */
export default function SspDefaultsCard() {
  const { supabase } = useSupabase();
  const [metals, setMetals] = useState([]);
  const [types, setTypes] = useState([]);
  const [platings, setPlatings] = useState([]);
  const [vocab, setVocab] = useState([]);
  const [sspCategories, setSspCategories] = useState([]);
  const [open, setOpen] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, t, p, v, c] = await Promise.all([
        supabase.from("ssp_metal_defaults").select("*").order("metal_type").order("karat"),
        supabase.from("category").select("*").order("name"),
        supabase.from("plating").select("*, layers:plating_layers(*)").order("name"),
        supabase.from("ssp_vocabulary").select("field,parent,value").eq("is_active", true).order("value"),
        supabase.from("ssp_product_categories").select("product_type,category").order("category"),
      ]);
      if (cancelled) return;
      const err = m.error || t.error || p.error || v.error || c.error;
      if (err) setError(err.message);
      setMetals(m.data || []);
      setTypes(t.data || []);
      setPlatings(p.data || []);
      setVocab(v.data || []);
      setSspCategories(c.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const list = useMemo(() => {
    const g = {};
    for (const r of vocab) (g[r.field] ||= []).push(r);
    return g;
  }, [vocab]);

  const opts = (field, parent) =>
    (list[field] || [])
      .filter((r) => (parent === undefined ? true : (r.parent || "") === (parent || "")))
      .map((r) => r.value);

  const categoriesFor = (productType) =>
    sspCategories.filter((c) => c.product_type === productType).map((c) => c.category);

  const save = async (table, row, fields, setter) => {
    setSaving(`${table}:${row.id}`);
    setError("");
    const body = {};
    for (const f of fields) body[f] = row[f] === "" ? null : row[f];
    if (table !== "plating") body.updated_at = new Date().toISOString();
    const { error: err } = await supabase.from(table).update(body).eq("id", row.id);
    if (err) setError(err.message);
    setSaving(null);
  };

  const patch = (setter) => (id, key, value) =>
    setter((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));

  const patchLayer = (platingId, layerId, key, value) =>
    setPlatings((prev) =>
      prev.map((p) =>
        p.id === platingId
          ? { ...p, layers: (p.layers || []).map((l) => (l.id === layerId ? { ...l, [key]: value } : l)) }
          : p
      )
    );

  const saveLayers = async (row) => {
    setSaving(`plating:${row.id}`);
    setError("");
    for (const l of row.layers || []) {
      const { error: err } = await supabase
        .from("plating_layers")
        .update({
          plating_material: l.plating_material || null,
          plating_color: l.plating_color || null,
          plating_method: l.plating_method || null,
          plating_micron: l.plating_micron === "" ? null : l.plating_micron,
          plating_cost: l.plating_cost === "" ? null : l.plating_cost,
          plating_coverage: l.plating_coverage || null,
        })
        .eq("id", l.id);
      if (err) setError(err.message);
    }
    setSaving(null);
  };

  const addLayer = async (row) => {
    const next = Math.max(0, ...(row.layers || []).map((l) => l.sequence)) + 1;
    const { data, error: err } = await supabase
      .from("plating_layers")
      .insert({ plating_id: row.id, sequence: next })
      .select()
      .single();
    if (err) return setError(err.message);
    setPlatings((prev) =>
      prev.map((p) => (p.id === row.id ? { ...p, layers: [...(p.layers || []), data] } : p))
    );
  };

  const removeLayer = async (row, layer) => {
    const { error: err } = await supabase.from("plating_layers").delete().eq("id", layer.id);
    if (err) return setError(err.message);
    setPlatings((prev) =>
      prev.map((p) =>
        p.id === row.id ? { ...p, layers: (p.layers || []).filter((l) => l.id !== layer.id) } : p
      )
    );
  };

  if (loading) return <div className="text-[13px] text-gray-500">Loading…</div>;

  const METAL_FIELDS = ["material_type","metal_purity","metal_karat","metal_color","nickel_content","metal_loss_percent","notes"];
  const TYPE_FIELDS = ["ssp_category","stone_category","stone_clarity","setting_type","setting_method","setting_charge_per_stone","finding_type","finding_material_type","finding_labor_cost","casting_cost","assembly_charge","labor_per_gram","finishing_type","finishing_cost","packaging_desc","packaging_cost","tag_qty","tag_cost","duty_rate","country_of_origin"];

  return (
    <div className="space-y-6">
      {error ? <div className="text-[13px] text-red-600">{error}</div> : null}

      <Section title="Material" hint="What the metal itself implies. 4 rows cover the catalog.">
        {metals.map((r) => (
          <Row
            key={r.id}
            id={`metal:${r.id}`}
            open={open === `metal:${r.id}`}
            onToggle={() => setOpen(open === `metal:${r.id}` ? null : `metal:${r.id}`)}
            title={`${r.metal_type} ${r.karat}`}
            subtitle={r.material_type ? `${r.material_type} · purity ${r.metal_purity ?? "—"}` : "not set"}
            saving={saving === `ssp_metal_defaults:${r.id}`}
            onSave={() => save("ssp_metal_defaults", r, METAL_FIELDS)}
          >
            <Select label="Material type" value={r.material_type} options={opts("materialType")} onChange={(v) => patch(setMetals)(r.id, "material_type", v)} />
            <Select label="Metal purity" value={r.metal_purity == null ? "" : String(r.metal_purity)} options={opts("metalPurity", "")} onChange={(v) => patch(setMetals)(r.id, "metal_purity", v)} />
            <Text label="Metal karat" hint="blank for silver" value={r.metal_karat} onChange={(v) => patch(setMetals)(r.id, "metal_karat", v)} />
            <Select label="Metal color" value={r.metal_color} options={opts("metalAlloyColor", r.material_type)} onChange={(v) => patch(setMetals)(r.id, "metal_color", v)} />
            <Select label="Nickel content" value={r.nickel_content} options={opts("metalNickelContent")} onChange={(v) => patch(setMetals)(r.id, "nickel_content", v)} />
            <Text label="Metal loss %" value={r.metal_loss_percent} onChange={(v) => patch(setMetals)(r.id, "metal_loss_percent", v)} />
          </Row>
        ))}
      </Section>

      <Section title="Category" hint="What the product type implies — stone, setting, finding, labor, vendor cost.">
        {types.map((r) => (
          <Row
            key={r.id}
            id={`type:${r.id}`}
            open={open === `type:${r.id}`}
            onToggle={() => setOpen(open === `type:${r.id}` ? null : `type:${r.id}`)}
            title={r.name}
            subtitle={r.ssp_product_type ? `${r.ssp_product_type} / ${r.ssp_category || "—"}` : "no SSP type"}
            badge={[r.casting_cost, r.assembly_charge, r.setting_charge_per_stone, r.packaging_cost].filter((v) => v == null).length}
            saving={saving === `category:${r.id}`}
            onSave={() => save("category", r, TYPE_FIELDS)}
          >
            <Select label="SSP category" value={r.ssp_category} options={categoriesFor(r.ssp_product_type)} onChange={(v) => patch(setTypes)(r.id, "ssp_category", v)} />
            <Select label="Stone category" value={r.stone_category} options={opts("categories")} onChange={(v) => patch(setTypes)(r.id, "stone_category", v)} />
            <Text label="Stone clarity" value={r.stone_clarity} onChange={(v) => patch(setTypes)(r.id, "stone_clarity", v)} />
            <Select label="Setting type" value={r.setting_type} options={opts("settingTypes")} onChange={(v) => patch(setTypes)(r.id, "setting_type", v)} />
            <Select label="Setting method" value={r.setting_method} options={opts("settingMethods")} onChange={(v) => patch(setTypes)(r.id, "setting_method", v)} />
            <Text label="Setting / stone $" value={r.setting_charge_per_stone} onChange={(v) => patch(setTypes)(r.id, "setting_charge_per_stone", v)} />
            <Text label="Finding type" value={r.finding_type} onChange={(v) => patch(setTypes)(r.id, "finding_type", v)} />
            <Select label="Finding material" value={r.finding_material_type} options={opts("materialType")} onChange={(v) => patch(setTypes)(r.id, "finding_material_type", v)} />
            <Text label="Finding labor $" value={r.finding_labor_cost} onChange={(v) => patch(setTypes)(r.id, "finding_labor_cost", v)} />
            <Text label="Casting $" value={r.casting_cost} onChange={(v) => patch(setTypes)(r.id, "casting_cost", v)} />
            <Text label="Assembly $" value={r.assembly_charge} onChange={(v) => patch(setTypes)(r.id, "assembly_charge", v)} />
            <Text label="Labor / gram" value={r.labor_per_gram} onChange={(v) => patch(setTypes)(r.id, "labor_per_gram", v)} />
            <Select label="Finishing type" value={r.finishing_type} options={opts("finishingType")} onChange={(v) => patch(setTypes)(r.id, "finishing_type", v)} />
            <Text label="Finishing $" value={r.finishing_cost} onChange={(v) => patch(setTypes)(r.id, "finishing_cost", v)} />
            <Select label="Packaging" value={r.packaging_desc} options={opts("vdrPackagingDesc")} onChange={(v) => patch(setTypes)(r.id, "packaging_desc", v)} />
            <Text label="Packaging $" value={r.packaging_cost} onChange={(v) => patch(setTypes)(r.id, "packaging_cost", v)} />
            <Text label="Tag qty" value={r.tag_qty} onChange={(v) => patch(setTypes)(r.id, "tag_qty", v)} />
            <Text label="Tag $" value={r.tag_cost} onChange={(v) => patch(setTypes)(r.id, "tag_cost", v)} />
            <Text label="Duty rate %" value={r.duty_rate} onChange={(v) => patch(setTypes)(r.id, "duty_rate", v)} />
            <Text label="Country" value={r.country_of_origin} onChange={(v) => patch(setTypes)(r.id, "country_of_origin", v)} />
          </Row>
        ))}
      </Section>

      <Section title="Plating" hint="Sits on top of the metal. SSP takes an array, so a plating can have more than one layer — BPT + GPT is black rhodium plus a gold plate. Colour is the plating's own (RHD and BPT are both rhodium and differ only by colour); the piece's colour drives the metal row instead.">
        {platings.map((r) => {
          const layers = [...(r.layers || [])].sort((a, b) => a.sequence - b.sequence);
          return (
            <Row
              key={r.id}
              id={`plat:${r.id}`}
              open={open === `plat:${r.id}`}
              onToggle={() => setOpen(open === `plat:${r.id}` ? null : `plat:${r.id}`)}
              title={r.name?.trim() || "(unnamed)"}
              subtitle={
                layers.length
                  ? layers
                      .map((l) => `${l.plating_material || "?"} ${l.plating_color || ""} ${l.plating_micron ?? "?"}mic`.replace(/\s+/g, " ").trim())
                      .join("  +  ")
                  : "no layers"
              }
              badge={layers.filter((l) => !l.plating_material || l.plating_micron == null).length}
              badgeLabel="incomplete"
              saving={saving === `plating:${r.id}`}
              onSave={() => saveLayers(r)}
              onAdd={() => addLayer(r)}
            >
              {layers.length === 0 ? (
                <div className="col-span-2 md:col-span-4 text-[12px] text-gray-500">
                  No layers. Add one, or leave empty for an unplated piece.
                </div>
              ) : null}
              {layers.map((l) => (
                <React.Fragment key={l.id}>
                  <div className="col-span-2 md:col-span-4 flex items-center gap-2 pt-1">
                    <span className="text-[12px] font-medium text-gray-700">Layer {l.sequence}</span>
                    <button
                      type="button"
                      onClick={() => removeLayer(r, l)}
                      className="text-[11px] text-red-600 hover:underline"
                    >
                      remove
                    </button>
                  </div>
                  <Select label="Material" value={l.plating_material} options={opts("platingMaterial")}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_material", v)} />
                  <Select label="Color" value={l.plating_color} options={opts("platingColor", l.plating_material)}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_color", v)} />
                  <Select label="Method" value={l.plating_method} options={opts("platingMethod")}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_method", v)} />
                  <Text label="Micron" value={l.plating_micron}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_micron", v)} />
                  <Text label="Cost $" value={l.plating_cost}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_cost", v)} />
                  <Select label="Coverage" value={l.plating_coverage} options={opts("platingCoverageClassification")}
                    onChange={(v) => patchLayer(r.id, l.id, "plating_coverage", v)} />
                </React.Fragment>
              ))}
            </Row>
          );
        })}
      </Section>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div>
      <div className="mb-2">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-[12px] text-gray-500">{hint}</div>
      </div>
      <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">{children}</div>
    </div>
  );
}

function Row({ open, onToggle, title, subtitle, badge, badgeLabel, saving, onSave, onAdd, children }) {
  return (
    <div>
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 p-3 text-left hover:bg-gray-50">
        {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[12px] text-gray-500">{subtitle}</span>
        {badge ? (
          <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            {badge} {badgeLabel || (badge === 1 ? "cost unset" : "costs unset")}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="p-3 pt-0">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{children}</div>
          <div className="mt-3 flex justify-end gap-2">
            {onAdd ? (
              <button type="button" onClick={onAdd}
                className="px-3 py-2 rounded-lg border border-gray-300 text-[13px]">
                Add layer
              </button>
            ) : null}
            <button type="button" onClick={onSave} disabled={saving}
              className="px-3 py-2 rounded-lg bg-[#C5A572] text-white text-[13px] disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
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
  return (
    <label className="block">
      <span className="text-[12px] text-gray-600">{label}</span>
      <select
        className="mt-1 block w-full border border-gray-300 rounded-lg p-2 bg-white text-[13px] outline-none focus:border-[#C5A572]"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">(none)</option>
        {(options || []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
