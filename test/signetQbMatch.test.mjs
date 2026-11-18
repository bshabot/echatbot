import test from "node:test";
import assert from "node:assert/strict";
import { runMatch, parseCb, parseMemoPaid } from "../src/utils/signetQbMatch.js";

const S = (num, type, amt, po = "", status = "PAID") => ({ "Vendor Invoice#": num, Type: type, "Invoice Status": status, "PO Number": po, "Amount Due": amt });
const Q = (num, type, amount, memo = "", po = "") => ({ num, type, memo, po, amount });

test("parsers", () => {
  assert.deepEqual(parseCb("CB#1520871"), { core: "1520871", suffix: "" });
  assert.deepEqual(parseCb("CB01520871FRT"), { core: "1520871", suffix: "FRT" });
  assert.equal(parseMemoPaid("over paymnet    paid  $7,469.77"), 7469.77);
});

test("invoices: under / equal / void / memo fallback", () => {
  const r = runMatch({
    qbRows: [
      Q("692350", "Invoice", 10359.04, "under paid", "156488"),
      Q("692356", "Invoice", 7469.77, "", "165554"),
      Q("692333", "Invoice", 0, "VOID: x", "156480"),
      Q("999999", "Invoice", 50865.35, "U 9/14 paid 50865.35", "164710"),
    ],
    signetRows: [S("692350", "INVOICE", 9578.5, "156488"), S("692356", "INVOICE", 7469.77, "165554"), S("111", "INVOICE", 50865.35, "164710")],
  });
  const by = (n) => r.invoices.find((x) => x.qb.num === n);
  assert.equal(by("692350").result, "under");
  assert.equal(by("692350").diff, -780.54);
  assert.equal(by("692356").result, "equal");
  assert.equal(by("692333").result, "void");
  assert.equal(by("999999").via, "memo");
});

test("chargebacks: match base, surface FRT fee + unbooked CB", () => {
  const r = runMatch({
    qbRows: [Q("CB#1520871", "Credit Memo", -1072), Q("CB1599999", "Credit Memo", -5)],
    signetRows: [S("CB01520871", "CREDIT", 1072.26, "156490"), S("CB01520871FRT", "CREDIT", 54), S("CB01521225", "CREDIT", 7.94, "156489")],
  });
  assert.equal(r.chargebacks.find((x) => x.qb.num === "CB#1520871").result, "over");
  assert.equal(r.chargebacks.find((x) => x.qb.num === "CB1599999").result, "no-signet-match");
  assert.equal(r.summary.chargebacks.feesNotInQb, 1);
  assert.equal(r.summary.chargebacks.notInQb, 1);
});
