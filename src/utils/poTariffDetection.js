// poTariffDetection.js
//
// The POUploader auto-tariff core, extracted verbatim 2026-07-08 so headless
// importers (signet-po-scraper/scripts/import-to-plm.js) run the EXACT same
// pipeline as the UI — per the "mirror the UI's scoring math" rule.
//
// Pure orchestration: callers supply the data (sku rows, components, published
// locks); this module does per-candidate lock back-engineering, confidence
// scoring, best-pick, and the small-PO lock-distance tiebreaker, and writes
// the detected* fields onto each po object (same shape POUploader used).
//
// KEEP IN SYNC with POLinesView's display-side detection (see
// project lock-detection notes: detectModeRate + locksFrom mirrors live in
// reconcilePOLines.js).

import {
  recomputeSignetBill,
  backEngineerMetalRate,
  resolveMetal,
} from "./runningLinesMath.js";
import { publishedLockFor, detectModeRate } from "./reconcilePOLines.js";

const CANDIDATES = [0, 10, 20];
const PENNY_TOLERANCE = 0.03;
const SMALL_PO_LINES = 3; // tiebreaker only kicks in at ≤3 lines
const TIE_THRESHOLD = 5; // candidates within 5 pts of best are considered tied

/**
 * @param {Array} pos — parsed POs: { poNumber, poDate, lines:[{sku_number, quantity, unit_price, ...}], ... }
 *                      Mutated: detectedTariff, detectedConfidence, detectedScores,
 *                      detectedLock, detectedLockByTariff, tariffMatchedLines,
 *                      tariffPennyMatches, usedLockDistanceTiebreaker, lockDistanceByTariff.
 * @param {Object} ctx
 * @param {Map} ctx.sspBySku — sku_number(string) -> running_line_skus row (select *)
 * @param {Map} ctx.componentsBySsp — ssp_number -> component rows (materials+findings+chains,
 *              MUST include material_cost / finding_material_cost / chain_material_cost)
 * @param {Map} ctx.publishedLockByDate — date(yyyy-mm-dd) -> { date, silver_lock, gold_lock }
 */
