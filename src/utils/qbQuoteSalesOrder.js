// src/utils/qbQuoteSalesOrder.js
//
// Create a QuickBooks Sales Order from the lines a customer picked off a quote.
// We send out a broad quote and the customer chooses what they want, so the SO
// carries only the selected lines, each at the quote's RETAIL price (the price
// shown on the quote) -- not our cost or sales price.
//
//   customer    always Zales (QB_SALES_ORDER_CUSTOMER)
//   ref number  omitted, so QuickBooks assigns the next available SO number
//   memo        the quote's Reference (quotes.tags)
//   lines       item = style number, quantity, rate = retail price
//
// GATED through qbClient like every other QB write: no-op unless the
// integration is on in Settings.

import {
  createSalesOrder,
  isQbEnabled,
  isUnknownOutcome,
  QB_SALES_ORDER_CUSTOMER,
} from "./qbClient";

// Which line field is the price on the SO. Retail = what the quote shows.
export const QUOTE_SO_PRICE_FIELD = "retailPrice";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function todayEasternISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Small stable hash so the same selection can't be posted twice by a
// double-click or retry (the connector dedupes on the idempotency key).
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Turn selected quote lines into SO lines. Returns { lines, problems } where
 * problems lists anything that blocks the order (no style number / no price).
 */
export function buildQuoteSoLines(selectedLines) {
  const lines = [];
  const problems = [];
  (selectedLines || []).forEach((li) => {
    const style = String(li.styleNumber || li.product?.styleNumber || "").trim();
    const rate = num(li[QUOTE_SO_PRICE_FIELD]);
    const qty = num(li.Quantity) > 0 ? num(li.Quantity) : 1;
    if (!style) {
      problems.push("A selected line has no style number");
      return;
    }
    if (!(rate > 0)) {
      problems.push(`${style}: no retail price`);
      return;
    }
    lines.push({ item: style, quantity: qty, rate: Number(rate.toFixed(2)), other1: style });
  });
  return { lines, problems };
}

export function quoteSoTotal(lines) {
  return lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);
}

/**
 * Create the SO. Returns
 *   { enabled:false }                                  integration off
 *   { ok:true, ref, total, lineCount }                 created
 *   { ok:false, error, maybeCreated }                  failed (maybeCreated =
 *                                                      timed out, check QB)
 */
export async function createSalesOrderForQuote({ quoteNumber, reference, selectedLines, settings }) {
  if (!isQbEnabled(settings)) return { enabled: false };
  const { lines, problems } = buildQuoteSoLines(selectedLines);
  if (problems.length) return { ok: false, error: problems.join("; ") };
  if (!lines.length) return { ok: false, error: "No lines selected" };

  const payload = {
    customer: QB_SALES_ORDER_CUSTOMER,
    txn_date: todayEasternISO(),
    lines,
  };
  const memo = String(reference || "").trim();
  if (memo) payload.memo = memo;

  const key = `quote-so:${quoteNumber}:${hashString(
    lines.map((l) => `${l.item}|${l.quantity}|${l.rate}`).sort().join(",")
  )}`;
  try {
    const item = await createSalesOrder(payload, { idempotencyKey: key });
    const ref = item?.ref_number ?? item?.RefNumber ?? item?.refNumber ?? item?.Num ?? null;
    return { ok: true, ref, total: quoteSoTotal(lines), lineCount: lines.length };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      maybeCreated: isUnknownOutcome(e),
    };
  }
}
