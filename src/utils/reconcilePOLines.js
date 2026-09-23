// reconcilePOLines.js
//
// Shared PO reconciliation — the ONE place the metal-lock detection and the
// confidence score live. Used by POLinesView.jsx (the rebill modal), the
// "Export all lines" / "Rescore confidence" actions on the Purchase Orders
// page, and poTariffDetection.js (upload + the headless weekly importer).
//   - detectModeRate: metal-weighted median + physical sanity bounds
//   - sets (item_count > 1) only vote when a metal has no single-item line
//   - predicted via recomputeSignetBill at upcharge 0 (Signet doesn't upcharge)
//   - tariff is ALWAYS 0 (dropped 9/23/26 — Signet carries it in the SSP duty
//     rate since 8/21/26, so nothing is ever billed on top)
//   - brass / "fixed no metal lock" lines have no cost sheet to reconcile and
//     never score
import {
  recomputeSignetBill,
  backEngineerMetalRate,
  resolveMetal,
  isFixedNoMetalLock,
} from "./runningLinesMath.js";

const SILVER_BOUNDS = { min: 30, max: 150 };
const GOLD_BOUNDS = { min: 2500, max: 7000 };

// ---------------------------------------------------------------------------
// Match tolerance + confidence score (rewritten 9/23/26).
//
// "Match" = our SSP sheet, re-floated to the PO's detected metal lock,
// reproduces Signet's unit price within 1% (5c floor). Signet rounds every
// component to the cent before summing, so a 1–4c drift on a $4 stud is
// rounding, not a mismatch — the old flat 3c tolerance scored PO 156480
// (24 lines, max miss 5c = 0.9%) as 60 / Low.
//
// Score = 100
//   − 5 per metal line that misses tolerance (1 per known-issue line — its miss
//     is already explained)
//   − size penalty: 10 points per 1% the WORST unexplained miss sits beyond the
//     tolerance, capped at 50 (a 6% miss on one line costs 50 on its own)
// Only silver/gold lines with a cost sheet are scored. Brass (fixed no metal
// lock), zeroed and unmatched lines are neither penalised nor counted.
// ---------------------------------------------------------------------------
export const MATCH_TOLERANCE_PCT = 0.01;
export const MATCH_TOLERANCE_MIN = 0.05;

export function matchTolerance(price) {
  return Math.max(MATCH_TOLERANCE_MIN, MATCH_TOLERANCE_PCT * Math.abs(Number(price) || 0));
}

export function confidenceLabel(c) {
  if (c == null) return "—";
  return c >= 90 ? "High" : c >= 70 ? "Medium" : c >= 50 ? "Low" : "Very Low";
}

// entries: [{ price, predicted, knownIssue }] — metal lines only (caller filters).
export function scoreConfidence(entries) {
  let evaluated = 0;
  let matched = 0;
  let mismatched = 0;
  let flaggedMismatched = 0;
  let maxMissPct = 0;
  for (const e of entries || []) {
    const price = Number(e?.price);
    const predicted = Number(e?.predicted);
    if (!Number.isFinite(price) || !Number.isFinite(predicted) || price <= 0) continue;
    evaluated++;
    const miss = Math.abs(price - predicted);
    if (miss <= matchTolerance(price)) {
      matched++;
      continue;
    }
    if (e.knownIssue) {
      flaggedMismatched++;
      continue;
    }
    mismatched++;
    maxMissPct = Math.max(maxMissPct, (miss / price) * 100);
  }
  if (evaluated === 0) {
    return { confidence: null, label: "—", evaluated, matched, mismatched, flaggedMismatched, maxMissPct };
  }
  const countPenalty = mismatched * 5 + flaggedMismatched * 1;
  const sizePenalty = Math.min(50, Math.max(0, maxMissPct - MATCH_TOLERANCE_PCT * 100) * 10);
  const confidence = Math.max(0, 100 - countPenalty - sizePenalty);
  return {
    confidence,
    label: confidenceLabel(confidence),
    evaluated,
    matched,
    mismatched,
    flaggedMismatched,
    maxMissPct,
  };
}

// Signet sets the billing lock 3 BUSINESS days after the PO is written.
// Proven empirically on the 2-year backfill (2026-06-05): median |error| 0.21%
// and 90% of multi-vote consensus locks within ±2% at +3 biz days, vs 2.3% /
// 47% when compared to the PO date itself. Use this date — not po_date — when
// looking up the published reference lock.
export function signetLockDate(poDate) {
  if (!poDate) return null;
  const x = new Date(`${poDate}T00:00:00Z`);
  if (Number.isNaN(x.getTime())) return null;
  let n = 3;
  while (n > 0) {
    x.setUTCDate(x.getUTCDate() + 1);
    const d = x.getUTCDay();
    if (d !== 0 && d !== 6) n--;
  }
  return x.toISOString().slice(0, 10);
}