export function detectTariffsForParsedPOs(pos, { sspBySku, componentsBySsp, publishedLockByDate }) {
  // Score one candidate tariff against one PO. Returns:
  //   { confidence, lock: { silver, gold }, matches, evaluated, errSum }
  function scoreCandidate(po, t) {
    // 1. Per-line: enrich with sku + components + metal type + impliedRate@t
    const enriched = po.lines.map((line) => {
      const sku = sspBySku.get(String(line.sku_number)) || null;
      const components = sku ? componentsBySsp.get(sku.ssp_number) || [] : [];
      const metal = sku && components.length > 0 ? resolveMetal(components) : null;
      const impliedRate =
        sku && components.length > 0
          ? backEngineerMetalRate(line, sku, components, {
              tariffPct: t,
              upchargePct: 0,
            })
          : null;
      return { line, sku, components, metal, impliedRate };
    });

    // 2. Back-engineer the silver + gold lock at this candidate tariff
    // Singles vote first; sets only vote when a metal has no single-item line;
    // published lock for the PO date is the last resort (mirrors POLinesView).
    const pools = { Silver: { single: [], set: [] }, Gold: { single: [], set: [] } };
    for (const e of enriched) {
      if (e.impliedRate == null || !e.metal) continue;
      if (e.sku?.known_issue) continue; // flagged billing defects don't vote on the lock
      const mt = e.metal.metalType;
      if (!pools[mt]) continue;
      const weight =
        (Number(e.sku?.total_net_weight) || 0.0001) * (Number(e.line?.quantity) || 1);
      const entry = { rate: e.impliedRate, weight };
      (Number(e.sku?.item_count) > 1 ? pools[mt].set : pools[mt].single).push(entry);
    }
    const published = publishedLockFor(publishedLockByDate, po.poDate);
    // Date-aware sanity bands (2026-06-05): scale off the published lock for
    // the PO date (0.6x–1.6x); static bands only when no published exists.
    // Keeps 2024-era POs (silver ~$29) from having honest votes filtered.
    const boundsFor = (pub, fallback) =>
      pub != null && Number(pub) > 0 ? { min: Number(pub) * 0.6, max: Number(pub) * 1.6 } : fallback;
    const pickLock = (mt, staticBounds, pubField) => {
      const pub = published && published[pubField] != null ? Number(published[pubField]) : null;
      const bounds = boundsFor(pub, staticBounds);
      // HARD window when published exists (kills $240-style garbage), then
      // corroboration: a LONE vote >15% off published is untrusted -> published;
      // 2+ agreeing votes trusted at any distance (weekly lock lags fast markets).
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
    const silverLock = pickLock("Silver", { min: 30, max: 150 }, "silver_lock");
    const goldLock = pickLock("Gold", { min: 2500, max: 7000 }, "gold_lock");

    // 3. Predict each line at the back-engineered lock, diff vs signet
    const diffs = [];
    let flaggedMismatchCount = 0;
    for (const e of enriched) {
      if (!e.sku || e.components.length === 0 || !e.line.unit_price) continue;
      if (e.sku.known_issue) {
        // Flagged billing defects don't vote on the tariff; they cost 1
        // confidence point each (constant across candidates, so they can
        // never flip the tariff pick).
        flaggedMismatchCount++;
        continue;
      }
      const lineLock =
        e.metal?.metalType === "Gold"
          ? goldLock
          : e.metal?.metalType === "Silver"
            ? silverLock
            : null;
      const predicted = recomputeSignetBill(e.sku, e.components, {
        silver: silverLock ?? lineLock ?? 0,
        gold: goldLock ?? lineLock ?? 0,
        tariffPct: t,
        upchargePct: 0, // Signet doesn't add upcharge — that's Brian's, not theirs
      });
      diffs.push(Math.abs(Number(e.line.unit_price) - predicted));
    }
    if (diffs.length === 0) {
      return {
        // Fully-flagged PO: confidence reflects only the light known-issue
        // penalty (e.g. 2 flagged lines -> 98), not null.
        confidence: flaggedMismatchCount > 0 ? Math.max(0, 100 - flaggedMismatchCount) : null,
        lock: { silver: silverLock, gold: goldLock },
        matches: 0,
        evaluated: 0,
        errSum: 0,
      };
    }

    // 4. Confidence (same formula as POLinesView)
    const mismatched = diffs.filter((d) => d > PENNY_TOLERANCE);
    const mismatchCount = mismatched.length;
    const maxMismatch = mismatched.length ? Math.max(...mismatched) : 0;
    const countPenalty = mismatchCount * 5 + flaggedMismatchCount * 1; // known issues: 1pt, not 5
    const sizePenalty = Math.min(50, maxMismatch * 5); // size penalty from UNKNOWN misses only
    const confidence = Math.max(0, 100 - countPenalty - sizePenalty);
    return {
      confidence,
      lock: { silver: silverLock, gold: goldLock },
      matches: diffs.filter((d) => d <= PENNY_TOLERANCE).length,
      evaluated: diffs.length,
      errSum: diffs.reduce((s, d) => s + d, 0),
    };
  }

  // Main loop: try each candidate, pick highest confidence
  for (const po of pos) {
    // Step A: score all 3 candidates
    const results = {}; // { 0: result, 10: result, 20: result }
    const scores = {};
    const lockByTariff = {};
    for (const t of CANDIDATES) {
      const result = scoreCandidate(po, t);
      results[t] = result;
      scores[t] = result.confidence != null ? Math.round(result.confidence) : null;
      lockByTariff[t] = result.lock;
    }

    // Step B: pick by highest confidence, tie-broken by lowest total error
    let bestT = null;
    let bestConfidence = -1;
    let bestErrSum = Infinity;
    for (const t of CANDIDATES) {
      const r = results[t];
      if (r.confidence == null) continue;
      const better =
        r.confidence > bestConfidence ||
        (r.confidence === bestConfidence && r.errSum < bestErrSum);
      if (better) {
        bestT = t;
        bestConfidence = r.confidence;
        bestErrSum = r.errSum;
      }
    }

    // Step C: SMALL-PO TIEBREAKER. For POs with ≤3 lines, back-engineering
    // is mathematically exact for any single-metal line at any tariff —
    // multiple candidates can score 100. Break the tie by picking the
    // candidate whose back-engineered lock is closest to the published lock
    // on the PO date. Only kicks in when (a) PO has ≤3 lines AND (b) at
    // least one OTHER candidate scored within TIE_THRESHOLD points of best.
    let usedLockDistanceTiebreaker = false;
    let lockDistanceByTariff = {};
    if (po.lines.length <= SMALL_PO_LINES && po.poDate && bestConfidence > 0) {
      const published = publishedLockFor(publishedLockByDate, po.poDate);
      if (published && (published.silver_lock || published.gold_lock)) {
        // Collect tied candidates (within TIE_THRESHOLD of best)
        const tied = CANDIDATES.filter((t) => {
          const r = results[t];
          if (r.confidence == null) return false;
          return bestConfidence - r.confidence <= TIE_THRESHOLD;
        });
        if (tied.length > 1) {
          // For each tied candidate, compute distance from back-engineered
          // lock to published lock (sum across metals that exist on both sides).
          for (const t of tied) {
            const r = results[t];
            let dist = 0;
            let metalsCompared = 0;
            if (r.lock?.silver != null && published.silver_lock != null) {
              dist += Math.abs(r.lock.silver - Number(published.silver_lock));
              metalsCompared++;
            }
            if (r.lock?.gold != null && published.gold_lock != null) {
              dist += Math.abs(r.lock.gold - Number(published.gold_lock));
              metalsCompared++;
            }
            lockDistanceByTariff[t] = metalsCompared > 0 ? dist : null;
          }
          // Pick the tied candidate with smallest non-null distance
          let tieWinner = null;
          let tieWinnerDist = Infinity;
          for (const t of tied) {
            const d = lockDistanceByTariff[t];
            if (d == null) continue;
            if (d < tieWinnerDist) {
              tieWinnerDist = d;
              tieWinner = t;
            }
          }
          if (tieWinner != null && tieWinner !== bestT) {
            bestT = tieWinner;
            bestConfidence = results[tieWinner].confidence;
            bestErrSum = results[tieWinner].errSum;
            usedLockDistanceTiebreaker = true;
          } else if (tieWinner != null) {
            // best already won the tie; just record that we evaluated it
            usedLockDistanceTiebreaker = true;
          }
        }
      }
    }

    const bestResult = bestT != null ? results[bestT] : null;
    po.detectedTariff = bestT;
    po.detectedConfidence = bestConfidence >= 0 ? bestConfidence : null;
    po.detectedScores = scores;
    po.detectedLock = bestResult?.lock || null;
    po.detectedLockByTariff = lockByTariff;
    po.tariffMatchedLines = bestResult?.evaluated || 0;
    po.tariffPennyMatches = bestResult?.matches || 0;
    po.usedLockDistanceTiebreaker = usedLockDistanceTiebreaker;
    po.lockDistanceByTariff = lockDistanceByTariff;
    // Cleared from old algorithm — no longer relevant
    po.usedHistoricalLock = false;
    po.tariffUsedBrassOnly = false;
    po.tariffBrassLineCount = 0;
  }
}
