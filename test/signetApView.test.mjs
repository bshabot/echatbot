import test from "node:test";
import assert from "node:assert/strict";
import { derivePaymentRuns, buildRunView, buildUpcoming, buildInvoiceIssues, qbInvoicesFrom } from "../src/utils/signetAp.js";
import {
  fmtMd, fmtMdy, fmtDowMd, updatedText, firstName, runSentence, buildRunSummary, comingUpLines, groupByPoType, groupIssues, disputedSubtitle,
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
  assert.deepEqual(c.lines.map((l) => l.label), ["Mon 12/7 · 1 invoice", "Mon 12/14 · 1 invoice + $40.00 repaid", "Chargebacks not taken yet"]);
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