// Published lock at the Signet lock date (+3 biz), walking back up to 4 days
// for weekends/holidays/missing rows — and for very fresh POs whose lock date
// hasn't happened yet (best available wins).
export function publishedLockFor(lockByDate, poDate) {
  const target = signetLockDate(poDate);
  if (!target || !lockByDate) return null;
  let d = target;
  for (let j = 0; j <= 4; j++) {
    const row = lockByDate.get(d);
    if (row) return row;
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() - 1);
    d = x.toISOString().slice(0, 10);
  }
  return null;
}

// A ZEROED line: Signet killed the SKU on the PO — quantity and extension
// wiped, but the unit_price column often keeps a stale/frozen price. Zeroed
// lines are dead: they must not vote on locks, must not count in tariff
// scoring or confidence, and must not show up as billing anomalies.
// (Brian's rule, 2026-07-08 — PO 151724: two zeroed SKUs dragged confidence
// to 66 and flipped the detected tariff.)
export function isZeroedPoLine(line) {
  const q = Number(line?.quantity);
  const tp = Number(line?.total_price);
  return !(q > 0) && !(tp > 0);
}

// Metal-weighted median with physical sanity bounds.
export function detectModeRate(entries, bounds) {
  let norm = (entries || [])
    .map((e) => (typeof e === "number" ? { rate: e, weight: 1 } : e))
    .filter(
      (e) =>
        e &&
        Number.isFinite(e.rate) &&
        e.rate > 0 &&
        Number.isFinite(e.weight) &&
        e.weight > 0
    );
  if (norm.length === 0) return null;
  if (bounds) {
    const inB = norm.filter((e) => e.rate >= bounds.min && e.rate <= bounds.max);
    if (inB.length) norm = inB;
  }
  norm.sort((a, b) => a.rate - b.rate);
  const totalW = norm.reduce((s, e) => s + e.weight, 0);
  let cum = 0;
  for (const e of norm) {
    cum += e.weight;
    if (cum >= totalW / 2) return e.rate;
  }
  return norm[norm.length - 1].rate;
}

// Build a {sku:NUM, vsn:STYLE} -> sku lookup. On a duplicate key (same style on
// two SSP records) keep the most-recently-scraped one so matching is deterministic.
export function buildSkuMap(skuRows) {
  const tms = (s) => Date.parse(s?.last_scraped_at || s?.updated_at || "") || 0;
  const m = new Map();
  const setBest = (k, s) => {
    const cur = m.get(k);
    if (!cur || tms(s) >= tms(cur)) m.set(k, s);
  };
  for (const s of skuRows || []) {
    if (s.sku_number) setBest(`sku:${s.sku_number}`, s);
    if (s.vendor_style_number) setBest(`vsn:${s.vendor_style_number}`, s);
  }
  return m;
}

// Group material/finding/chain rows by ssp_number into one components array.
export function groupComponents(...lists) {
  const m = new Map();
  for (const rows of lists)
    for (const r of rows || []) {
      if (!m.has(r.ssp_number)) m.set(r.ssp_number, []);
      m.get(r.ssp_number).push(r);
    }
  return m;
}

function matchSku(line, skuMap) {
  return (
    (line.sku_number && skuMap.get(`sku:${line.sku_number}`)) ||
    (line.vendor_style_number && skuMap.get(`vsn:${line.vendor_style_number}`)) ||
    null
  );
}

export function enrichLines(lines, skuMap, compMap) {
  return (lines || []).map((line) => {
    const sku = matchSku(line, skuMap);
    const comps = sku ? compMap.get(sku.ssp_number) || [] : [];
    const metal = sku && comps.length > 0 ? resolveMetal(comps) : null;
    const impliedRate =
      sku && comps.length > 0
        ? backEngineerMetalRate(line, sku, comps, { tariffPct: 0, upchargePct: 0 })
        : null;
    return { line, sku, comps, metal, impliedRate };
  });
}

