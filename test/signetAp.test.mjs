import test from "node:test";
import assert from "node:assert/strict";
import {
  TOL, classifyRef, derivePaymentRuns, buildRunView, appliedGap, deriveDeductions, planDeductionWrites, carryOverNote,
  groupByPo, diffSignetRows, parseSignetExport, normalizeSignetRow, expectedPayDate, buildUpcoming, expectedNextRuns,
  buildMissingFromSignet, DATA_START, inDataWindow, splitByDataStart, applyDataStart, qbWindowStart, buildInvoiceIssues, splitIssues, linkedRefsFrom, qbInvoicesFrom, lastUpdated, planRunWrites, toIso,
} from "../src/utils/signetAp.js";

// row factory (DB-shaped, as stored)
let seq = 1000;
const R = (o) => ({
  vendor: "7002165", type: "INVOICE", status: "PAID", vendor_invoice: "", posting_date: "2026-11-02", vim_invoice: String(++seq),
  po_number: null, amount: 0, net_due_date: "2026-11-10", sap_payment_no: null, payment_date: null, ...o,
});
const Q = (num, amount, date = "2026-11-01", po = "") => ({ num, type: "Invoice", date, name: "Zales", memo: "", po, amount });

test("TOL is 5 cents", () => assert.equal(TOL, 0.05));

test("classifyRef: every reference type", () => {
  assert.equal(classifyRef("CB01543210").kind, "price_variance");
  const lp = classifyRef("LP164710SKU20608766260922");
  assert.deepEqual([lp.kind, lp.po, lp.sku, lp.date, lp.isRepayment], ["late", "164710", "20608766", "2026-09-22", false]);
  const qc1 = classifyRef("QC141750/10SKU20609567");
  assert.deepEqual([qc1.kind, qc1.po, qc1.line, qc1.sku], ["qc", "141750", "10", "20609567"]);
  const qc2 = classifyRef("141750/10QCCB");
  assert.deepEqual([qc2.kind, qc2.po, qc2.line], ["qc", "141750", "10"]);
  assert.equal(classifyRef("ZALELATE0912").kind, "zales_late");
  assert.equal(classifyRef("PAC3RDQTR26D").kind, "allowance");
  assert.equal(classifyRef("FREIGHT-X").kind, "unknown");
  assert.equal(classifyRef("CB01520871FRT").kind, "unknown"); // freight fee suffix
  assert.equal(classifyRef("692350").kind, "invoice");
  assert.equal(classifyRef("611030315").kind, "dropship");
  assert.equal(classifyRef("511030315").kind, "invoice"); // not starting with 6
  assert.equal(classifyRef("6110303150").kind, "invoice"); // 10 digits
});

test("classifyRef: RP suffix detection", () => {
  const rp = classifyRef("LP164710SKU20608766260922RP");
  assert.equal(rp.isRepayment, true);
  assert.equal(rp.base, "LP164710SKU20608766260922");
  assert.equal(rp.kind, "late");
  assert.equal(classifyRef("CB01097104RP").isRepayment, true);
  assert.equal(classifyRef("141750/10QCCBRP").base, "141750/10QCCB");
  assert.equal(classifyRef("692350").isRepayment, false);
  assert.equal(classifyRef("LP164710SKU20608766260922").isRepayment, false);
});

test("toIso handles Dates (UTC or local midnight), strings, serials", () => {
  assert.equal(toIso(new Date("2026-11-16T00:00:00.000Z")), "2026-11-16");
  assert.equal(toIso(new Date(2026, 10, 16)), "2026-11-16");
  assert.equal(toIso("11/16/2026"), "2026-11-16");
  assert.equal(toIso(""), null);
});

