import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A single "Actions" button that drops a menu of the things you can do to the
 * current selection, instead of spraying one button per action across the bar.
 *
 * items: [{ key, label, icon, onClick, disabled, busy, busyLabel, description,
 *           tone: "default" | "danger" }]
 * Falsy entries are ignored, so callers can inline `qbOn && {...}`.
 */
export default function ActionMenu({ label = "Actions", count, items = [] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const usable = items.filter(Boolean);
  const busyItem = usable.find((i) => i.busy);

  // Close on outside click / Escape. Bound only while open so we're not
  // holding document listeners for every list on the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // A run that started from the menu keeps the trigger disabled until it
  // finishes — the menu itself is closed by then, so this is the only place
  // left to show that something is happening.
  useEffect(() => {
    if (busyItem) setOpen(false);
  }, [busyItem]);

  if (usable.length === 0) return null;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={Boolean(busyItem)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center disabled:opacity-60"
      >
        {busyItem ? busyItem.busyLabel || "Working…" : label}
        {!busyItem && count != null && ` (${count})`}
        <ChevronDown
          className={`w-4 h-4 ml-2 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-72 max-md:w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1 overflow-hidden"
        >
          {usable.map((item) => {
            const Icon = item.icon;
            const danger = item.tone === "danger";
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled || item.busy}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                title={item.title}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed ${
                  danger ? "hover:bg-red-50" : "hover:bg-gray-50"
                }`}
              >
                {Icon && (
                  <Icon
                    className={`w-4 h-4 mt-0.5 shrink-0 ${
                      danger ? "text-red-600" : "text-gray-500"
                    }`}
                  />
                )}
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium ${
                      danger ? "text-red-700" : "text-gray-800"
                    }`}
                  >
                    {item.busy ? item.busyLabel || "Working…" : item.label}
                  </span>
                  {item.description && (
                    <span className="block text-xs text-gray-500 mt-0.5">
                      {item.description}
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
