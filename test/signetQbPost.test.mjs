import test from "node:test";
import assert from "node:assert/strict";
import {
  qbNumberFor, buildCreditMemoPayload, buildRepaymentSoPayload, alreadyPostedMessage, duplicateState,
  idempotencyKeyFor, savedFieldsAfterCreate, txnIdOf, repaymentEligibility, TOO_LONG_MSG, NO_PO_NOTE,
} from "../src/utils/signetQbPost.js";

const CB = { vim_invoice: "9001", reference: "CB01520871", po_number: "156490", amount: 1072.26 };
const LP = { vim_invoice: "9002", reference: "LP156490SKU1234", po_number: "156490", amount: 50 };

test("CM# stays exactly as Signet writes it when it fits", () => {
  const n = qbNumberFor("CB01520871");
  assert.equal(n.number, "CB01520871");
  assert.equal(n.fits, true);
  assert.equal(n.message, "");
});

test("too-long number is blocked and gets a suggestion (last 11 chars)", () => {
  const n = qbNumberFor("LP156490SKU1234");
  assert.equal(n.fits, false);
  assert.equal(n.number, "");
  assert.equal(n.message, TOO_LONG_MSG);
  assert.equal(n.suggestion, "156490SKU1234".slice(-11));
  assert.equal(n.suggestion.length, 11);
});

test("trailing RP is trimmed when that fits in 11", () => {
  assert.equal(qbNumberFor("CB01520871RP").suggestion, "CB01520871");
  assert.equal(qbNumberFor("CB01520871RP").fits, false);
});

test("credit memo for CB01520871: exact payload", () => {
  const r = buildCreditMemoPayload(CB, "Price variance");
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, {
    customer: "Zales Corporation   -ZALES",
    ref_number: "CB01520871",
    po_number: "156490",
    memo: "Price variance | Signet ref CB01520871",
    lines: [{ item: "Chargebacks", amount: "1072.26", description: "Signet ref CB01520871" }],
  });
  assert.equal(r.payload.dry_run, undefined); // the caller decides dry-run, the builder never sends false
  assert.match(r.preview.text, /Credit memo CB01520871/);
  assert.match(r.preview.text, /Amount: \$1,072\.26/);
  assert.match(r.preview.text, /PO #: 156490/);
});

test("amount is always positive on the credit memo", () => {
  assert.equal(buildCreditMemoPayload({ ...CB, amount: -1072.26 }, "x").payload.lines[0].amount, "1072.26");
});

test("memo is required", () => {
  const r = buildCreditMemoPayload(CB, "   ");
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("Memo is required"));
});

test("zero amount is rejected", () => {
  assert.equal(buildCreditMemoPayload({ ...CB, amount: 0 }, "x").ok, false);
});

test("LP reference is blocked until a short number is typed; duplicate check uses what was typed", () => {
  const blocked = buildCreditMemoPayload(LP, "Late");
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.includes(TOO_LONG_MSG));
  assert.equal(blocked.tooLong, true);
  const typed = buildCreditMemoPayload(LP, "Late", { number: blocked.suggestion });
  assert.equal(typed.ok, true);
  assert.equal(typed.payload.ref_number, blocked.suggestion);
  assert.equal(typed.payload.memo, "Late | Signet ref LP156490SKU1234");
  assert.equal(idempotencyKeyFor("cm", typed.payload.ref_number), `cm:${blocked.suggestion}`);
  const stillLong = buildCreditMemoPayload(LP, "Late", { number: "WAYTOOLONGNUMBER" });
  assert.equal(stillLong.ok, false);
});

test("no PO: reference left empty and the preview says so", () => {
  const r = buildCreditMemoPayload({ ...CB, po_number: null }, "x");
  assert.equal(r.ok, true);
  assert.equal("po_number" in r.payload, false);
  assert.ok(r.preview.text.includes(NO_PO_NOTE));
});

