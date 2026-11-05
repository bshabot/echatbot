// Tests for "send quotes to QB from the Quotes list" (src/utils/quoteQbBatch.js).
// No QuickBooks and no network: the QB calls are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { quoteLinesFromViewRow, prepareQuoteOrders, sendQuoteOrders } from "../src/utils/quoteQbBatch.js";

// Same rules as buildQuoteSoLines in qbQuoteSalesOrder.js (copied: that file imports the browser app).
const buildLines = (selected) => {
  const lines = [];
  const problems = [];
  for (const li of selected) {
    const style = String(li.styleNumber || "").trim();
    const rate = Number(li.salesPrice) || 0;
    if (!style) { problems.push("A selected line has no style number"); continue; }
    if (!(rate > 0)) { problems.push(`${style}: no sales price`); continue; }
    lines.push({ item: style, quantity: 1, rate, other1: style }); // quote quantities are not sent: every line is 1
  }
  return { lines, problems };
};

const row = (quoteNumber, lines, extra = {}) => ({ quoteNumber, id: 1, tags: "NY Meeting", multiplier: 3, lineitems: lines, ...extra });
const li = (style, salesPrice, extra = {}) => ({ salesPrice, quantity: 1, product: { styleNumber: style, sample_id: style }, ...extra });
const prep = (rows) => prepareQuoteOrders(rows, { buildLines });

test("lines come from the saved sales price, quantity from the view's lowercase field", () => {
  const lines = quoteLinesFromViewRow(row("Q1", [li("E1", 12.5, { quantity: 2 })]));
  assert.equal(lines[0].styleNumber, "E1");
  assert.equal(lines[0].salesPrice, 12.5);
  assert.equal(lines[0].Quantity, 2);
});

test("the quote's retail price and multiplier are ignored: the order uses the sales price only", () => {
  const lines = quoteLinesFromViewRow(row("Q1", [li("E1", 5, { retailPrice: 99 })]));
  assert.equal(lines[0].salesPrice, 5);
  assert.equal(lines[0].retailPrice, undefined);
  assert.equal(quoteLinesFromViewRow(row("Q1", [li("E1", undefined)]))[0].salesPrice, 0);
});

test("every order line is quantity 1, whatever the quote quantity is", () => {
  const [o] = prep([row("Q1", [li("E1", 10, { quantity: 6 })])]);
  assert.equal(o.lines[0].quantity, 1);
  assert.equal(o.total, 10);
});

test("prepared order carries reference, lines, total and unique products", () => {
  const [o] = prep([row("Q1", [li("E1", 10), li("E2", 20), li("E1", 10)])]);
  assert.equal(o.reference, "NY Meeting");
  assert.equal(o.lines.length, 3);
  assert.equal(o.total, 40);
  assert.deepEqual(o.products.map((p) => p.styleNumber), ["E1", "E2"]);
  assert.deepEqual(o.problems, []);
});

test("a line with no style or no price becomes a problem", () => {
  const [o] = prep([row("Q1", [li("E1", 10), li("E2", 0), { salesPrice: 5, product: null }])]);
  assert.equal(o.problems.length, 2);
});

function fakes({ itemResult, orderResult } = {}) {
  const calls = { items: [], orders: [] };
  return {
    calls,
    createItems: async (products) => {
      calls.items.push(products.map((p) => p.styleNumber));
      return itemResult ? itemResult(products) : { enabled: true, created: [], existed: products.map((p) => ({ sample: p.styleNumber })), failed: [] };
    },
    createOrder: async (o) => {
      calls.orders.push(o.quoteNumber);
      return orderResult ? orderResult(o) : { ok: true, ref: "1001", total: 40, lineCount: 2 };
    },
  };
}

test("items are created BEFORE any order is sent, once per unique style across quotes", async () => {
  const f = fakes();
  const orders = prep([row("Q1", [li("E1", 10), li("E2", 20)]), row("Q2", [li("E2", 20), li("E3", 5)])]);
  const out = await sendQuoteOrders(orders, f);
  assert.deepEqual(f.calls.items, [["E1", "E2", "E3"]]);
  assert.deepEqual(f.calls.orders, ["Q1", "Q2"]);
  assert.deepEqual(out.results.map((r) => r.status), ["created", "created"]);
});

test("one sales order per quote, with that quote's reference", async () => {
  const seen = [];
  const f = fakes({ orderResult: (o) => (seen.push(o.reference), { ok: true, ref: "9", total: 1, lineCount: 1 }) });
  await sendQuoteOrders(prep([row("Q1", [li("E1", 10)], { tags: "A" }), row("Q2", [li("E2", 10)], { tags: "B" })]), f);
  assert.deepEqual(seen, ["A", "B"]);
});

test("a quote whose item could not be created is skipped; others still go", async () => {
  const f = fakes({
    itemResult: () => ({ enabled: true, created: [{ sample: "E1" }], existed: [], failed: [{ sample: "E2", error: "name too long" }] }),
  });
  const out = await sendQuoteOrders(prep([row("Q1", [li("E1", 10)]), row("Q2", [li("E2", 10)])]), f);
  assert.deepEqual(f.calls.orders, ["Q1"]);
  assert.equal(out.results.find((r) => r.quoteNumber === "Q2").status, "skipped");
  assert.match(out.results.find((r) => r.quoteNumber === "Q2").error, /E2.*name too long/);
});

test("an item saved with only a custom-field warning does not block its order", async () => {
  const f = fakes({
    itemResult: () => ({ enabled: true, created: [{ sample: "E1" }], existed: [], failed: [{ sample: "E1", error: "item saved, but custom field(s) not set: X (nope)" }] }),
  });
  const out = await sendQuoteOrders(prep([row("Q1", [li("E1", 10)])]), f);
  assert.equal(out.results[0].status, "created");
  assert.equal(out.items.warnings.length, 1);
  assert.equal(out.items.failed.length, 0);
});

test("quotes with problems or no lines are skipped and never reach QuickBooks", async () => {
  const f = fakes();
  const out = await sendQuoteOrders(prep([row("Q1", [li("E1", 0)]), row("Q2", [])]), f);
  assert.deepEqual(f.calls.items, []);
  assert.deepEqual(f.calls.orders, []);
  assert.deepEqual(out.results.map((r) => r.status), ["skipped", "skipped"]);
});

test("integration off: nothing is created or sent", async () => {
  const f = fakes({ itemResult: () => ({ enabled: false }) });
  const out = await sendQuoteOrders(prep([row("Q1", [li("E1", 10)])]), f);
  assert.equal(out.enabled, false);
  assert.deepEqual(f.calls.orders, []);
});

test("timeouts and failures are reported per quote", async () => {
  const f = fakes({
    orderResult: (o) => (o.quoteNumber === "Q1" ? { ok: false, error: "slow", maybeCreated: true } : { ok: false, error: "rejected" }),
  });
  const out = await sendQuoteOrders(prep([row("Q1", [li("E1", 10)]), row("Q2", [li("E2", 10)])]), f);
  assert.deepEqual(out.results.map((r) => r.status), ["maybe", "failed"]);
});
