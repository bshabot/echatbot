// src/utils/signetQbMatch.js
//
// Match QuickBooks invoices + chargebacks (credit memos) against Signet's
// AP payment export (SAP "SAPUI5 Export" xlsx, one row per invoice/credit).
// Pure functions, no I/O — used by scripts/signet-qb-match.mjs and testable.
//
// QB rows (CustomerBalanceDetail, txn_types=Invoice,CreditMemo,
// detail_level=SummaryOnly) look like:
//   { num:"692350", type:"Invoice", date, memo:"under paid", po:"156488", amount:10359.04 }
//   { num:"CB#1520871", type:"Credit Memo", date, memo:"", po:"", amount:-1072 }
// Signet rows: Vendor Invoice#, Type (INVOICE|CREDIT), Invoice Status,
// PO Number, Amount Due, Posting Date, Payment Date.
//
// SECTION 1 — invoices: QB Num === Signet "Vendor Invoice#". Compare amounts.
//   Direction is from our side: Signet paid LESS than QB billed = "under",
//   MORE = "over". Within TOL = "equal".
// SECTION 2 — chargebacks: QB "CB#1520871" / "CB1532696" ↔ Signet
//   "CB01520871" (zero-padded; optional suffix FRT / QCCB / ...). The base
//   row matches the QB credit memo; suffix rows (e.g. the recurring $54 FRT)
//   are reported as "fee" rows so they're visible even though QB has no memo.
// MEMO — used (a) to read our own "paid $X" notes and flag when they disagree
//   with Signet, (b) as the fallback matcher when Num doesn't hit:
//   invoice → same PO# + memo "paid X" equal to a Signet amount;
//   chargeback → a CB number written inside the memo.

export const TOL = 0.01;

const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clean = (s) => String(s ?? "").trim();