test("normalizeSignetRow keeps all 18 columns as trimmed strings/numbers", () => {
  const raw = {
    Vendor: 7002165, Type: "credit", "Invoice Status": "paid", "Vendor Invoice#": " CB01543210 ", "Posting Date": new Date("2026-11-02T00:00:00Z"),
    "Vim Invoice#": 8123456, "Supplier Invoice Date": new Date("2026-11-01T00:00:00Z"), "SAP Invoice Number": 1900000001, "PO Number": 164707,
    "SAP Invoice Date": new Date("2026-11-02T00:00:00Z"), "Amount Due": 12.345, "Net Due Date": new Date("2026-12-02T00:00:00Z"), "Disc 1 (%)": 0,
    "Disc 1 Due Date": "", "Disc 2 (%)": 0, "Disc 2 Due Date": "", "SAP Payment#": 2000060344, "Payment Date": new Date("2026-11-16T00:00:00Z"),
  };
  const r = normalizeSignetRow(raw);
  assert.equal(Object.keys(r).length, 18);
  assert.deepEqual([r.vim_invoice, r.vendor_invoice, r.type, r.status, r.po_number, r.sap_payment_no, r.vendor], ["8123456", "CB01543210", "CREDIT", "PAID", "164707", "2000060344", "7002165"]);
  assert.equal(r.disc1_due_date, null);
  assert.equal(r.payment_date, "2026-11-16");
  assert.equal(normalizeSignetRow({ ...raw, "Vim Invoice#": "" }), null);
  const p = parseSignetExport([raw, { ...raw, "Amount Due": 5 }, { ...raw, "Vim Invoice#": "" }]);
  assert.equal(p.rows.length, 1); assert.equal(p.skipped, 1); assert.equal(p.rows[0].amount, 5);
});

test("payment run: 624,537.89 invoices - 4,849.43 credits = 619,688.46", () => {
  const rows = [
    R({ vendor_invoice: "700001", amount: 400000, sap_payment_no: "2000060344", payment_date: "2026-11-16" }),
    R({ vendor_invoice: "700002", amount: 200000, sap_payment_no: "2000060344", payment_date: "2026-11-16" }),
    R({ vendor_invoice: "700003", amount: 24537.89, sap_payment_no: "2000060344", payment_date: "2026-11-16" }),
    R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 4000, sap_payment_no: "2000060344", payment_date: "2026-11-16" }),
    R({ type: "CREDIT", vendor_invoice: "PAC3RDQTR26D", amount: 849.43, sap_payment_no: "2000060344", payment_date: "2026-11-16" }),
    R({ vendor_invoice: "700004", amount: 99, sap_payment_no: "2000059999", payment_date: "2026-11-09" }),
    R({ vendor_invoice: "700005", amount: 5, status: "APPROVED" }), // no payment# → not in a run
  ];
  const runs = derivePaymentRuns(rows);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].sap_payment_no, "2000060344"); // newest first
  assert.deepEqual([runs[0].invoice_total, runs[0].deduction_total, runs[0].net_paid, runs[0].line_count], [624537.89, 4849.43, 619688.46, 5]);
  assert.equal(runs[1].net_paid, 99);
});

test("payment 2000055910-style: 78,900.86 less 8,912.00 QC = 69,988.86; applied == net, gap shown", () => {
  const P = { sap_payment_no: "2000055910", payment_date: "2026-11-09" };
  const lines = [
    R({ vendor_invoice: "692001", amount: 50000, po_number: "1", ...P }),
    R({ vendor_invoice: "692002", amount: 28900.86, po_number: "2", ...P }),
    R({ type: "CREDIT", vendor_invoice: "QC141750/10SKU20609567", amount: 8912, po_number: "141750", ...P }),
  ];
  const run = derivePaymentRuns(lines)[0];
  assert.deepEqual([run.invoice_total, run.deduction_total, run.net_paid], [78900.86, 8912, 69988.86]);
  const qb = new Map([["692001", { amount: 50000 }], ["692002", { amount: 28900.86 }]]);
  const v = buildRunView(lines, { qbByNum: qb });
  assert.equal(v.clean.length, 2);
  assert.equal(v.deductions.length, 1);
  assert.equal(v.applied, 69988.86);
  assert.equal(v.gap, 0);
  assert.deepEqual(appliedGap(v.header.net_paid, v.applied), { gap: 0, ok: true });
  // a line with no QB invoice can't be applied → the gap is exactly that line
  const v2 = buildRunView(lines, { qbByNum: new Map([["692001", { amount: 50000 }]]) });
  assert.equal(v2.noMatch.length, 1);
  assert.equal(v2.gap, 28900.86);
  assert.equal(appliedGap(v2.header.net_paid, v2.applied).ok, false);
  // QB unreachable: Signet-only parts still build, gap unknown
  const v3 = buildRunView(lines, { qbByNum: null });
  assert.equal(v3.qbChecked, false); assert.equal(v3.gap, null); assert.equal(v3.unchecked.length, 2);
  assert.equal(v3.header.net_paid, 69988.86);
});

