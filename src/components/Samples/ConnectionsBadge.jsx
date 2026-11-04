import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";

const SYSTEMS = [
  ["qb", "QuickBooks"],
  ["ssp", "Signet SSP"],
  ["orderstream", "OrderStream"],
];
const fmt = (d) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

// Small link icon on the sample card. Dots show which systems the style has been on; click for details.
export default function ConnectionsBadge({ connections = {}, sspCode = null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const on = { ...connections };
  if (sspCode && !on.ssp) on.ssp = { ref: sspCode };
  const skus = on.skus || [];
  const count = SYSTEMS.filter(([k]) => on[k]).length;
  return (
    <span ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title={`On ${count} of 3: ${SYSTEMS.filter(([k]) => on[k]).map(([, n]) => n).join(", ") || "none yet"}`}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-gray-100 ${count ? "text-emerald-700" : "text-gray-400"}`}
      >
        <Link2 className="w-4 h-4" />
        <span className="flex gap-0.5">
          {SYSTEMS.map(([k]) => <span key={k} className={`h-1.5 w-1.5 rounded-full ${on[k] ? "bg-emerald-500" : "bg-gray-300"}`} />)}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-56 rounded border bg-white p-2 text-xs shadow-lg">
          {SYSTEMS.map(([k, name]) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span className={`h-2 w-2 rounded-full ${on[k] ? "bg-emerald-500" : "bg-gray-300"}`} />
              <span className="font-medium">{name}</span>
              <span className="ml-auto truncate text-gray-500">{on[k] ? [on[k].ref, fmt(on[k].at)].filter(Boolean).join(" · ") || "yes" : "not yet"}</span>
            </div>
          ))}
          {skus.length > 0 && (
            <div className="mt-1 border-t pt-1">
              <div className="font-medium text-gray-600">SKUs</div>
              {skus.slice(0, 12).map((k) => <div key={k.vendor_sku} className="flex justify-between gap-2 text-gray-500"><span className="truncate">{k.vendor_sku}</span><span>{k.merchant_sku || ""}</span></div>)}
              {skus.length > 12 && <div className="text-gray-400">+{skus.length - 12} more</div>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