export function parseMemoPaid(memo) {
  const m = clean(memo).match(/paid\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  return m ? money(m[1].replace(/,/g, "")) : null;
}

/** "CB#1520871" | "CB1532696" | "CB01520871FRT" → { core:"1520871", suffix:"FRT"|"" } */
export function parseCb(raw) {
  const m = clean(raw).toUpperCase().match(/CB\s*#?\s*0*(\d+)([A-Z]*)/);
  return m ? { core: m[1], suffix: m[2] || "" } : null;
}

export function isVoid(q) {
  return /^\s*void/i.test(clean(q.memo)) || (money(q.amount) === 0 && /void/i.test(clean(q.memo)));
}

export function normalizeSignet(rows) {
  return rows.map((r) => {
    const num = clean(r["Vendor Invoice#"]);
    const type = clean(r["Type"]).toUpperCase();
    const cb = type === "CREDIT" || /^CB/i.test(num) ? parseCb(num) : null;
    return {
      num,
      type,
      status: clean(r["Invoice Status"]),
      po: clean(r["PO Number"]),
      amount: money(r["Amount Due"]),
      postingDate: r["Posting Date"] || null,
      paymentDate: r["Payment Date"] || null,
      cb,
      raw: r,
    };
  });
}

/** QB report rows (cells keyed by col id) or already-normalized → normalized. */
export function normalizeQb(rows) {
  return rows.map((r) => ({
    num: clean(r.num ?? r["2"]),
    type: clean(r.type ?? r["3"]),
    date: r.date ?? r["4"] ?? null,
    name: clean(r.name ?? r["5"]),
    memo: clean(r.memo ?? r["6"]),
    po: clean(r.po ?? r["7"]),
    amount: money(r.amount ?? r["8"] ?? 0),
  }));
}

const isCreditMemo = (q) => /credit/i.test(q.type) || /^CB/i.test(q.num);

function classify(qbAmt, signetAmt) {
  const d = money(signetAmt - qbAmt);
  if (Math.abs(d) <= TOL) return { result: "equal", diff: 0 };
  return { result: d < 0 ? "under" : "over", diff: d }; // diff = Signet − QB
}

export function matchInvoices(qbRows, signetRows) {
  const qb = qbRows.filter((q) => !isCreditMemo(q));
  const sig = signetRows.filter((s) => s.type === "INVOICE");
  const byNum = new Map(sig.map((s) => [s.num, s]));
  const used = new Set();
  const out = [];

  for (const q of qb) {
    if (isVoid(q)) { out.push({ section: "invoice", result: "void", qb: q, signet: null, via: null }); continue; }
    let s = byNum.get(q.num), via = "num";
    if (!s) {
      // memo fallback: same PO + memo "paid X" equals a Signet amount
      const paid = parseMemoPaid(q.memo);
      if (paid != null && q.po)
        s = sig.find((x) => !used.has(x) && x.po === q.po && Math.abs(x.amount - paid) <= TOL);
      via = s ? "memo" : null;
    }
    if (!s) { out.push({ section: "invoice", result: "no-signet-match", qb: q, signet: null, via: null }); continue; }
    used.add(s);
    const c = classify(q.amount, s.amount);
    const memoPaid = parseMemoPaid(q.memo);
    out.push({
      section: "invoice", ...c, qb: q, signet: s, via,
      paid: s.status === "PAID",
      memoPaid,
      memoDisagrees: memoPaid != null && Math.abs(memoPaid - s.amount) > TOL,
    });
  }
  return { rows: out, signetOnly: sig.filter((s) => !used.has(s)) };
}

export function matchChargebacks(qbRows, signetRows) {
  const qb = qbRows.filter(isCreditMemo);
  const sig = signetRows.filter((s) => s.cb);
  const base = new Map(); // core → base (no-suffix) rows
  for (const s of sig) if (!s.cb.suffix) (base.get(s.cb.core) || base.set(s.cb.core, []).get(s.cb.core)).push(s);
  const used = new Set();
  const out = [];

  for (const q of qb) {
    const p = parseCb(q.num) || parseCb(q.memo);
    const via = parseCb(q.num) ? "num" : p ? "memo" : null;
    const cands = p ? base.get(p.core) || [] : [];
    const s = cands.find((x) => !used.has(x));
    if (!s) { out.push({ section: "chargeback", result: "no-signet-match", qb: q, signet: null, via: null }); continue; }
    used.add(s);
    out.push({ section: "chargeback", ...classify(Math.abs(q.amount), s.amount), qb: q, signet: s, via });
  }
  // Signet chargebacks we never booked in QB (plus fee rows like FRT/QCCB)
  const signetOnly = sig.filter((s) => !used.has(s)).map((s) => ({
    section: "chargeback",
    result: s.cb.suffix ? "fee-not-in-qb" : "not-in-qb",
    qb: null, signet: s, via: null,
  }));
  return { rows: out, signetOnly };
}

export function runMatch({ qbRows, signetRows, from = null }) {
  const qb = normalizeQb(qbRows);
  let sg = normalizeSignet(signetRows);
  if (from) sg = sg.filter((s) => !s.postingDate || new Date(s.postingDate) >= new Date(from));
  const inv = matchInvoices(qb, sg);
  const cb = matchChargebacks(qb, sg);
  const count = (rows, k) => rows.filter((r) => r.result === k).length;
  return {
    invoices: inv.rows,
    invoiceSignetOnly: inv.signetOnly,
    chargebacks: cb.rows,
    chargebackSignetOnly: cb.signetOnly,
    summary: {
      invoices: {
        equal: count(inv.rows, "equal"), under: count(inv.rows, "under"), over: count(inv.rows, "over"),
        noSignetMatch: count(inv.rows, "no-signet-match"), void: count(inv.rows, "void"),
        signetOnly: inv.signetOnly.length,
      },
      chargebacks: {
        equal: count(cb.rows, "equal"), under: count(cb.rows, "under"), over: count(cb.rows, "over"),
        noSignetMatch: count(cb.rows, "no-signet-match"),
        notInQb: count(cb.signetOnly, "not-in-qb"), feesNotInQb: count(cb.signetOnly, "fee-not-in-qb"),
      },
    },
  };
}