test("run view: short, over, dropship rolled up, repayments linked", () => {
  const P = { sap_payment_no: "2000060344", payment_date: "2026-11-16" };
  const credit = R({ type: "CREDIT", vendor_invoice: "LP164710SKU20608766260922", amount: 500, status: "PAID", ...P });
  const rp = R({ vendor_invoice: "LP164710SKU20608766260922RP", amount: 500, ...P });
  const lines = [
    R({ vendor_invoice: "692320", amount: 25298.5, ...P }), R({ vendor_invoice: "692371", amount: 97116.71, ...P }),
    R({ vendor_invoice: "692400", amount: 110, ...P }), R({ vendor_invoice: "611030315", amount: 8.5, ...P }),
    R({ vendor_invoice: "611030316", amount: 8.75, ...P }), credit, rp,
  ];
  const ded = deriveDeductions([credit, rp]);
  const v = buildRunView(lines, {
    qbByNum: new Map([["692320", { amount: 27727.24 }], ["692371", { amount: 97116.68 }], ["692400", { amount: 100 }]]),
    deductions: ded.map((d) => ({ ...d })),
  });
  assert.equal(v.short.length, 1); assert.equal(v.short[0].diff, -2428.74);
  assert.equal(v.clean.length, 1); assert.equal(v.over.length, 1);
  assert.deepEqual([v.dropship.lines.length, v.dropship.total, v.dropship.mismatch.length], [2, 17.25, 0]);
  assert.equal(v.repayments.length, 1);
  assert.equal(v.repayments[0].deduction.reference, "LP164710SKU20608766260922");
});

