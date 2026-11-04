// src/utils/quoteQbBatch.js
//
// "Send to QB" from the Quotes LIST: tick quotes, send each as a QuickBooks sales order
// without opening them. Same order the quote page's button creates (customer Zales,
// sales prices, memo = the quote's Reference), but for the WHOLE quote.
//
// Any style that isn't in QuickBooks yet is created as an item FIRST (QuickBooks rejects
// an order that names an unknown item). Items that already exist are never touched.
//
// This file has no imports on purpose: the QuickBooks calls are passed in (`deps`), so the
// logic is unit-tested without QuickBooks or the browser (test/quoteQbBatch.test.mjs).

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Lines of one quote, from a `quote_with_lineitems_and_product` row, in the shape the
 * sales-order builder reads. The order is priced at each line's saved sales price.
 */
export function quoteLinesFromViewRow(viewRow) {
  return (viewRow?.lineitems || []).map((li) => ({
    styleNumber: li.product?.styleNumber,
    salesPrice: num(li.salesPrice),
    Quantity: li.quantity ?? li.Quantity,
    product: li.product,
  }));
}

/**
 * One prepared order per quote. `buildLines` is buildQuoteSoLines from qbQuoteSalesOrder.
 * An order with `problems` (a line with no style number or no price) won't be sent.
 */
export function prepareQuoteOrders(viewRows, { buildLines, labelFor = (r) => r.quoteNumber }) {
  return (viewRows || []).map((row) => {
    const selectedLines = quoteLinesFromViewRow(row);
    const { lines, problems } = buildLines(selectedLines);
    const seen = new Set();
    const products = [];
    for (const li of selectedLines) {
      const style = String(li.styleNumber || "").trim();
      if (style && li.product && !seen.has(style)) {
        seen.add(style);
        products.push(li.product);
      }
    }
    return {
      quoteNumber: row.quoteNumber,
      label: labelFor(row),
      reference: row.tags || "",
      selectedLines,
      lines,
      problems: [...new Set(problems)],
      total: lines.reduce((sum, l) => sum + l.quantity * l.rate, 0),
      products,
    };
  });
}

// createItemsForSamples reports "item saved, but custom field(s) not set" under `failed`;
// the item DOES exist then, so it must not block the order.
const isWarning = (f) => String(f?.error || "").startsWith("item saved");

/**
 * Create missing items, then one sales order per ready quote.
 * deps: { createItems(products) -> {enabled, created[], existed[], failed[]},
 *         createOrder({quoteNumber, reference, selectedLines}) -> createSalesOrderForQuote result }
 *
 * Returns { enabled, items: {created, existed, failed, warnings}, results[] } where each
 * result is { quoteNumber, label, status: 'created'|'skipped'|'failed'|'maybe', ... }.
 */
export async function sendQuoteOrders(orders, { createItems, createOrder, onProgress = () => {} }) {
  const results = [];
  const ready = [];
  for (const o of orders) {
    if (o.problems.length) {
      results.push({ quoteNumber: o.quoteNumber, label: o.label, status: "skipped", error: o.problems.join("; ") });
    } else if (!o.lines.length) {
      results.push({ quoteNumber: o.quoteNumber, label: o.label, status: "skipped", error: "No lines on this quote" });
    } else {
      ready.push(o);
    }
  }

  // 1. make sure every style exists in QuickBooks
  const unique = new Map();
  for (const o of ready) for (const p of o.products) unique.set(String(p.styleNumber).trim(), p);
  let items = { created: [], existed: [], failed: [], warnings: [] };
  if (unique.size) {
    onProgress("items", unique.size);
    const res = await createItems([...unique.values()]);
    if (res?.enabled === false) return { enabled: false, items, results };
    items = {
      created: res.created || [],
      existed: res.existed || [],
      failed: (res.failed || []).filter((f) => !isWarning(f)),
      warnings: (res.failed || []).filter(isWarning),
    };
  }
  const badItems = new Map(items.failed.map((f) => [String(f.sample), f.error]));

  // 2. one sales order per quote whose items are all in QuickBooks
  let done = 0;
  for (const o of ready) {
    const blocked = o.lines.map((l) => l.item).find((style) => badItems.has(style));
    if (blocked) {
      results.push({
        quoteNumber: o.quoteNumber,
        label: o.label,
        status: "skipped",
        error: `Item ${blocked} could not be created in QuickBooks: ${badItems.get(blocked)}`,
      });
      continue;
    }
    onProgress("orders", ++done);
    const res = await createOrder({
      quoteNumber: o.quoteNumber,
      reference: o.reference,
      selectedLines: o.selectedLines,
    });
    const base = { quoteNumber: o.quoteNumber, label: o.label };
    if (res?.enabled === false) return { enabled: false, items, results };
    if (res?.ok) results.push({ ...base, status: "created", ref: res.ref, total: res.total, lineCount: res.lineCount });
    else if (res?.maybeCreated) results.push({ ...base, status: "maybe", error: res.error });
    else results.push({ ...base, status: "failed", error: res?.error || "unknown error" });
  }
  return { enabled: true, items, results };
}
