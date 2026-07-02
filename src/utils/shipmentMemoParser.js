// shipmentMemoParser.js — explode a Signet PO memo into vendor-PO entries.
// Spec: Shipments Tracker GRAND BUILD PLAN §handoff 3.4 + Appendix B (real data).
// Returns { entries: [{ vendorPo, vendor, vendorCode }], notes: [], unresolved: [] }
// unresolved = tokens we refuse to guess on -> row gets link_source 'needs_link'.
// Validated 7/1/26 against all 77 live memos: 46/50 distinct forms parse clean,
// the rest (pure free text like "brass") correctly fall to needs_link.

const VENDOR_BY_CODE = [
  { re: /^AOX/i, vendor: "Aoxin" },   // AOX, AOXIN, AOXI, Aox...
  { re: /^AX$/i, vendor: "Aoxin" },   // AX variant (seen: "12379AX")
  { re: /^A$/i, vendor: "Amtai" },
  { re: /^C$/i, vendor: "CIJ" },
  { re: /^(INAH|INA|I)$/i, vendor: "Inah" },
];

const FREE_TEXT_VENDORS = [
  { re: /amtai/i, vendor: "Amtai" },
  { re: /aoxin|aox/i, vendor: "Aoxin" },
  { re: /inah/i, vendor: "Inah" },
  { re: /cij|china\s*ideal/i, vendor: "CIJ" },
];

const NOISE_WORDS = ["verbal", "replacement", "sample", "samples", "remove"];

export function vendorFromCode(code) {
  if (!code) return null;
  for (const { re, vendor } of VENDOR_BY_CODE) {
    if (re.test(code)) return vendor;
  }
  return null;
}

export function defaultRouteForVendor(vendor) {
  return vendor === "Inah" ? "direct" : "hk"; // decision #17: China vendors via Grandways HK, Inah direct
}

export function parseMemo(memo) {
  const result = { entries: [], notes: [], unresolved: [] };
  if (!memo || !String(memo).trim()) return result;
  const text = String(memo).trim();

  // collect noise-word notes (kept as flags, stripped from matching)
  for (const w of NOISE_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text)) result.notes.push(w.toLowerCase());
  }

  // strip a leading "Sales Order NNNNNN:" prefix (QB PO-export memo form)
  const cleaned = text.replace(/^sales\s+order\s+\d{4,6}\s*:/i, " ");

  // primary pattern: number (4-6 digits, optional -N revision) + optional letter run
  const tokenRe = /(\d{4,6}(?:-\d+)?)\s*([A-Za-z]+)?/g;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(cleaned)) !== null) tokens.push({ num: m[1], codeRaw: m[2] || "" });

  // free-text vendor fallback applies ONLY when no token carries a resolvable code
  // (pure free-text memos like "amtai po 12689"). In coded memos, a trailing
  // codeless number is UNRESOLVED -- never guess (spec rule 5).
  const anyCoded = tokens.some((t) => {
    let c = t.codeRaw;
    if (c && (NOISE_WORDS.includes(c.toLowerCase()) || c.toLowerCase() === "po")) c = "";
    return !!vendorFromCode(c);
  });
  let freeTextVendor = null;
  if (!anyCoded) {
    for (const { re, vendor } of FREE_TEXT_VENDORS) {
      if (re.test(cleaned)) { freeTextVendor = vendor; break; }
    }
  }

  for (const tok of tokens) {
    const num = tok.num;
    let codeRaw = tok.codeRaw;

    // plain number sanity: vendor POs are 5-digit-ish (1xxxx). 6-digit numbers
    // are likely garbled Signet PO references -- refuse and flag.
    const bare = num.split("-")[0];
    if (bare.length >= 6) {
      result.unresolved.push(num + (codeRaw ? codeRaw : ""));
      continue;
    }

    // strip noise words that regex may have captured as the "code"
    if (codeRaw && NOISE_WORDS.includes(codeRaw.toLowerCase())) codeRaw = "";
    // "po" prefix noise ("amtai po 12689")
    if (codeRaw && codeRaw.toLowerCase() === "po") codeRaw = "";

    let vendor = vendorFromCode(codeRaw);
    let vendorCode = codeRaw || null;

    if (!vendor && freeTextVendor) {
      vendor = freeTextVendor;
      vendorCode = null;
    }

    if (!vendor) {
      result.unresolved.push(num + (codeRaw ? codeRaw : ""));
      continue;
    }
    result.entries.push({ vendorPo: num, vendor, vendorCode });
  }

  // dedupe identical vendorPo entries (memo typos can repeat)
  const seen = new Set();
  result.entries = result.entries.filter((e) => {
    if (seen.has(e.vendorPo)) return false;
    seen.add(e.vendorPo);
    return true;
  });

  return result;
}

export default parseMemo;