test("invoice 692320 paid short once; 692371 within tolerance is equal", () => {
  const signet = [
    R({ vendor_invoice: "692320", amount: 25298.5, status: "PAID", po_number: "1" }),
    R({ vendor_invoice: "692371", amount: 97116.71, status: "PAID", po_number: "2" }),
  ];
  const qb = qbInvoicesFrom([Q("692320", 27727.24), Q("692371", 97116.68)]);
  const issues = buildInvoiceIssues({ signet, qb, today: "2026-11-23" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "paid_short");
  assert.equal(issues[0].ref, "692320");
  assert.equal(issues[0].diff, -2428.74);
  assert.equal(issues[0].key, "issue:paid_short:692320");
});

test("RP linking: repayment coming with due date, then Done/repaid once RP is PAID", () => {
  const ref = "LP164710SKU20608766260922";
  const cr = R({ type: "CREDIT", vendor_invoice: ref, amount: 500, po_number: "164710", posting_date: "2026-10-05" });
  const rpApproved = R({ vendor_invoice: ref + "RP", amount: 500, status: "APPROVED", net_due_date: "2026-12-04", posting_date: "2026-11-20" });
  let d = deriveDeductions([cr, rpApproved]);
  assert.equal(d.length, 1);
  assert.equal(d[0].repayment_vim_invoice, rpApproved.vim_invoice);
  assert.equal(d[0].repayment_due_date, "2026-12-04");
  assert.equal(d[0].repaid, false);
  assert.equal(d[0].initial_status, "new");
  // stored row is New; first plan inserts it
  let plan = planDeductionWrites(d, []);
  assert.equal(plan.inserts.length, 1);
  const stored = { ...plan.inserts[0], note: "keep me" };
  // RP line gets PAID → automatic move to done/repaid, logged by system
  const rpPaid = { ...rpApproved, status: "PAID" };
  d = deriveDeductions([cr, rpPaid]);
  plan = planDeductionWrites(d, [stored]);
  assert.equal(plan.repaid.length, 1);
  assert.deepEqual([plan.repaid[0].status, plan.repaid[0].done_reason], ["done", "repaid"]);
  assert.equal(plan.logs[0].who, "system");
  assert.ok(!("note" in plan.repaid[0]));
});

test("history: old repaid → Done/history; old unrepaid → New; recent repaid → Done/repaid", () => {
  const mk = (ref, posted, withPaidRp) => {
    const rows = [R({ type: "CREDIT", vendor_invoice: ref, amount: 10, posting_date: posted, po_number: "1" })];
    if (withPaidRp) rows.push(R({ vendor_invoice: ref + "RP", amount: 10, status: "PAID" }));
    return deriveDeductions(rows)[0];
  };
  const a = mk("CB01000001", "2025-12-01", true);
  assert.deepEqual([a.initial_status, a.initial_done_reason], ["done", "history"]);
  const b = mk("CB01000002", "2025-12-01", false);
  assert.deepEqual([b.initial_status, b.initial_done_reason], ["new", null]);
  const c = mk("CB01000003", "2026-03-01", true);
  assert.deepEqual([c.initial_status, c.initial_done_reason], ["done", "repaid"]);
});

test("charged before: QC141750/10SKU20609567 vs 141750/10QCCB (same PO + line + amount)", () => {
  const first = R({ type: "CREDIT", vendor_invoice: "QC141750/10SKU20609567", amount: 250, posting_date: "2026-09-01" });
  const second = R({ type: "CREDIT", vendor_invoice: "141750/10QCCB", amount: 250, posting_date: "2026-10-10" });
  const other = R({ type: "CREDIT", vendor_invoice: "141750/11QCCB", amount: 250, posting_date: "2026-10-10" }); // other line
  const diffAmt = R({ type: "CREDIT", vendor_invoice: "141750/10QCCB", amount: 251, posting_date: "2026-10-11" });
  const d = deriveDeductions([second, first, other, diffAmt]);
  const by = (v) => d.find((x) => x.vim_invoice === v);
  assert.equal(by(first.vim_invoice).charged_before_of, null);
  assert.equal(by(second.vim_invoice).charged_before_of, first.vim_invoice);
  assert.equal(by(other.vim_invoice).charged_before_of, null);
  assert.equal(by(diffAmt.vim_invoice).charged_before_of, null);
  assert.equal(by(second.vim_invoice).po_number, "141750");
  assert.equal(by(second.vim_invoice).line, "10");
});

test("late charges (no line) never flag charged-before", () => {
  const a = R({ type: "CREDIT", vendor_invoice: "LP164707SKU20608766260922", amount: 500 });
  const b = R({ type: "CREDIT", vendor_invoice: "LP164707SKU20608767260922", amount: 500 });
  assert.ok(deriveDeductions([a, b]).every((x) => x.charged_before_of === null));
});

test("idempotency: same export twice → zero changes; change tracking records amount/status", () => {
  const rows = [
    R({ vim_invoice: "1", vendor_invoice: "692320", amount: 100, status: "APPROVED", net_due_date: "2026-12-01" }),
    R({ vim_invoice: "2", vendor_invoice: "692321", amount: 50, status: "APPROVED" }),
  ];
  const t0 = "2026-11-20T10:00:00Z", t1 = "2026-11-21T10:00:00Z", t2 = "2026-11-22T10:00:00Z";
  const first = diffSignetRows(rows, [], t0);
  assert.equal(first.inserts.length, 2); assert.equal(first.changes.length, 0);
  const stored = first.inserts;
  const again = diffSignetRows(rows, stored, t1);
  assert.equal(again.inserts.length, 0); assert.equal(again.updates.length, 0); assert.equal(again.changes.length, 0);
  assert.deepEqual(again.touched.sort(), ["1", "2"]);
  // Signet reprices #1 and pays #2
  const next = [{ ...rows[0], amount: 90 }, { ...rows[1], status: "PAID", sap_payment_no: "2000000001", payment_date: "2026-11-23" }];
  const d = diffSignetRows(next, stored, t2);
  assert.equal(d.updates.length, 2);
  assert.ok(d.updates.every((u) => u.last_changed_at === t2));
  const f = (v, field) => d.changes.find((c) => c.vim_invoice === v && c.field === field);
  assert.deepEqual([f("1", "amount").old_value, f("1", "amount").new_value], ["100", "90"]);
  assert.deepEqual([f("2", "status").old_value, f("2", "status").new_value], ["APPROVED", "PAID"]);
  assert.equal(f("2", "sap_payment_no").new_value, "2000000001");
  assert.equal(f("2", "payment_date").new_value, "2026-11-23");
  // DB gives numerics as strings and dates the same → still no change
  const dbShaped = stored.map((r) => ({ ...r, amount: String(r.amount) }));
  assert.equal(diffSignetRows(rows, dbShaped, t1).updates.length, 0);
});

test("idempotency: derived runs/deductions rewrite nothing; user fields preserved", () => {
  const cr = R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 40, po_number: "9", sap_payment_no: "2000060344", payment_date: "2026-11-16" });
  const inv = R({ vendor_invoice: "700001", amount: 100, sap_payment_no: "2000060344", payment_date: "2026-11-16", po_number: "9" });
  const rows = [cr, inv];
  const d = deriveDeductions(rows);
  const p1 = planDeductionWrites(d, []);
  assert.equal(p1.inserts.length, 1);
  const stored = { ...p1.inserts[0], status: "disputed", note: "calling Signet", follow_up_date: "2026-12-01", qb_txn_id: "TX1" };
  const p2 = planDeductionWrites(deriveDeductions(rows), [{ ...stored, amount: "40.00" }]);
  assert.deepEqual([p2.inserts.length, p2.updates.length, p2.repaid.length, p2.logs.length], [0, 0, 0, 0]);
  // Signet reprices the credit → only derived columns move; no status/note keys in the patch
  const p3 = planDeductionWrites(deriveDeductions([{ ...cr, amount: 45 }, inv]), [stored]);
  assert.equal(p3.updates.length, 1);
  assert.equal(p3.updates[0].amount, 45);
  for (const k of ["status", "note", "follow_up_date", "qb_txn_id", "done_reason"]) assert.ok(!(k in p3.updates[0]), k);
  // runs: same derivation → nothing to upsert; status never in the payload
  const runs = derivePaymentRuns(rows);
  const storedRun = { ...runs[0], status: "approved", qb_txn_id: "X", approved_by: "a@b.c" };
  assert.equal(planRunWrites(runs, [storedRun]).upserts.length, 0);
  const changed = planRunWrites(derivePaymentRuns([cr, { ...inv, amount: 101 }]), [storedRun]).upserts;
  assert.equal(changed.length, 1);
  assert.ok(!("status" in changed[0]) && !("qb_txn_id" in changed[0]) && !("approved_by" in changed[0]));
});