test("one credit memo per chargeback: each builds its own payload", () => {
  const a = buildCreditMemoPayload(CB, "m"), b = buildCreditMemoPayload({ ...CB, reference: "CB01520999", amount: 5 }, "m");
  assert.notEqual(a.payload.ref_number, b.payload.ref_number);
  assert.equal(b.payload.lines.length, 1);
});

const RP = { vendor_invoice: "CB01520871RP", amount: 1072.26, status: "PAID", payment_date: "2026-11-10" };
test("repayment sales order: shape, number rule, memo", () => {
  const blocked = buildRepaymentSoPayload(CB, RP); // 12 chars: blocked until a number is entered
  assert.equal(blocked.ok, false);
  assert.equal(blocked.suggestion, "CB01520871"); // RP trimmed, fits
  const r = buildRepaymentSoPayload(CB, RP, { number: blocked.suggestion });
  assert.equal(r.ok, true);
  assert.equal(r.payload.ref_number, "CB01520871");
  assert.equal(r.payload.po_number, "156490");
  assert.equal(r.payload.memo, "Repayment of CB01520871 (CB01520871RP)");
  assert.deepEqual(r.payload.lines, [{ item: "Chargebacks", amount: "1072.26", description: "Signet ref CB01520871RP" }]);
  assert.match(r.preview.text, /Sales order/);
});

test("repayment blocked when RP is not paid", () => {
  assert.equal(buildRepaymentSoPayload(CB, { ...RP, status: "APPROVED" }).ok, false);
});

test("repayment SO number too long and no override", () => {
  const r = buildRepaymentSoPayload(LP, { ...RP, vendor_invoice: "LP156490SKU1234RP" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes(TOO_LONG_MSG));
});

test("local idempotency: already-posted rows are refused", () => {
  assert.equal(alreadyPostedMessage(CB, "cm"), "");
  assert.match(alreadyPostedMessage({ ...CB, qb_txn_id: "T1", qb_cm_ref: "CB01520871" }, "cm"), /Already added to QuickBooks as CB01520871/);
  assert.match(alreadyPostedMessage({ ...CB, qb_repayment_txn_id: "T2" }, "so"), /already added/);
  assert.equal(alreadyPostedMessage({ ...CB, qb_txn_id: "T1" }, "so"), "");
});

test("duplicate check results", () => {
  assert.equal(duplicateState({ checked: true, found: [] }).state, "clear");
  assert.equal(duplicateState({ checked: true, found: [{ txn_id: "A" }] }, "credit memo", "X").state, "duplicate");
  assert.equal(duplicateState({ checked: true, found: [], error: "down" }).state, "unchecked");
  assert.equal(duplicateState(null).state, "unchecked");
  assert.equal(duplicateState({ checked: false, found: [] }).state, "unchecked");
});

test("saved fields after create", () => {
  const cm = savedFieldsAfterCreate("cm", { number: "CB01520871", txnId: "T9", who: "a@b.c", at: "2026-11-24T00:00:00Z" });
  assert.deepEqual(cm, { qb_cm_ref: "CB01520871", qb_txn_id: "T9", qb_posted_by: "a@b.c", qb_posted_at: "2026-11-24T00:00:00Z", status: "done", done_reason: "added_to_qb" });
  assert.deepEqual(savedFieldsAfterCreate("so", { number: "S1", txnId: "T8" }), { qb_repayment_ref: "S1", qb_repayment_txn_id: "T8" });
  assert.equal(txnIdOf({ txn_id: "T9" }), "T9");
  assert.equal(txnIdOf(null), "");
});

test("repayment eligibility", () => {
  assert.equal(repaymentEligibility({ ...CB, qb_txn_id: "T1" }, RP).ok, true);
  assert.equal(repaymentEligibility(CB, RP).ok, false);
  assert.equal(repaymentEligibility({ ...CB, qb_txn_id: "T1" }, { ...RP, status: "APPROVED" }).ok, false);
  assert.equal(repaymentEligibility({ ...CB, qb_txn_id: "T1", qb_repayment_txn_id: "S" }, RP).ok, false);
  assert.equal(repaymentEligibility({ ...CB, qb_txn_id: "T1" }, null).ok, false);
});
