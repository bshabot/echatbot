import test from "node:test";
import assert from "node:assert/strict";
import { derivePaymentRuns, buildRunView, buildUpcoming, buildInvoiceIssues, qbInvoicesFrom, deriveDeductions, appliedGap } from "../src/utils/signetAp.js";
import {
  fmtMd, fmtMdy, fmtDowMd, updatedText, firstName, runSentence, buildRunSummary, comingUpLines, groupByPoType, groupIssues, disputedSubtitle, lineItemRows, repaymentsComing, repaymentsSubtitle, repaymentsComingGroups, repaymentLine, hiddenRepaymentsAll, hiddenText,
} from "../src/utils/signetApView.js";

let seq = 5000;
const R = (o) => ({ vendor: "7002165", type: "INVOICE", status: "PAID", vendor_invoice: "", posting_date: "2026-11-02", vim_invoice: String(++seq), po_number: null, amount: 0, net_due_date: "2026-11-10", sap_payment_no: null, payment_date: null, ...o });
const P = { sap_payment_no: "2000060344", payment_date: "2026-11-16" };
const Q = (num, amount, date = "2026-11-01") => ({ num, type: "Invoice", date, name: "Zales", memo: "", po: "", amount });

test("date formatting", () => {
  assert.equal(fmtMd("2026-11-16"), "11/16");
  assert.equal(fmtMd("2026-10-05"), "10/05");
  assert.equal(fmtMdy("2026-12-11"), "12/11/26");
  assert.equal(fmtDowMd("2026-12-07"), "Mon 12/7");
  assert.equal(fmtMd(null), "");
});

test("updatedText: today / yesterday / older (local time)", () => {
  const now = new Date(2026, 10, 23, 15, 0);
  assert.match(updatedText(new Date(2026, 10, 23, 9, 2).toISOString(), now), /^today, 9:02/);
  assert.match(updatedText(new Date(2026, 10, 22, 9, 2).toISOString(), now), /^yesterday, /);
  assert.match(updatedText(new Date(2026, 10, 19, 9, 2).toISOString(), now), /^11\/19\/26, /);
  assert.equal(updatedText(null, now), "never");
});

test("firstName from email or name", () => {
  assert.equal(firstName("ketty.smith@echabot.com"), "Ketty");
  assert.equal(firstName("KEVIN"), "Kevin");
  assert.equal(firstName(null), "");
});

function runLines(nClean, nShort, nCred) {
  const lines = [];
  for (let i = 0; i < nClean; i++) lines.push(R({ vendor_invoice: `70${i}`, amount: 100, po_number: "1", ...P }));
  for (let i = 0; i < nShort; i++) lines.push(R({ vendor_invoice: `69${i}`, amount: 90, po_number: "2", ...P }));
  for (let i = 0; i < nCred; i++) lines.push(R({ type: "CREDIT", vendor_invoice: `CB0100000${i}`, amount: 10, po_number: "3", ...P }));
  return lines;
}
const qbFor = (nClean, nShort) => new Map([...Array.from({ length: nClean }, (_, i) => [`70${i}`, { amount: 100 }]), ...Array.from({ length: nShort }, (_, i) => [`69${i}`, { amount: 100 }])]);

test("runSentence: all match / short / no QB / singular", () => {
  assert.equal(runSentence(buildRunView(runLines(2, 0, 1), { qbByNum: qbFor(2, 0) })), "2 invoices, all match. 1 chargeback.");
  assert.equal(runSentence(buildRunView(runLines(21, 10, 18), { qbByNum: qbFor(21, 10) })), "31 invoices. 21 match, 10 paid short. 18 chargebacks.");
  assert.equal(runSentence(buildRunView(runLines(3, 0, 0), { qbByNum: null })), "3 invoices.");
  assert.equal(runSentence(buildRunView(runLines(1, 0, 0), { qbByNum: qbFor(1, 0) })), "1 invoice, all match.");
});