test("carry over saved chargeback notes by CB number", () => {
  const notes = { "chargeback:CB#1543210": { note: "Asked Brian" }, "chargeback:CB01520871": { note: "fee, ignore" }, "invoice:692350": { note: "x" } };
  assert.equal(carryOverNote(notes, "CB01543210"), "Asked Brian");
  assert.equal(carryOverNote(notes, "CB01520871"), "fee, ignore");
  assert.equal(carryOverNote(notes, "CB01520871FRT"), ""); // fee suffix rows are not matched
  assert.equal(carryOverNote(notes, "CB09999999"), "");
  const cr = R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 40 });
  assert.equal(planDeductionWrites(deriveDeductions([cr]), [], { notes }).inserts[0].note, "Asked Brian");
});

test("group by PO: 25 late charges on one PO → one group with the total", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(R({ type: "CREDIT", vendor_invoice: `LP164707SKU2060${String(8000 + i)}260922`, amount: 500, po_number: "164707" }));
  rows.push(R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 30, po_number: "100" }));
  const g = groupByPo(deriveDeductions(rows));
  assert.equal(g.length, 2);
  assert.equal(g[0].po, "164707"); assert.equal(g[0].count, 25); assert.equal(g[0].total, 12500);
  assert.deepEqual(g[0].types, ["late"]);
});

