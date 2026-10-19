import { STONE_FIELDS } from "./fields.js";

const labelCls = "block text-xs font-medium text-gray-600 mb-1";
const inputCls = "input !p-1.5 text-sm";

export function Field({ label, children, className = "" }) {
  return (
    <label className={className}>
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options, blank = true }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {blank && <option value="" />}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function StonesEditor({ stones, onChange }) {
  const set = (i, key, value) => onChange(stones.map((s, idx) => (idx === i ? { ...s, [key]: value } : s)));
  return (
    <div className="space-y-2">
      {stones.map((s, i) => (
        <div key={i} className="grid grid-cols-6 gap-2 items-end">
          {STONE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                className={inputCls}
                type={f.number ? "number" : "text"}
                min={f.number ? 0 : undefined}
                maxLength={60}
                value={s[f.key] ?? ""}
                onChange={(e) => set(i, f.key, e.target.value)}
              />
            </Field>
          ))}
          <button type="button" className="text-sm text-red-600 pb-2" onClick={() => onChange(stones.filter((_, idx) => idx !== i))}>
            Remove
          </button>
        </div>
      ))}
      {stones.length < 10 && (
        <button type="button" className="text-sm text-chabot-gold" onClick={() => onChange([...stones, {}])}>
          + Add stone
        </button>
      )}
    </div>
  );
}

// One item, vertical form. Used for editing a submitted row.
export default function ItemForm({ row, info, onChange }) {
  const set = (key, value) => {
    const next = { ...row, [key]: value };
    if (key === "metal_type") next.karat = info.metals?.[value]?.[0] ?? "";
    onChange(next);
  };
  const karats = info.metals?.[row.metal_type] ?? [];
  const text = (key, label, extra = {}) => (
    <Field label={label} className={extra.className}>
      <input className={inputCls} maxLength={extra.max ?? 60} value={row[key]} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );
  const num = (key, label) => (
    <Field label={label}>
      <input className={inputCls} inputMode="decimal" value={row[key]} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {text("style_number", "Style number *", { max: 40 })}
        {text("manufacturer_code", "Manufacturer code", { max: 40 })}
        <Field label="Type">
          <Select value={row.type} onChange={(v) => set("type", v)} options={info.types ?? []} />
        </Field>
        <Field label="Metal *">
          <Select value={row.metal_type} onChange={(v) => set("metal_type", v)} options={Object.keys(info.metals ?? {})} blank={false} />
        </Field>
        <Field label="Karat *">
          <Select value={row.karat} onChange={(v) => set("karat", v)} options={karats} blank={false} />
        </Field>
        <Field label="Color">
          <Select value={row.color} onChange={(v) => set("color", v)} options={info.colors ?? []} />
        </Field>
        <Field label="Plating">
          <Select value={row.plating} onChange={(v) => set("plating", v)} options={info.plating ?? []} />
        </Field>
        <Field label="Sells as">
          <Select value={row.selling_pair} onChange={(v) => set("selling_pair", v)} options={info.sellingPair ?? []} blank={false} />
        </Field>
        {num("weight", "Weight (g) *")}
        {num("length", "Length (in)")}
        {num("width", "Width (in)")}
        {num("height", "Height (in)")}
        <Field label="Back type">
          <Select value={row.back_type} onChange={(v) => set("back_type", v)} options={info.backTypes ?? []} />
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {text("detail", "Detail", { max: 300 })}
        {text("description", "Description", { max: 500 })}
      </div>
      <div>
        <div className={labelCls}>Stones</div>
        <StonesEditor stones={row.stones} onChange={(stones) => set("stones", stones)} />
      </div>
    </div>
  );
}