test("buildRunSummary: rows, total, note (mirrors the 11/16 mockup at small scale)", () => {
  const lines = runLines(21, 10, 18);
  const v = buildRunView(lines, { qbByNum: qbFor(21, 10) });
  const s = buildRunSummary(v);
  assert.deepEqual(s.rows.map((r) => r.label), ["21 invoices paid in full", "10 invoices paid short (QuickBooks $1,000.00, short $100.00)", "18 price-variance chargebacks"]);
  assert.deepEqual(s.rows.map((r) => r.amount), [2100, 900, -180]);
  assert.equal(s.total, 2820);
  assert.equal(s.total, derivePaymentRuns(lines)[0].net_paid);
  assert.equal(s.note, "The $100.00 short goes to Invoice issues. The 18 chargebacks go to Chargebacks.");
});

test("comingUpLines: weeks, repaid, pending chargebacks", () => {
  const rows = [
    R({ vendor_invoice: "800001", amount: 1000, status: "APPROVED", net_due_date: "2026-12-07" }),
    R({ vendor_invoice: "800002", amount: 500, status: "APPROVED", net_due_date: "2026-12-10" }),
    R({ vendor_invoice: "CB01000001RP", amount: 40, status: "APPROVED", net_due_date: "2026-12-10" }),
    R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 75, status: "APPROVED" }),
  ];
  const c = comingUpLines(buildUpcoming(rows, { today: "2026-11-23" }));
  assert.deepEqual(c.lines.map((l) => l.label), ["Mon 12/7 · 1 full, 0 chargeback, 0 repayment", "Mon 12/14 · 1 full, 0 chargeback, 1 repayment", "Chargebacks not taken yet"]);
  assert.deepEqual(c.lines.map((l) => l.amount), [1000, 540, -75]);
});

test("groupByPoType: 25 late on one PO = one row; same PO other type is separate", () => {
  const items = [];
  for (let i = 0; i < 25; i++) items.push({ type: "late", po_number: "164707", amount: 500, vim_invoice: `L${i}` });
  items.push({ type: "price_variance", po_number: "164707", amount: 12.5, vim_invoice: "P1" }, { type: "allowance", po_number: null, amount: 778.04, vim_invoice: "A1" });
  const g = groupByPoType(items);
  assert.equal(g.length, 3);
  assert.deepEqual([g[0].po, g[0].type, g[0].count, g[0].total], ["164707", "late", 25, 12500]);
  assert.equal(g.find((x) => x.type === "allowance").po, "");
});

test("disputedSubtitle", () => {
  const d = [{ type: "late", po_number: "164707" }, { type: "late", po_number: "164707" }, { type: "qc", po_number: "141750" }, { type: "qc", po_number: "149920" }];
  assert.equal(disputedSubtitle(d), "PO 164707 late · QC 141750 / 149920");
  assert.equal(disputedSubtitle([]), "none");
});

test("groupIssues: paid short from one run = one row with summed amounts; other runs/types stay apart", () => {
  const signet = [], qb = [];
  for (let i = 0; i < 10; i++) {
    signet.push(R({ vendor_invoice: `6923${20 + i}`, amount: 90, status: "PAID", po_number: "9", ...P }));
    qb.push(Q(`6923${20 + i}`, 100));
  }
  signet.push(R({ vendor_invoice: "692999", amount: 50, status: "PAID", sap_payment_no: "2000055910", payment_date: "2026-10-26" })); qb.push(Q("692999", 60));
  signet.push(R({ vendor_invoice: "N1", amount: 100, status: "APPROVED", net_due_date: "2026-12-01" }), R({ vendor_invoice: "N2", amount: 209, status: "APPROVED", net_due_date: "2026-12-01" }));
  const issues = buildInvoiceIssues({ signet, qb: qbInvoicesFrom(qb), today: "2026-11-23" });
  const rows = groupIssues(issues);
  const ps = rows.filter((r) => r.type === "paid_short");
  assert.equal(ps.length, 2);
  const big = ps.find((r) => r.count === 10);
  assert.deepEqual([big.qbAmount, big.signetAmount, big.diff, big.payDate, big.refText], [1000, 900, -100, "2026-11-16", "692320 to 692329"]);
  assert.equal(ps.find((r) => r.count === 1).id, "issue:paid_short:692999");
  const nq = rows.find((r) => r.type === "not_in_qb");
  assert.deepEqual([nq.count, nq.signetAmount, nq.refText, nq.due], [2, 309, "N1, N2", "2026-12-01"]);
  assert.equal(nq.qbAmount, null);
});

