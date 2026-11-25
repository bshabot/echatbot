// src/utils/signetRef.js
// Classifies a Signet "Vendor Invoice#" string (CB / LP / QC / ZALELATE / PAC / dropship / RP repayment).
// Tiny and dependency-free so both signetAp.js and signetQbMatch.js can use it without importing each other.

const clean = (v) => (v == null ? "" : String(v).trim());

// ── reference classification ───────────────────────────────────────────────
export const DEDUCTION_KINDS = new Set(["price_variance", "late", "qc", "zales_late", "allowance", "unknown"]);

function classifyBase(ref) {
  let m;
  if (/^6\d{8}$/.test(ref)) return { kind: "dropship" };
  if (/^CB\d+$/.test(ref)) return { kind: "price_variance" };
  if (/^CB\d+[A-Z]+$/.test(ref)) return { kind: "unknown", fee: ref.replace(/^CB\d+/, "") }; // CB01520871FRT = freight fee
  if ((m = ref.match(/^LP(\d+)SKU(\d{8})(\d{6})?$/))) {
    return { kind: "late", po: m[1], sku: m[2], date: m[3] ? `20${m[3].slice(0, 2)}-${m[3].slice(2, 4)}-${m[3].slice(4, 6)}` : null };
  }
  if ((m = ref.match(/^LP(\d+)/))) return { kind: "late", po: m[1] };
  if ((m = ref.match(/^QC(\d+)\/(\d+)(?:SKU(\d+))?$/))) return { kind: "qc", po: m[1], line: m[2], sku: m[3] || null };
  if ((m = ref.match(/^(\d+)\/(\d+)QCCB$/))) return { kind: "qc", po: m[1], line: m[2] };
  if (/^ZALELATE/.test(ref)) return { kind: "zales_late" };
  if (/^PAC/.test(ref)) return { kind: "allowance" };
  if (/^\d+$/.test(ref)) return { kind: "invoice" };
  return { kind: "unknown" };
}

/**
 * Classify a Vendor Invoice# string.
 * → { kind: invoice|dropship|price_variance|late|qc|zales_late|allowance|unknown,
 *     isRepayment, base (ref without RP), po, line, sku }
 */
export function classifyRef(raw) {
  const ref = clean(raw).toUpperCase();
  const withoutRp = ref.replace(/RP$/, "");
  const b = classifyBase(withoutRp);
  const isRepayment = /RP$/.test(ref) && withoutRp.length >= 3 && (DEDUCTION_KINDS.has(b.kind) && (b.kind !== "unknown" || /[A-Z/]/.test(withoutRp)));
  if (isRepayment) return { po: null, line: null, sku: null, ...b, isRepayment: true, base: withoutRp };
  const c = classifyBase(ref);
  return { po: null, line: null, sku: null, ...c, isRepayment: false, base: ref };
}