test("expectedPayDate: first Monday on/after due date", () => {
  assert.equal(expectedPayDate("2026-11-30"), "2026-11-30"); // Monday
  assert.equal(expectedPayDate("2026-11-29"), "2026-11-30"); // Sunday
  assert.equal(expectedPayDate("2026-12-01"), "2026-12-07"); // Tuesday
  assert.equal(expectedPayDate("2026-12-05"), "2026-12-07"); // Saturday
  assert.equal(expectedPayDate(null), null);
});

test("upcoming: grouping, past due (>7 days), RP, pending credits in Any run, dropship spread", () => {
  const today = "2026-11-23"; // Monday
  const rows = [
    R({ vendor_invoice: "800001", amount: 1000, status: "APPROVED", net_due_date: "2026-11-30" }),
    R({ vendor_invoice: "800002", amount: 500, status: "APPROVED", net_due_date: "2026-11-29" }), // Sunday → 11-30
    R({ vendor_invoice: "800003", amount: 250, status: "APPROVED", net_due_date: "2026-12-01" }), // → 12-07
    R({ vendor_invoice: "CB01000001RP", amount: 40, status: "APPROVED", net_due_date: "2026-12-02" }), // RP → 12-07
    R({ vendor_invoice: "800004", amount: 700, status: "APPROVED", net_due_date: "2026-11-15" }), // 8 days late
    R({ vendor_invoice: "800005", amount: 300, status: "APPROVED", net_due_date: "2026-11-16" }), // exactly 7 days → not past due
    R({ vendor_invoice: "611030315", amount: 8.5, status: "APPROVED", net_due_date: "2026-11-10" }),
    R({ type: "CREDIT", vendor_invoice: "LP164710SKU20608766260922", amount: 500, status: "APPROVED" }),
    R({ vendor_invoice: "800006", amount: 999, status: "PAID" }),
  ];
  const u = buildUpcoming(rows, { today });
  assert.deepEqual(u.weeks.map((w) => w.monday), ["2026-11-16", "2026-11-30", "2026-12-07"]);
  const w = (m) => u.weeks.find((x) => x.monday === m);
  assert.equal(w("2026-11-30").invoiceTotal, 1500);
  assert.equal(w("2026-12-07").invoiceTotal, 250);
  assert.equal(w("2026-12-07").repaymentTotal, 40);
  assert.equal(w("2026-12-07").net, 290);
  assert.deepEqual([u.pastDue.count, u.pastDue.total], [1, 700]);
  assert.equal(u.pastDue.lines[0].vendor_invoice, "800004");
  assert.equal(w("2026-11-16").invoices[0].vendor_invoice, "800005");
  assert.deepEqual([u.dropship.count, u.dropship.total], [1, 8.5]);
  assert.deepEqual([u.anyRun.count, u.anyRun.total], [1, 500]);
  const n = expectedNextRuns(u, today, 2);
  assert.deepEqual(n.mondays, ["2026-11-30", "2026-12-07"]);
  assert.equal(n.total, 1790);
});

test("missing from Signet ageing: 6 ok, 7 yellow, 14 red; linked/present ones excluded", () => {
  const today = "2026-11-23";
  const qb = qbInvoicesFrom([
    Q("900001", 100, "2026-11-17"), Q("900002", 200, "2026-11-16"), Q("900003", 300, "2026-11-09"),
    Q("900004", 400, "2026-11-01"), Q("900005", 500, "2026-11-01"),
  ]);
  const signet = [R({ vendor_invoice: "900004", amount: 400 })];
  const m = buildMissingFromSignet({ qb, signet, today, linked: new Map([["XYZ", "900005"]]) });
  assert.deepEqual(m.map((x) => [x.num, x.days, x.level]), [["900003", 14, "red"], ["900002", 7, "yellow"], ["900001", 6, "ok"]]);
});