test("run summary folds repayments into chargeback lines and still foots to net paid", () => {
  const earlier = R({ type: "CREDIT", vendor_invoice: "LP164710SKU20608766260922", amount: 500, posting_date: "2026-10-05", po_number: "164710" });
  const rp = R({ vendor_invoice: "LP164710SKU20608766260922RP", amount: 500, ...P });
  const orphan = R({ vendor_invoice: "CB09999999RP", amount: 40, ...P });
  const lines = [
    R({ vendor_invoice: "700", amount: 100, ...P }), R({ vendor_invoice: "701", amount: 100, ...P }),
    R({ type: "CREDIT", vendor_invoice: "CB01543210", amount: 30, ...P }), rp, orphan,
  ];
  const deductions = deriveDeductions([earlier, rp]);
  const v = buildRunView(lines, { qbByNum: new Map([["700", { amount: 100 }], ["701", { amount: 100 }]]), deductions });
  const s = buildRunSummary(v);
  assert.deepEqual(s.rows.map((r) => r.label), ["2 invoices paid in full", "1 price-variance chargeback", "Repaid earlier late-delivery chargebacks"]);
  assert.deepEqual(s.rows.map((r) => r.amount), [200, -30, 500]);
  // the orphan RP ($40) is not listed, but is still in the total; the note explains the difference
  assert.equal(s.rows.reduce((a, r) => a + r.amount, 0) + 40, s.total);
  assert.deepEqual([s.hidden.count, s.hidden.amount], [1, 40]);
  assert.equal(s.hiddenNote, "1 repayment hidden (original chargeback is before 1/1/26): $40.00, still counted in the total");
  assert.equal(v.hiddenRepayments.count, 1);
  assert.ok(!s.rows.some((r) => /no matching/.test(r.label)));
  assert.equal(s.total, 710);
  assert.equal(s.total, derivePaymentRuns(lines)[0].net_paid);
  assert.ok(!s.rows.some((r) => /repayments? of earlier/.test(r.label)));
  assert.equal(runSentence(v), "2 invoices, all match. 1 chargeback."); // no "repaid" part
  // gap check unchanged: everything is applied, gap 0
  assert.deepEqual(appliedGap(v.header.net_paid, v.applied), { gap: 0, ok: true });
  assert.equal(v.unlinkedRepayments.length, 1);
  assert.equal(v.deductionNet, -470); // 30 deducted less the one linked 500 repayment
});

test("run summary: chargeback and its own repayment in the same run net to a labelled zero line", () => {
  const credit = R({ type: "CREDIT", vendor_invoice: "LP164710SKU20608766260922", amount: 500, ...P });
  const rp = R({ vendor_invoice: "LP164710SKU20608766260922RP", amount: 500, ...P });
  const lines = [R({ vendor_invoice: "700", amount: 100, ...P }), credit, rp];
  const v = buildRunView(lines, { qbByNum: new Map([["700", { amount: 100 }]]), deductions: deriveDeductions([credit, rp]) });
  const s = buildRunSummary(v);
  assert.equal(s.rows[1].label, "1 late-delivery chargeback (net of repayments)");
  assert.equal(s.rows[1].amount, 0);
  assert.equal(s.total, 100);
});

