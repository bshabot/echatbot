// Small shared pieces for the Signet AP page.
export const money = (n) => (n === "" || n == null ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" }));
export const POST_TIP = "Posting to QuickBooks comes next";

const TONES = {
  gray: "bg-gray-100 text-gray-600 border-gray-300",
  green: "bg-emerald-100 text-emerald-700 border-emerald-300",
  red: "bg-red-100 text-red-700 border-red-300",
  amber: "bg-amber-100 text-amber-700 border-amber-300",
  yellow: "bg-yellow-100 text-yellow-800 border-yellow-300",
  blue: "bg-blue-100 text-blue-700 border-blue-300",
  sky: "bg-sky-100 text-sky-700 border-sky-300",
};

export function Chip({ tone = "gray", title, children }) {
  return <span title={title} className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${TONES[tone] || TONES.gray}`}>{children}</span>;
}

export function SubTabs({ value, onChange, items }) {
  return (
    <div className="flex gap-2">
      {items.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={`rounded px-3 py-1 text-sm ${value === t.id ? "bg-gray-900 text-white" : "border bg-white hover:bg-gray-50"}`}>
          {t.label}{t.count != null && <span className="ml-1 opacity-70">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Saves on blur. key={value} re-seeds the box after a save. */
export function MemoBox({ value, onSave, placeholder = "Memo…", className = "w-64" }) {
  return (
    <textarea
      key={value} defaultValue={value} rows={1} placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => e.target.value !== value && onSave(e.target.value)}
      className={`${className} rounded border px-1 py-0.5 text-xs`}
    />
  );
}

/** A posting button that is intentionally switched off in this build. */
export function PostButton({ children }) {
  return (
    <span title={POST_TIP} className="inline-block">
      <button disabled className="cursor-not-allowed rounded border bg-gray-50 px-2 py-1 text-xs text-gray-400">{children}</button>
    </span>
  );
}

export function Stat({ label, value, sub, tone }) {
  const c = tone === "red" ? "border-red-300 bg-red-50" : tone === "yellow" ? "border-yellow-300 bg-yellow-50" : "bg-white";
  return (
    <div className={`min-w-[10rem] rounded border px-3 py-2 ${c}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export const TH = "px-2 py-1";
export const THEAD = "sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_0_#e5e7eb] text-left text-xs uppercase text-gray-500";