test("invoice issues: classification, thresholds, tolerance", () => {
  const today = "2026-11-23";
  const signet = [
    R({ vendor_invoice: "A1", amount: 100.05, status: "APPROVED", po_number: "1", net_due_date: "2026-12-10" }), // within 5¢ → nothing
    R({ vendor_invoice: "A2", amount: 100.06, status: "APPROVED", po_number: "1", net_due_date: "2026-12-10" }), // 6¢ → amount_diff
    R({ vendor_invoice: "A3", amount: 80, status: "APPROVED", po_number: "1", net_due_date: "2026-12-10" }),
    R({ vendor_invoice: "A4", amount: 50, status: "PAID", po_number: "1" }), // paid short
    R({ vendor_invoice: "A5", amount: 120, status: "PAID", po_number: "1" }), // paid over → amount_diff
    R({ vendor_invoice: "A6", amount: 60, status: "APPROVED", net_due_date: "2026-11-15" }), // 8 days past due (QB ok)
    R({ vendor_invoice: "A7", amount: 60, status: "APPROVED", net_due_date: "2026-11-16" }), // 7 → not past due
    R({ vendor_invoice: "A8", amount: 77, status: "PAID" }), // not in QB
    R({ vendor_invoice: "A9", amount: 60, status: "PAID", posting_date: "2026-01-01" }), // before the QB window → ignored
    R({ vendor_invoice: "611030315", amount: 8, status: "PAID" }), // dropship never "not in QB"
    R({ vendor_invoice: "CB01000001RP", amount: 8, status: "PAID" }), // RP never "not in QB"
    R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 8, status: "PAID" }), // credits go to chargebacks
  ];
  const qb = qbInvoicesFrom([
    Q("A1", 100, "2026-11-01"), Q("A2", 100), Q("A3", 100), Q("A4", 100), Q("A5", 100), Q("A6", 60), Q("A7", 60),
    Q("M7", 10, "2026-11-16"), Q("M6", 10, "2026-11-17"), Q("M14", 10, "2026-11-09"),
  ]);
  const issues = buildInvoiceIssues({ signet, qb, today, qbFrom: "2026-10-01" });
  const t = (type) => issues.filter((i) => i.type === type).map((i) => i.ref).sort();
  assert.deepEqual(t("amount_diff"), ["A2", "A3", "A5"]);
  assert.deepEqual(t("paid_short"), ["A4"]);
  assert.deepEqual(t("past_due"), ["A6"]);
  assert.deepEqual(t("not_in_qb"), ["A8"]);
  assert.deepEqual(t("missing"), ["M14", "M7"]);
  assert.equal(issues.find((i) => i.ref === "M14").level, "red");
  assert.equal(issues.find((i) => i.ref === "M7").level, "yellow");
  assert.equal(issues.find((i) => i.ref === "A3").direction, "less");
  // QB unreachable → only Past due can be computed
  assert.deepEqual(buildInvoiceIssues({ signet, qb: null, today }).map((i) => i.type), ["past_due"]);
});

test("invoice issues: saved status keeps handled items out of Open; Mark matched closes Not in QB", () => {
  const today = "2026-11-23";
  const signet = [R({ vendor_invoice: "S1", amount: 77, status: "PAID" }), R({ vendor_invoice: "S2", amount: 90, status: "PAID" })];
  const qb = qbInvoicesFrom([Q("Q-S1", 77, "2026-11-20")]);
  let issues = buildInvoiceIssues({ signet, qb, today });
  assert.deepEqual(issues.map((i) => i.key).sort(), ["issue:not_in_qb:S1", "issue:not_in_qb:S2"]);
  const notes = { "issue:not_in_qb:S1": { linked_ref: "Q-S1", issue_status: "done" }, "issue:not_in_qb:S2": { issue_status: "disputed" } };
  const linked = linkedRefsFrom(notes);
  assert.equal(linked.get("S1"), "Q-S1");
  issues = buildInvoiceIssues({ signet, qb, today, linked });
  assert.deepEqual(issues.map((i) => i.key), ["issue:not_in_qb:S2"]); // S1 now matches Q-S1 → issue gone
  const s = splitIssues(issues, notes);
  assert.deepEqual([s.open.length, s.disputed.length, s.done.length], [0, 1, 0]);
  // and the QB invoice is no longer "missing from Signet"
  assert.equal(buildMissingFromSignet({ qb, signet, today, linked }).length, 0);
});