test("line items view: one flat row per deduction, newest first; issues ungrouped on request", () => {
  const items = [
    { type: "late", po_number: "164707", amount: 500, vim_invoice: "a" }, { type: "late", po_number: "164707", amount: 500, vim_invoice: "b" },
    { type: "price_variance", po_number: null, amount: 12.5, vim_invoice: "c" },
  ];
  const dates = { a: "2026-11-01", b: "2026-11-10", c: "2026-11-05" };
  const rows = lineItemRows(items, (d) => dates[d.vim_invoice]);
  assert.deepEqual(rows.map((r) => r.items[0].vim_invoice), ["b", "c", "a"]);
  assert.ok(rows.every((r) => r.count === 1 && r.total === r.items[0].amount));
  assert.equal(rows[1].po, "");
  const signet = [], qb = [];
  for (let i = 0; i < 3; i++) { signet.push(R({ vendor_invoice: `7000${i}`, amount: 90, status: "PAID", ...P })); qb.push(Q(`7000${i}`, 100)); }
  const issues = buildInvoiceIssues({ signet, qb: qbInvoicesFrom(qb), today: "2026-11-23" });
  assert.equal(groupIssues(issues).length, 1);
  const flat = groupIssues(issues, { grouped: false });
  assert.equal(flat.length, 3);
  assert.ok(flat.every((r) => r.count === 1 && r.id.startsWith("issue:paid_short:")));
});

test("repayments coming: names the original chargeback, skips done/paid, subtitle + groups + row line", () => {
  const D = (vim, reference, po, type, rp, due, status = "new") => ({ vim_invoice: vim, reference, po_number: po, type, status, repayment_vim_invoice: rp, repayment_due_date: due, amount: 500 });
  const deductions = [
    D("1", "LP164710SKU20608766260922", "164710", "late", "r1", "2026-12-11"),
    D("2", "LP167896SKU20608766260922", "167896", "late", "r2", "2026-12-18", "disputed"),
    D("3", "LP1SKU", "1", "late", "r3", "2026-12-04", "done"), // closed
    D("4", "CB01000004", "9", "price_variance", null, null), // no repayment
    D("5", "CB01000005", "9", "price_variance", "r5", "2026-11-20"), // RP already paid
  ];
  const rowsByVim = new Map([
    ["r1", { status: "APPROVED", amount: 500, vendor_invoice: "LP164710SKU20608766260922RP" }],
    ["r2", { status: "APPROVED", amount: 290, vendor_invoice: "LP167896SKU20608766260922RP" }],
    ["r5", { status: "PAID", amount: 500 }],
  ]);
  const list = repaymentsComing(deductions, rowsByVim);
  assert.deepEqual(list.map((r) => [r.reference, r.amount, r.due]), [["LP164710SKU20608766260922", 500, "2026-12-11"], ["LP167896SKU20608766260922", 290, "2026-12-18"]]);
  assert.equal(repaymentsSubtitle(list), "Due 12/11/26 · PO 164710 late, PO 167896 late");
  assert.equal(repaymentsSubtitle([]), "none");
  const g = repaymentsComingGroups([...list, { ...list[0], vim: "9", amount: 100 }]);
  assert.deepEqual(g.map((x) => [x.label, x.count, x.total]), [["PO 164710 late", 2, 600], ["PO 167896 late", 1, 290]]);
  assert.equal(repaymentLine([deductions[0]]), "repayment of LP164710SKU20608766260922 coming 12/11");
  assert.equal(repaymentLine([deductions[0], deductions[1]]), "repayment of 2 chargebacks coming 12/11");
  assert.equal(repaymentLine([deductions[2], deductions[3]]), "");
});

test("hidden repayments: page-level count/amount across runs; plural wording", () => {
  const linkedRp = R({ vendor_invoice: "CB01000001RP", amount: 10, ...P });
  const orphan1 = R({ vendor_invoice: "CB09999999RP", amount: 40, ...P });
  const orphan2 = R({ vendor_invoice: "LP1SKU20608766260922RP", amount: 5.5, sap_payment_no: "2000000002" });
  const h = hiddenRepaymentsAll([linkedRp, orphan1, orphan2, R({ vendor_invoice: "700", amount: 1 })], [{ repayment_vim_invoice: linkedRp.vim_invoice }]);
  assert.deepEqual([h.count, h.amount], [2, 45.5]);
  assert.equal(hiddenText(2), "2 repayments hidden (original chargeback is before 1/1/26)");
  assert.equal(hiddenText(1), "1 repayment hidden (original chargeback is before 1/1/26)");
});
