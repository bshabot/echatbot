// Small shared pieces for the Signet AP page (styled to Brian's mockups: flat grid rows, 44px controls).
import { fmtMoney } from "../../utils/signetApView";

export const money = fmtMoney;
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

const BTN = "min-h-[44px] rounded-lg border px-4 text-sm font-semibold";
export const btnPrimary = `${BTN} border-[#111827] bg-[#111827] text-white`;
export const btnDanger = `${BTN} border-[#9a3412] bg-white text-[#9a3412] hover:bg-orange-50`;
export const btnOutline = `${BTN} border-[#d1d5db] bg-white text-[#111827] hover:bg-gray-50 disabled:opacity-40`;
export const cardCls = "rounded-[10px] border border-[#e5e7eb] bg-white px-5 py-4";
export const rowCls = "border-b border-[#f3f4f6]";
export const headCls = "pb-2.5 text-xs text-[#4b5563] border-b border-[#e5e7eb]";

/** Sub-tab buttons: active = solid dark, others outline. */
export function SubTabs({ value, onChange, items }) {
  return (
    <div className="flex gap-2">
      {items.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={value === t.id ? btnPrimary : `${BTN} border-[#d1d5db] bg-white font-normal text-[#111827] hover:bg-gray-50`}>
          {t.label}{t.count != null ? ` · ${t.count}` : ""}
        </button>
      ))}
    </div>
  );
}

/** "Grouped | Line items" switch, sits right-aligned next to the sub-tabs. */
export function ViewSwitch({ value, onChange }) {
  const opt = (id, label) => (
    <button key={id} onClick={() => onChange(id)} aria-pressed={value === id}
      className={`min-h-[44px] px-3 text-sm ${value === id ? "bg-[#111827] font-semibold text-white" : "bg-white text-[#111827] hover:bg-gray-50"}`}>{label}</button>
  );
  return <div className="ml-auto flex overflow-hidden rounded-lg border border-[#d1d5db]">{opt("grouped", "Grouped")}{opt("lines", "Line items")}</div>;
}

/** Memo input. Saves on blur; key={value} re-seeds it after a save. */
export function MemoBox({ value, onSave, placeholder = "What is this?" }) {
  return (
    <input
      key={value} type="text" aria-label="Memo" defaultValue={value} placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => e.target.value !== value && onSave(e.target.value)}
      className="min-h-[44px] w-full rounded-lg border border-[#d1d5db] px-3 text-sm text-[#111827]"
    />
  );
}

/** A posting button that is intentionally switched off in this build. */
export function PostButton({ children, className = "px-3.5" }) {
  return (
    <span title={POST_TIP} className="inline-block">
      <button disabled className={`min-h-[44px] cursor-not-allowed rounded-lg border border-[#111827] bg-[#111827] text-sm font-semibold text-white opacity-40 ${className}`}>{children}</button>
    </span>
  );
}

export const TH = "px-2 py-1";
export const THEAD = "sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_0_#e5e7eb] text-left text-xs uppercase text-gray-500";