test("last updated turns stale after 3 days", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  assert.equal(lastUpdated([{ last_seen_at: "2026-11-21T12:00:00Z" }], now).stale, false);
  assert.equal(lastUpdated([{ last_seen_at: "2026-11-19T12:00:00Z" }, { last_seen_at: "2026-11-20T11:00:00Z" }], now).stale, true);
  assert.equal(lastUpdated([], now).stale, true);
});

test("an RP repayment line never creates an invoice issue (not in QB, not past due)", () => {
  const signet = [
    R({ vendor_invoice: "CB01097104RP", amount: 2.64, status: "APPROVED", net_due_date: "2026-10-01" }),
    R({ vendor_invoice: "LP164710SKU20608766260922RP", amount: 500, status: "PAID" }),
  ];
  const qb = qbInvoicesFrom([Q("A1", 10)]);
  assert.deepEqual(buildInvoiceIssues({ signet, qb, today: "2026-11-23" }).filter((i) => i.ref.endsWith("RP")), []);
  assert.deepEqual(buildInvoiceIssues({ signet, qb: null, today: "2026-11-23" }), []);
});

test("data window: 2025-12-31 out, 2026-01-01 in, undated out; applies to deductions, runs, issues, upcoming", () => {
  assert.equal(DATA_START, "2026-01-01");
  const old = R({ vendor_invoice: "OLD1", posting_date: "2025-12-31", amount: 10, status: "APPROVED", net_due_date: "2026-12-20" });
  const edge = R({ vendor_invoice: "NEW1", posting_date: "2026-01-01", amount: 20, status: "APPROVED", net_due_date: "2026-12-20" });
  const undated = R({ vendor_invoice: "NEW2", posting_date: null, amount: 30, status: "APPROVED", net_due_date: "2026-12-20" });
  assert.deepEqual([inDataWindow(old), inDataWindow(edge), inDataWindow(undated)], [false, true, false]);
  const sp = splitByDataStart([old, edge, undated]);
  assert.deepEqual([sp.kept.length, sp.skipped.length], [1, 2]);
  const oldCredit = R({ type: "CREDIT", vendor_invoice: "CB01000001", posting_date: "2025-12-31", amount: 5, sap_payment_no: "2000000001" });
  const newCredit = R({ type: "CREDIT", vendor_invoice: "CB01000002", posting_date: "2026-03-01", amount: 6, sap_payment_no: "2000000002", payment_date: "2026-03-09" });
  const all = [old, edge, undated, oldCredit, newCredit];
  const f = applyDataStart(all, deriveDeductions(all));
  assert.deepEqual(f.rows.map((r) => r.vendor_invoice).sort(), ["CB01000002", "NEW1"]);
  assert.deepEqual(f.deductions.map((d) => d.reference), ["CB01000002"]);
  assert.deepEqual(derivePaymentRuns(f.rows).map((r) => r.sap_payment_no), ["2000000002"]);
  assert.equal(buildUpcoming(f.rows, { today: "2026-11-23" }).weeks.reduce((a, w) => a + w.invoices.length, 0), 1);
});

test("data window: a 2026 RP whose deduction is pre-2026 is unlinked, shown only as the unlinked repayment line, never an issue", () => {
  const oldCredit = R({ type: "CREDIT", vendor_invoice: "LP164710SKU20608766251201", posting_date: "2025-12-15", amount: 500 });
  const rp = R({ vendor_invoice: "LP164710SKU20608766251201RP", amount: 500, posting_date: "2026-02-02", sap_payment_no: "2000000009", payment_date: "2026-02-09" });
  const f = applyDataStart([oldCredit, rp], deriveDeductions([oldCredit, rp]));
  assert.equal(f.deductions.length, 0);
  const v = buildRunView(f.rows, { qbByNum: new Map(), deductions: f.deductions });
  assert.equal(v.unlinkedRepayments.length, 1);
  assert.equal(v.noMatch.length, 0);
  assert.deepEqual(buildInvoiceIssues({ signet: f.rows, qb: [], today: "2026-11-23" }), []);
});

test("QB window never reaches before DATA_START", () => {
  assert.equal(qbWindowStart("2026-02-10", 150), "2026-01-01");
  assert.equal(qbWindowStart("2026-11-23", 150), "2026-06-26");
});
