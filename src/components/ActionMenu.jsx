// src/components/ActionMenu.jsx
//
// One "Actions" button that holds a table's actions, instead of a row of
// buttons that grows every time a feature is added (the Purchase Orders
// header had reached seven, half of them appearing and disappearing with
// the selection, which made the toolbar jump around as you clicked).
//
// Items are plain data, so a page declares WHAT its actions are and this
// owns how they look and behave:
//
//   { key, label, icon, onClick, disabled, hidden, busy, title, danger }
//   { key, label, icon, file: { accept, onChange } }   // upload item
//   { key, section: "QuickBooks" }                     // group heading
//   { key, separator: true }                           // divider
//   { key, render: () => <jsx/> }                      // anything else
//
// `hint` on an item renders a muted second line — use it to say WHY an item
// is disabled ("select POs first") instead of hiding it. A feature that
// vanishes when the selection is empty reads as broken; one that's greyed
// out with a reason reads as waiting for you.
//
// Notes on the behavior, since these are the bits usually skipped:
//   - closes on outside click, on Escape, and after any item runs
//   - `hidden` items are dropped entirely, so a page can keep using
//     `selectedIds.size > 0` conditions without leaving gaps or stray
//     separators
//   - a `busy` item stays visible and disabled with its own label, so a
//     running sync is still legible from the closed button
//   - the file item is a <label> wrapping a hidden <input type="file">,
//     which is the only way to keep native file picking inside a menu

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export default function ActionMenu({
  label = "Actions",
  items = [],
  count,
  className = "",
  align = "right",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = items.filter((i) => i && !i.hidden);
  // Drop separators that ended up leading, trailing, or doubled once the
  // hidden items were removed.
  const cleaned = visible.filter((item, i, arr) => {
    // A section heading with no items under it is noise — drop it.
    if (item.section) {
      const next = arr[i + 1];
      return next && !next.section && !next.separator;
    }
    if (!item.separator) return true;
    if (i === 0 || i === arr.length - 1) return false;
    return !arr[i - 1]?.separator && !arr[i - 1]?.section;
  });
  const anyBusy = cleaned.some((i) => i.busy);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 inline-flex items-center gap-1.5"
      >
        {label}
        {count > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-[#C5A572] text-white text-[10px] leading-none">
            {count}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""} ${
            anyBusy ? "animate-pulse" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-30 mt-1 min-w-[15rem] rounded-md border border-gray-200 bg-white shadow-lg py-1 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {cleaned.map((item) => {
            if (item.separator) {
              return <div key={item.key} className="my-1 border-t border-gray-100" />;
            }
            if (item.section) {
              return (
                <div
                  key={item.key}
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400"
                >
                  {item.section}
                </div>
              );
            }
            if (item.render) {
              return (
                <div key={item.key} className="px-3 py-1.5 text-xs text-gray-500">
                  {item.render()}
                </div>
              );
            }

            const Icon = item.icon;
            const base =
              "w-full text-left px-3 py-2 text-xs inline-flex items-start gap-2 " +
              (item.disabled
                ? "text-gray-400 cursor-not-allowed"
                : item.danger
                  ? "text-red-600 hover:bg-red-50"
                  : "text-gray-700 hover:bg-gray-50");

            if (item.file) {
              return (
                <label
                  key={item.key}
                  title={item.title}
                  className={`${base} cursor-pointer ${
                    item.disabled ? "pointer-events-none" : ""
                  }`}
                >
                  {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0" />}
                  <span className="flex-1">
                    {item.label}
                    {item.hint && (
                      <span className="block text-[10px] text-gray-400">{item.hint}</span>
                    )}
                  </span>
                  <input
                    type="file"
                    accept={item.file.accept}
                    className="hidden"
                    onChange={(e) => {
                      setOpen(false);
                      item.file.onChange(e);
                    }}
                  />
                </label>
              );
            }

            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                title={item.title}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                className={base}
              >
                {Icon && (
                  <Icon
                    className={`w-3.5 h-3.5 flex-shrink-0 ${item.busy ? "animate-spin" : ""}`}
                  />
                )}
                <span className="flex-1">
                  {item.label}
                  {item.hint && (
                    <span className="block text-[10px] text-gray-400 font-normal">
                      {item.hint}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
