// reconcilePOLines.js
//
// Shared PO reconciliation used by the "Export all lines" button on the
// Purchase Orders page. The per-line math here MUST stay in sync with
// POLinesView.jsx (the rebill modal) and POUploader.jsx (auto-tariff):
//   - detectModeRate: metal-weighted median + physical sanity bounds
//   - sets (item_count > 1) never vote on the lock
//   - predicted via recomputeSignetBill at upcharge 0 (Signet doesn't upcharge)
// If you change the lock/predict logic in those components, mirror it here.
import {
  recomputeSignetBill,
  backEngineerMetalRate,
  resolveMetal,
} from "./runningLinesMath";

const SILVER_BOUNDS = { min: 30, max: 150 };
const GOLD_BOUNDS = { min: 2500, max: 7000 };
const CANDIDATE_TARIFFS = [0, 10, 20];
const PENNY_TOLERANCE = 0.03;

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

function enrich(lines, skuMap, compMap, tariff) {
  return (lines || []).map((line) => {
    const sku = matchSku(line, skuMap);
    const comps = sku ? compMap.get(sku.ssp_number) || [] : [];
    const metal = sku && comps.length > 0 ? resolveMetal(comps) : null;
    const impliedRate =
      sku && comps.length > 0
        ? backEngineerMetalRate(line, sku, comps, { tariffPct: tariff, upchargePct: 0 })
        : null;
    return { line, sku, comps, metal, impliedRate };
  });
}

function locksFrom(enriched, publishedLock) {
  // Singles vote first; sets only vote when a metal has no single-item line;
  // the published lock for the PO date is the last resort (mirrors POLinesView).
  const pools = { Silver: { single: [], set: [] }, Gold: { single: [], set: [] } };
  for (const e of enriched) {
    if (e.impliedRate == null || !e.metal) continue;
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

// Implied tariff: the candidate (0/10/20) that best reconciles, by the same
// confidence + lowest-total-error scoring POUploader uses.
export function detectTariff(po, lines, skuMap, compMap, publishedLock) {
  let best = null;
  for (const t of CANDIDATE_TARIFFS) {
    const enriched = enrich(lines, skuMap, compMap, t);
    const { silverLock, goldLock } = locksFrom(enriched, publishedLock);
    const diffs = [];
    for (const e of enriched) {
      if (!e.sku || e.comps.length === 0 || e.line.unit_price == null) continue;
      if (e.sku.known_issue) continue; // flagged lines always mismatch — don't let them drag tariff scoring
      const ll =
        e.metal?.metalType === "Gold"
          ? goldLock
          : e.metal?.metalType === "Silver"
            ? silverLock
            : null;
      const pred = recomputeSignetBill(e.sku, e.comps, {
        silver: silverLock ?? ll ?? 0,
        gold: goldLock ?? ll ?? 0,
        tariffPct: t,
        upchargePct: 0,
      });
      diffs.push(Math.abs(Number(e.line.unit_price) - pred));
    }
    if (diffs.length === 0) continue;
    const mm = diffs.filter((d) => d > PENNY_TOLERANCE);
    const conf = Math.max(0, 100 - mm.length * 5 - Math.min(50, (mm.length ? Math.max(...mm) : 0) * 5));
    const errSum = diffs.reduce((s, d) => s + d, 0);
    if (!best || conf > best.conf || (conf === best.conf && errSum < best.errSum)) {
      best = { t, conf, errSum };
    }
  }
  return best ? best.t : Number(po.tariff_percent ?? 0);
}

// Reconcile a PO's lines at a given tariff (defaults to the PO's stored tariff).
// Returns { tariff, silverLock, goldLock, rows:[{ line, sku, metal, impliedRate,
// predicted, signetVsOurs, reconcile }] }.
export function reconcilePO(po, lines, skuMap, compMap, tariff, publishedLock) {
  const t = tariff != null ? tariff : Number(po.tariff_percent ?? 0);
  const enriched = enrich(lines, skuMap, compMap, t);
  const { silverLock, goldLock } = locksFrom(enriched, publishedLock);
  const rows = enriched.map((e) => {
    const ll = e.metal
      ? e.metal.metalType === "Gold"
        ? goldLock
        : e.metal.metalType === "Brass"
          ? null
          : silverLock
      : null;
    let predicted = null;
    if (e.sku && e.comps.length > 0) {
      predicted = recomputeSignetBill(e.sku, e.comps, {
        silver: silverLock ?? ll ?? 0,
        gold: goldLock ?? ll ?? 0,
        tariffPct: t,
        upchargePct: 0,
      });
    }
    const signetVsOurs =
      predicted != null && e.line.unit_price != null
        ? Number(e.line.unit_price) - predicted
        : null;
    const reconcile = signetVsOurs != null ? Math.abs(signetVsOurs) <= 0.05 : null;
    return { ...e, predicted, signetVsOurs, reconcile };
  });
  return { tariff: t, silverLock, goldLock, rows };
}
