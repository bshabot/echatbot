// poTariffDetection.js
//
// Kept under its old name because signet-po-scraper/scripts/import-to-plm.js
// (the headless weekly importer) imports `detectTariffsForParsedPOs` from this
// path, live from the PLM clone. The TARIFF part is gone (9/23/26): Signet has
// carried the tariff inside the SSP duty rate since 8/21/26, so nothing is
// billed on top and detectedTariff is always 0. What remains is the metal-lock
// detection + confidence score, which now come from reconcilePOLines.js — the
// same functions the PO modal and the PO list use, so upload / import /
// modal / list can never disagree again.
//
// Mutates each po with the same field names the callers already read:
//   detectedTariff (0), detectedConfidence, detectedScores ({ 0: score }),
//   detectedLock, detectedLockByTariff, tariffMatchedLines,
//   tariffPennyMatches, usedLockDistanceTiebreaker (false), lockDistanceByTariff.

import { reconcilePO, buildSkuMap, publishedLockFor } from "./reconcilePOLines.js";

/**
 * @param {Array} pos — parsed POs: { poNumber, poDate, lines:[{sku_number, quantity, unit_price, ...}], ... }
 * @param {Object} ctx
 * @param {Map} ctx.sspBySku — sku_number(string) -> running_line_skus row (select *)
 * @param {Map} ctx.componentsBySsp — ssp_number -> component rows (materials+findings+chains,
 *              MUST include material_cost / finding_material_cost / chain_material_cost)
 * @param {Map} ctx.publishedLockByDate — date(yyyy-mm-dd) -> { date, silver_lock, gold_lock }
 */
export function detectTariffsForParsedPOs(pos, { sspBySku, componentsBySsp, publishedLockByDate }) {
  const skuMap = buildSkuMap([...(sspBySku?.values?.() || [])]);
  for (const po of pos) {
    const published = publishedLockFor(publishedLockByDate, po.poDate);
    const { silverLock, goldLock, score } = reconcilePO(
      { po_date: po.poDate },
      po.lines || [],
      skuMap,
      componentsBySsp || new Map(),
      published
    );
    const lock = { silver: silverLock ?? null, gold: goldLock ?? null };
    const conf = score?.confidence ?? null;
    po.detectedTariff = 0;
    po.detectedConfidence = conf;
    po.detectedScores = { 0: conf != null ? Math.round(conf) : null };
    po.detectedLock = lock;
    po.detectedLockByTariff = { 0: lock };
    po.tariffMatchedLines = score?.evaluated || 0;
    po.tariffPennyMatches = score?.matched || 0;
    po.usedLockDistanceTiebreaker = false;
    po.lockDistanceByTariff = {};
    po.usedHistoricalLock = false;
    po.tariffUsedBrassOnly = false;
    po.tariffBrassLineCount = 0;
  }
}
