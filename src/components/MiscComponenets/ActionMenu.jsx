import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A single "Actions" button that drops a menu of the things you can do to the
 * current selection, instead of spraying one button per action across the bar.
 *
 * items: [{ key, label, icon, onClick, disabled, busy, busyLabel, description,
 *           group, tone: "default" | "danger" }]
 * `group` (optional) puts items under a small heading with a divider between
 * groups, e.g. "QuickBooks" / "Signet SSP", so long menus are easy to scan.
 * Falsy entries are ignored, so callers can inline `qbOn && {...}`.
 */
// Icon-chip colours per group so QuickBooks / SSP / etc. are told apart at a glance.
const GROUP_STYLE = {
  QuickBooks: { chip: "bg-green-50 text-green-700", head: "text-green-700" },
  "Signet SSP": { chip: "bg-blue-50 text-blue-700", head: "text-blue-700" },
};
const DEFAULT_STYLE = { chip: "bg-gray-100 text-gray-600", head: "text-gray-500" };

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
          className="absolute right-0 mt-1 w-96 max-md:w-72 max-h-[75vh] overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-30 py-1"
        >
          {(() => {
            // Collect items under their group heading, in first-seen order.
            const groups = [];
            usable.forEach((item) => {
              const name = item.group || "";
              let g = groups.find((x) => x.name === name);
              if (!g) groups.push((g = { name, items: [] }));
              g.items.push(item);
            });
            const showHeads = groups.some((g) => g.name);
            return groups.map((g, gi) => {
              const st = GROUP_STYLE[g.name] || DEFAULT_STYLE;
              return (
                <div key={g.name || "_"} className={gi > 0 ? "border-t border-gray-200 mt-1 pt-1" : ""}>
                  {showHeads && g.name && (
                    <div className={`px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide ${st.head}`}>
                      {g.name}
                    </div>
                  )}
                  {g.items.map((item) => {
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
                        className={`w-full text-left px-3 py-2 flex items-start gap-3 disabled:opacity-50 disabled:cursor-not-allowed ${
                          danger ? "hover:bg-red-50" : "hover:bg-gray-50"
                        }`}
                      >
                        {Icon && (
                          <span
                            className={`mt-0.5 w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${
                              danger ? "bg-red-50 text-red-600" : st.chip
                            }`}
                          >
                            <Icon className="w-4 h-4" />
                          </span>
                        )}
                        <span className="min-w-0">
                          <span
                            className={`block text-sm font-semibold ${
                              danger ? "text-red-700" : "text-gray-900"
                            }`}
                          >
                            {item.busy ? item.busyLabel || "Working…" : item.label}
                          </span>
                          {item.description && (
                            <span className="block text-xs leading-snug text-gray-500 mt-0.5">
                              {item.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
