import { isRingType, takesExtension } from "./fields.js";
import { parseStoneCodes, describeStone } from "./stones.js";
import CadFiles from "./CadFiles.jsx";

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

export // Stones are typed as vendors already send them (one code per stone), with a live read-back.
function StoneCodes({ value, onChange, error }) {
  const { stones } = parseStoneCodes(value);
  return (
    <div className="space-y-2">
      <textarea
        className={inputCls + " h-20" + (error ? errCls : "")}
        maxLength={300}
        placeholder={"One code per stone, e.g.\nRS1.65-10\npearl6.0-1"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-gray-500">Separate stones with a comma or a new line.</p>
      {stones.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {stones.map((s, i) => (
            <li
              key={i}
              className={"text-xs rounded border px-2 py-1 " + (s.type === "Other" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-700")}
              title={s.type === "Other" ? "Not a code we know yet. It is sent as written." : undefined}
            >
              {s.type === "Other" ? `${s.notes} (sent as written)` : describeStone(s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One item, vertical form. `errors` (from validateRow) is shown only when `showErrors` is set.
export default function ItemForm({ row, info, onChange, errors = {}, showErrors = false, onSessionLost, hideFiles = false }) {
  const set = (key, value) => {
    const next = { ...row, [key]: value };
    if (key === "metal_type") next.karat = info.metals?.[value]?.[0] ?? "";
    onChange(next);
  };
  // Uploads finish at different times, so file changes are applied to the latest row, not a stale copy.
  const setFiles = (fn) => onChange((prev) => ({ ...prev, files: fn(prev.files || []) }));
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {text("manufacturer_code", "Manufacturer code *", { max: 40, placeholder: "Your code for this item" })}
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
          {num("sales_weight", "Total weight (grams)", "our sales weight")}
          {num("length", "Length (mm)")}
          {num("width", "Width (mm)")}
          {isRingType(row.type) ? num("ring_size", "Ring size", "e.g. 7.25") : num("height", "Height (mm)")}
          {takesExtension(row.type) && num("extension", "Extension (mm)")}
        </div>
      </Section>

      <Section title="Factory cost *" hint="what it costs to make one piece">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {num("factory_cost", "Cost each *", "e.g. 1.80")}
          <Field label="Currency *" error={err("cost_currency")}>
            <select className={inputCls} value={row.cost_currency} onChange={(e) => set("cost_currency", e.target.value)}>
              {row.cost_currency === "" && <option value="" />}
              <option value="USD">USD ($)</option>
              <option value="RMB">RMB (¥)</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Notes" hint="optional">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {text("detail", "Detail", { max: 300 })}
          {text("description", "Description", { max: 500 })}
        </div>
      </Section>

      {!hideFiles && (
        <Section title="CAD files" hint="optional, up to 3">
          <CadFiles files={row.files || []} setFiles={setFiles} onSessionLost={onSessionLost} />
          {err("files") && <p className="text-xs text-red-600">{errors.files}</p>}
        </Section>
      )}

      <Section title="Stones" hint="optional, up to 10">
        <StoneCodes value={row.stones_text ?? ""} onChange={(v) => set("stones_text", v)} error={err("stones")} />
        {err("stones") && <p className="text-xs text-red-600">{errors.stones}</p>}
      </Section>
    </div>
  );
}
