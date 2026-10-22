import { STONE_TYPES, STONE_COLORS } from "./fields.js";

const labelCls = "block text-xs font-medium text-gray-600 mb-1";
const inputCls = "input !p-1.5 text-sm w-full";
const errCls = " !border-red-400 !bg-red-50";

export function Field({ label, children, className = "", error }) {
  return (
    <label className={className}>
      <span className={labelCls}>{label}</span>
      {children}
      {error && <span className="block text-xs text-red-600 mt-1">{error}</span>}
    </label>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      {children}
    </section>
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
  const lower = (v) => (v ?? "").toLowerCase();
  return (
    <div className="space-y-3">
      {stones.map((s, i) => (
        <div key={i} className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end border rounded-lg p-3 bg-gray-50">
          <Field label="Type">
            <select className={inputCls} value={lower(s.type)} onChange={(e) => set(i, "type", e.target.value)}>
              <option value="" />
              {STONE_TYPES.map((o) => (
                <option key={o} value={o.toLowerCase()}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Color">
            <select className={inputCls} value={lower(s.color)} onChange={(e) => set(i, "color", e.target.value)}>
              <option value="" />
              {STONE_COLORS.map((o) => (
                <option key={o} value={o.toLowerCase()}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Shape">
            <input className={inputCls} maxLength={60} placeholder="e.g. round" value={s.shape ?? ""} onChange={(e) => set(i, "shape", e.target.value)} />
          </Field>
          <Field label="Size (mm)">
            <input className={inputCls} maxLength={60} placeholder="e.g. 6" value={s.size ?? ""} onChange={(e) => set(i, "size", e.target.value)} />
          </Field>
          <Field label="Quantity">
            <input className={inputCls} type="number" min="1" max="9999" value={s.quantity ?? ""} onChange={(e) => set(i, "quantity", e.target.value)} />
          </Field>
          <button type="button" className="text-sm text-red-600 pb-2 text-left" onClick={() => onChange(stones.filter((_, idx) => idx !== i))}>
            Remove
          </button>
        </div>
      ))}
      {stones.length < 10 && (
        <button type="button" className="text-sm text-chabot-gold" onClick={() => onChange([...stones, { type: "cz", color: "white", quantity: "1" }])}>
          + Add stone
        </button>
      )}
    </div>
  );
}

// One item, vertical form. `errors` (from validateRow) is shown only when `showErrors` is set.
export default function ItemForm({ row, info, onChange, errors = {}, showErrors = false }) {
  const set = (key, value) => {
    const next = { ...row, [key]: value };
    if (key === "metal_type") next.karat = info.metals?.[value]?.[0] ?? "";
    onChange(next);
  };
  const err = (k) => (showErrors ? errors[k] : undefined);
  const karats = info.metals?.[row.metal_type] ?? [];
  const text = (key, label, extra = {}) => (
    <Field label={label} className={extra.className} error={err(key)}>
      <input
        className={inputCls + (err(key) ? errCls : "")}
        maxLength={extra.max ?? 60}
        placeholder={extra.placeholder}
        value={row[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const num = (key, label, placeholder) => (
    <Field label={label} error={err(key)}>
      <input
        className={inputCls + (err(key) ? errCls : "")}
        inputMode="decimal"
        placeholder={placeholder}
        value={row[key]}
        onChange={(e) => set(key, e.target.value.replace(/[^0-9.]/g, ""))}
      />
    </Field>
  );
  return (
    <div className="space-y-5">
      <Section title="Item">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {text("style_number", "Style number *", { max: 40, placeholder: "Your style number" })}
          {text("manufacturer_code", "Manufacturer code", { max: 40 })}
          <Field label="Type">
            <Select value={row.type} onChange={(v) => set("type", v)} options={info.types ?? []} />
          </Field>
        </div>
      </Section>

      <Section title="Metal and finish">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Metal *">
            <Select value={row.metal_type} onChange={(v) => set("metal_type", v)} options={Object.keys(info.metals ?? {})} blank={false} />
          </Field>
          <Field label="Karat *">
            <Select value={row.karat} onChange={(v) => set("karat", v)} options={karats} blank={false} />
          </Field>
          <Field label="Metal color">
            <Select value={row.color} onChange={(v) => set("color", v)} options={info.colors ?? []} />
          </Field>
          <Field label="Plating">
            <Select value={row.plating} onChange={(v) => set("plating", v)} options={info.plating ?? []} />
          </Field>
        </div>
      </Section>

      <Section title="Weight and size">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {num("weight", "Weight (grams) *", "e.g. 1.25")}
          {num("length", "Length (inches)")}
          {num("width", "Width (inches)")}
          {num("height", "Height (inches)")}
        </div>
      </Section>

      <Section title="Notes" hint="optional">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {text("detail", "Detail", { max: 300 })}
          {text("description", "Description", { max: 500 })}
        </div>
      </Section>

      <Section title="Stones" hint="optional, up to 10">
        <StonesEditor stones={row.stones} onChange={(stones) => set("stones", stones)} />
        {err("stones") && <p className="text-xs text-red-600">{errors.stones}</p>}
      </Section>
    </div>
  );
}
