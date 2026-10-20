// Tests for the quote page's save logic (src/utils/quoteSave.js).
// Run:  npm test      (also runs automatically on every push via .github/workflows/test.yml)
//
// No network and no database: a small fake Supabase client records every call, so these
// tests check WHICH operation the page performs (update vs insert) and with WHAT data.
import test from "node:test";
import assert from "node:assert/strict";
import { getActiveQuote, buildQuoteHeader, visibleDrafts, saveQuoteChanges } from "../src/utils/quoteSave.js";

// --- fake supabase client ---------------------------------------------------------------
function fakeSupabase({ current = null, fail = {} } = {}) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const call = { table, op: "select", payload: undefined, filters: [] };
      calls.push(call);
      const builder = {
        select: () => builder,
        insert: (p) => ((call.op = "insert"), (call.payload = p), builder),
        update: (p) => ((call.op = "update"), (call.payload = p), builder),
        upsert: (p, opts) => ((call.op = "upsert"), (call.payload = p), (call.opts = opts), builder),
        delete: () => ((call.op = "delete"), builder),
        eq: (col, val) => (call.filters.push([col, val]), builder),
        in: (col, vals) => (call.filters.push([col, vals]), builder),
        single: () => builder,
        then: (resolve, reject) => {
          const key = `${table}.${call.op}`;
          const result = fail[key]
            ? { data: null, error: { message: `${key} failed` } }
            : { data: call.op === "select" ? current : [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}
const ops = (c) => c.calls.map((x) => `${x.table}.${x.op}`);

const LOADED_FORM = {
  id: 110,
  quoteNumber: "f24f2722-a3c8-4d3f-ae1b-2fd2825a6a44",
  created_at: "2026-10-01T12:00:00",
  updated_at: "2026-10-19T17:11:59",
  lineitems: [{ id: 1 }],
  buyer: 3,
  status: "Created:grey",
  silver: 85,
  gold: 4100,
  bulkMargin: 32,
  multiplier: 3,
  quoteTotal: 35.32,
  tags: "",
};

// --- create vs update (the original bug) ---------------------------------------------------
test("a quote loaded in the form is still the active quote when ?quote= is missing", () => {
  assert.equal(getActiveQuote(null, LOADED_FORM), LOADED_FORM.quoteNumber);
});

test("?quote= wins when present", () => {
  assert.equal(getActiveQuote("abc", LOADED_FORM), "abc");
});

test("a blank form has no active quote (so Save creates a new one)", () => {
  assert.equal(getActiveQuote(null, { buyer: null, status: "Created:grey" }), null);
});

test("creating a quote never sends id, quoteNumber or created_at (quotes_pkey duplicate)", () => {
  const header = buildQuoteHeader(LOADED_FORM, [{ totalCost: 10 }], "2026-10-20T00:00:00.000Z");
  for (const bad of ["id", "quoteNumber", "created_at", "lineitems", "lineItems"]) {
    assert.equal(bad in header, false, `${bad} must not be sent`);
  }
  assert.equal(header.buyer, 3);
  assert.equal(header.silver, 85);
  assert.equal(header.updated_at, "2026-10-20T00:00:00.000Z");
});

test("quoteTotal is the sum of line costs, tolerating blanks", () => {
  const header = buildQuoteHeader({}, [{ totalCost: 10.5 }, { totalCost: "4.5" }, { totalCost: null }, {}]);
  assert.equal(header.quoteTotal, 15);
});

// --- saving changes to an existing quote ------------------------------------------------------
test("saving an existing quote only updates; it never inserts into quotes", async () => {
  const sb = fakeSupabase({ current: { ...LOADED_FORM } });
  const submitForm = buildQuoteHeader({ ...LOADED_FORM, silver: 90 }, [{ id: 1, totalCost: 35.32 }]);
  const results = await saveQuoteChanges({
    supabase: sb,
    quoteNumber: LOADED_FORM.quoteNumber,
    submitForm,
    lineItems: [{ id: 1, totalCost: 35.32 }],
  });
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(sb.calls.some((c) => c.table === "quotes" && c.op === "insert"), false);
  const upd = sb.calls.find((c) => c.table === "quotes" && c.op === "update");
  assert.ok(upd, "the quote header should be updated");
  assert.equal(upd.payload.silver, 90);
  assert.deepEqual(upd.filters, [["quoteNumber", LOADED_FORM.quoteNumber]]);
});

test("only changed header fields are sent", async () => {
  const sb = fakeSupabase({ current: { ...LOADED_FORM, quoteTotal: 35.32 } });
  const submitForm = { buyer: 3, silver: 99, quoteTotal: 35.32 };
  await saveQuoteChanges({ supabase: sb, quoteNumber: LOADED_FORM.quoteNumber, submitForm });
  const upd = sb.calls.find((c) => c.op === "update");
  assert.deepEqual(upd.payload, { silver: 99 });
});

test("no header update when nothing changed", async () => {
  const sb = fakeSupabase({ current: { ...LOADED_FORM } });
  const results = await saveQuoteChanges({
    supabase: sb,
    quoteNumber: LOADED_FORM.quoteNumber,
    submitForm: { buyer: 3, silver: 85 },
  });
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(ops(sb).includes("quotes.update"), false);
});

test("existing lines are upserted by id, new lines inserted, removed lines deleted, all on this quote", async () => {
  const sb = fakeSupabase({ current: { ...LOADED_FORM } });
  const results = await saveQuoteChanges({
    supabase: sb,
    quoteNumber: "Q1",
    submitForm: { buyer: 3 },
    lineItems: [{ id: 7, salesPrice: 5 }, { productId: 99, salesPrice: 6 }],
    lineItemsToDelete: [3, 4],
  });
  assert.deepEqual(results, [true, true, true, true]);
  const upsert = sb.calls.find((c) => c.op === "upsert");
  assert.deepEqual(upsert.payload, [{ id: 7, salesPrice: 5, quoteNumber: "Q1" }]);
  assert.equal(upsert.opts.onConflict, "id");
  const insert = sb.calls.find((c) => c.table === "lineItems" && c.op === "insert");
  assert.deepEqual(insert.payload, [{ productId: 99, salesPrice: 6, quoteNumber: "Q1" }]);
  const del = sb.calls.find((c) => c.op === "delete");
  assert.deepEqual(del.filters, [["id", [3, 4]]]);
});

test("prepareLine is applied to every saved line", async () => {
  const sb = fakeSupabase({ current: { ...LOADED_FORM } });
  await saveQuoteChanges({
    supabase: sb,
    quoteNumber: "Q1",
    submitForm: { buyer: 3 },
    lineItems: [{ id: 7, junk: "x", salesPrice: 5 }],
    prepareLine: ({ junk, ...rest }) => rest,
  });
  assert.deepEqual(sb.calls.find((c) => c.op === "upsert").payload, [{ id: 7, salesPrice: 5, quoteNumber: "Q1" }]);
});

// --- failures must be reported, never swallowed -------------------------------------------------
for (const [failing, index] of [
  ["quotes.update", 0],
  ["lineItems.upsert", 1],
  ["lineItems.insert", 2],
  ["lineItems.delete", 3],
]) {
  test(`a failed ${failing} is reported as false (so the page keeps a draft)`, async () => {
    const sb = fakeSupabase({ current: { ...LOADED_FORM }, fail: { [failing]: true } });
    const results = await saveQuoteChanges({
      supabase: sb,
      quoteNumber: "Q1",
      submitForm: { silver: 1 },
      lineItems: [{ id: 7 }, { productId: 1 }],
      lineItemsToDelete: [3],
    });
    assert.equal(results[index], false);
    assert.equal(results.filter((r) => r === false).length, 1, "only the failing step is false");
  });
}

test("failing to read the current quote is reported as false", async () => {
  const sb = fakeSupabase({ current: null });
  const results = await saveQuoteChanges({ supabase: sb, quoteNumber: "Q1", submitForm: { silver: 1 } });
  assert.equal(results[0], false);
});

// --- drafts --------------------------------------------------------------------------------------
test("drafts only show on the page they belong to", () => {
  const drafts = [
    { id: "a", quoteNumber: "Q1" },
    { id: "b", quoteNumber: "Q2" },
    { id: "c", quoteNumber: null },
    { id: "d" },
  ];
  assert.deepEqual(visibleDrafts(drafts, "Q1").map((d) => d.id), ["a"]);
  assert.deepEqual(visibleDrafts(drafts, null).map((d) => d.id), ["c", "d"]);
  assert.deepEqual(visibleDrafts(undefined, "Q1"), []);
});