export function detectLocks(enriched, publishedLock) {
  // Singles vote first; sets only vote when a metal has no single-item line;
  // the published lock for the PO date is the last resort (mirrors POLinesView).
  const pools = { Silver: { single: [], set: [] }, Gold: { single: [], set: [] } };
  for (const e of enriched) {
    if (e.impliedRate == null || !e.metal) continue;
    if (isZeroedPoLine(e.line)) continue; // zeroed SKUs are dead — no lock vote
    if (isFixedNoMetalLock(e.sku)) continue; // brass/7117: no metal, no lock to vote on
    if (e.sku?.known_issue) continue; // flagged billing defects don't vote on the lock
    const mt = e.metal.metalType;
    if (!pools[mt]) continue;
    const w = (Number(e.sku?.total_net_weight) || 0.0001) * (Number(e.line?.quantity) || 1);
    const ent = { rate: e.impliedRate, weight: w };
    (Number(e.sku?.item_count) > 1 ? pools[mt].set : pools[mt].single).push(ent);
  }
  // Date-aware sanity bands (2026-06-05): scale off the published lock for the
  // PO date (0.6x–1.6x); static bands only when no published exists. Mirrors
  // POLinesView/POUploader exactly.
  const boundsFor = (pub, fallback) =>
    pub != null && Number(pub) > 0 ? { min: Number(pub) * 0.6, max: Number(pub) * 1.6 } : fallback;
  const pick = (mt, staticBounds, pubField) => {
    const pub = publishedLock && publishedLock[pubField] != null ? Number(publishedLock[pubField]) : null;
    const bounds = boundsFor(pub, staticBounds);
    // HARD window when a published lock exists (kills absolute garbage like a
    // $240 implied silver), then a corroboration rule: a LONE vote more than
    // 15% off published is untrusted (stale/mismatched record) -> fall to
    // published; 2+ agreeing votes are trusted at any distance (Signet's weekly
    // lock can lag a fast market by >15% — seen Mar-2025). Votes still come
    // ONLY from the PO's own lines.
    const hard = (arr) => (pub != null ? arr.filter((e) => e.rate >= bounds.min && e.rate <= bounds.max) : arr);
    const choose = (arr) => {
      const survivors = hard(arr);
      const m = detectModeRate(survivors, pub != null ? null : bounds);
      if (m == null) return null;
      if (pub != null && survivors.length === 1 && Math.abs(m / pub - 1) > 0.3) return null;
      return m;
    };
    return choose(pools[mt].single) ?? choose(pools[mt].set) ?? pub;
  };
  return {
    silverLock: pick("Silver", SILVER_BOUNDS, "silver_lock"),
    goldLock: pick("Gold", GOLD_BOUNDS, "gold_lock"),
  };
}


// Reconcile a PO's lines against the SSP sheet at the PO's detected locks.
// Returns { silverLock, goldLock, rows:[{ line, sku, comps, metal, impliedRate,
// predicted, signetVsOurs, reconcile, zeroed }], score } where score is the
// scoreConfidence() result for the PO's metal lines.
export function reconcilePO(po, lines, skuMap, compMap, publishedLock) {
  const enriched = enrichLines(lines, skuMap, compMap);
  const { silverLock, goldLock } = detectLocks(enriched, publishedLock);
  const rows = enriched.map((e) => {
    const zeroed = isZeroedPoLine(e.line);
    const ll = e.metal
      ? e.metal.metalType === "Gold"
        ? goldLock
        : e.metal.metalType === "Brass"
          ? null
          : silverLock
      : null;
    let predicted = null;
    // Brass / fixed-no-metal-lock lines are priced off Signet's frozen merchant
    // cost x whatever adder they chose — no cost sheet, nothing to reconcile.
    if (e.sku && e.comps.length > 0 && !isFixedNoMetalLock(e.sku)) {
      predicted = recomputeSignetBill(e.sku, e.comps, {
        silver: silverLock ?? ll ?? 0,
        gold: goldLock ?? ll ?? 0,
        tariffPct: 0,
        upchargePct: 0,
      });
    }
    const signetVsOurs =
      predicted != null && e.line.unit_price != null && !zeroed
        ? Number(e.line.unit_price) - predicted
        : null;
    const reconcile =
      signetVsOurs != null ? Math.abs(signetVsOurs) <= matchTolerance(e.line.unit_price) : null;
    return { ...e, predicted, signetVsOurs, reconcile, zeroed };
  });
  const score = scoreConfidence(
    rows
      .filter((r) => r.signetVsOurs != null && r.sku)
      .map((r) => ({ price: r.line.unit_price, predicted: r.predicted, knownIssue: !!r.sku.known_issue }))
  );
  return { silverLock, goldLock, rows, score };
}
