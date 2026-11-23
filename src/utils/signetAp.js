// src/utils/signetAp.js
//
// Pure logic for the Signet AP page (/invoice-match): parsing the 18-column
// Signet export, classifying references, deriving payment runs + deductions,
// diffing uploads, and building the Upcoming / Missing / Invoice-issues views.
// No I/O, no React — everything here is unit-tested (test/signetAp*.test.mjs).
//
// Dates are ISO "YYYY-MM-DD" strings everywhere; "today" is always passed in.

import { TOL, normalizeQb, isVoid } from "./signetQbMatch.js";
import { classifyRef, DEDUCTION_KINDS } from "./signetRef.js";

export { classifyRef };

export { TOL };

// ── small helpers ──────────────────────────────────────────────────────────
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const sum = (arr, f = (x) => x) => r2(arr.reduce((a, x) => a + (Number(f(x)) || 0), 0));
const clean = (v) => (v == null ? "" : String(v).trim());
const orNull = (v) => (clean(v) === "" ? null : clean(v));

/** Date | "YYYY-MM-DD" | "MM/DD/YYYY" | Excel serial → "YYYY-MM-DD" | null.
 *  Dates get +12h before slicing so UTC-midnight and local-midnight both land on the right day. */
export function toIso(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getTime() + 12 * 36e5).toISOString().slice(0, 10);
  if (typeof v === "number") return toIso(new Date(Math.round((v - 25569) * 864e5)));
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => new Date(toUtc(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
/** whole days a − b */
export const daysBetween = (a, b) => Math.round((toUtc(a) - toUtc(b)) / 864e5);

/** First Monday on or after the given date (Monday itself → same day). */
export function expectedPayDate(iso) {
  if (!iso) return null;
  const dow = toUtc(iso).getUTCDay(); // 0 Sun … 6 Sat
  return addDays(iso, (1 - dow + 7) % 7);
}

// ── parsing the 18 export columns ──────────────────────────────────────────
export const COLUMNS = [
  ["Vendor", "vendor"], ["Type", "type"], ["Invoice Status", "status"], ["Vendor Invoice#", "vendor_invoice"],
  ["Posting Date", "posting_date"], ["Vim Invoice#", "vim_invoice"], ["Supplier Invoice Date", "supplier_invoice_date"],
  ["SAP Invoice Number", "sap_invoice_number"], ["PO Number", "po_number"], ["SAP Invoice Date", "sap_invoice_date"],
  ["Amount Due", "amount"], ["Net Due Date", "net_due_date"], ["Disc 1 (%)", "disc1_pct"], ["Disc 1 Due Date", "disc1_due_date"],
  ["Disc 2 (%)", "disc2_pct"], ["Disc 2 Due Date", "disc2_due_date"], ["SAP Payment#", "sap_payment_no"], ["Payment Date", "payment_date"],
];
export const DB_COLS = COLUMNS.map(([, c]) => c);
const DATE_COLS = new Set(["posting_date", "supplier_invoice_date", "sap_invoice_date", "net_due_date", "disc1_due_date", "disc2_due_date", "payment_date"]);
const NUM_COLS = new Set(["amount", "disc1_pct", "disc2_pct"]);
/** Fields whose change between uploads is written to signet_ap_changes. */
export const TRACKED = ["amount", "status", "sap_payment_no", "payment_date", "net_due_date"];

/** One raw sheet row (keys = export headers) → one DB-shaped row, or null when it has no Vim Invoice#. */
export function normalizeSignetRow(raw) {
  const o = {};
  for (const [h, c] of COLUMNS) {
    const v = raw[h];
    if (DATE_COLS.has(c)) o[c] = toIso(v);
    else if (NUM_COLS.has(c)) o[c] = clean(v) === "" || isNaN(Number(v)) ? (c === "amount" ? 0 : null) : r2(v);
    else o[c] = orNull(v);
  }
  o.type = (o.type || "").toUpperCase();
  o.status = o.status ? o.status.toUpperCase() : null;
  return o.vim_invoice ? o : null;
}

/** All sheet rows → { rows (deduped by vim, last wins), skipped (no vim) }. */
export function parseSignetExport(rawRows) {
  const byVim = new Map();
  let skipped = 0;
  for (const raw of rawRows) {
    if (clean(raw["Vendor Invoice#"]) === "" && clean(raw["Vim Invoice#"]) === "") continue; // blank line
    const r = normalizeSignetRow(raw);
    if (!r) { skipped++; continue; }
    byVim.set(r.vim_invoice, r);
  }
  return { rows: [...byVim.values()], skipped };
}

export const isDropship = (row) => row.type !== "CREDIT" && classifyRef(row.vendor_invoice).kind === "dropship";
export const isRepaymentRow = (row) => row.type !== "CREDIT" && classifyRef(row.vendor_invoice).isRepayment;
/** Plain invoice we expect to find in QB (not dropship, not an RP line, not a credit). */
export const isBillableInvoice = (row) => row.type !== "CREDIT" && !isDropship(row) && !isRepaymentRow(row);

export const DEDUCTION_LABEL = {
  price_variance: "Price variance", late: "Late delivery", qc: "Quality", zales_late: "Zales late delivery",
  allowance: "PAC allowance", unknown: "Freight / other",
};

// ── payment runs ───────────────────────────────────────────────────────────
/** One row per SAP Payment#. invoices − credits = net paid. Newest first. */
export function derivePaymentRuns(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.sap_payment_no) continue;
    if (!by.has(r.sap_payment_no)) by.set(r.sap_payment_no, []);
    by.get(r.sap_payment_no).push(r);
  }
  const runs = [];
  for (const [no, lines] of by) {
    const invoice_total = sum(lines.filter((l) => l.type !== "CREDIT"), (l) => l.amount);
    const deduction_total = sum(lines.filter((l) => l.type === "CREDIT"), (l) => l.amount);
    const dates = lines.map((l) => l.payment_date).filter(Boolean).sort();
    runs.push({
      sap_payment_no: no, payment_date: dates[dates.length - 1] || null,
      invoice_total, deduction_total, net_paid: r2(invoice_total - deduction_total), line_count: lines.length,
    });
  }
  return runs.sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || "") || b.sap_payment_no.localeCompare(a.sap_payment_no));
}

/** Which derived run fields differ from what is stored (never touches status/qb_txn_id/approved_*). */
const RUN_FIELDS = ["payment_date", "invoice_total", "deduction_total", "net_paid", "line_count"];
export function planRunWrites(derived, existing) {
  const ex = new Map((existing || []).map((r) => [String(r.sap_payment_no), r]));
  const upserts = derived.filter((d) => {
    const e = ex.get(d.sap_payment_no);
    return !e || RUN_FIELDS.some((f) => (f === "payment_date" ? e[f] !== d[f] : Number(e[f]) !== Number(d[f])));
  });
  return { upserts: upserts.map((d) => Object.fromEntries([["sap_payment_no", d.sap_payment_no], ...RUN_FIELDS.map((f) => [f, d[f]])])) };
}

/**
 * Sort one run's lines into the Payments-tab sections.
 * qbByNum: Map(num → {amount,…}) or null when QuickBooks couldn't be reached.
 * deductions: signet_deductions rows (used to link RP lines to what they repay).
 * lookup(line) (optional) overrides the QB invoice for a line (Mark matched).
 */
export function buildRunView(lines, { qbByNum = null, deductions = [], lookup } = {}) {
  const view = {
    header: null, clean: [], short: [], over: [], deductions: [], repayments: [],
    dropship: { lines: [], total: 0, mismatch: [] }, noMatch: [], unchecked: [], qbChecked: !!qbByNum,
  };
  const dedByRp = new Map(deductions.filter((d) => d.repayment_vim_invoice).map((d) => [d.repayment_vim_invoice, d]));
  for (const l of lines) {
    if (l.type === "CREDIT") { view.deductions.push({ line: l, type: classifyDeductionType(l) }); continue; }
    const c = classifyRef(l.vendor_invoice);
    if (c.isRepayment) { view.repayments.push({ line: l, deduction: dedByRp.get(l.vim_invoice) || null, base: c.base }); continue; }
    const q = qbByNum ? (lookup ? lookup(l) : null) || qbByNum.get(l.vendor_invoice) : null;
    if (c.kind === "dropship") {
      view.dropship.lines.push(l);
      if (q && Math.abs(r2(l.amount - q.amount)) > TOL) view.dropship.mismatch.push({ line: l, qb: q.amount });
      continue;
    }
    if (!qbByNum) { view.unchecked.push(l); continue; }
    if (!q) { view.noMatch.push(l); continue; }
    const diff = r2(l.amount - q.amount);
    if (Math.abs(diff) <= TOL) view.clean.push({ line: l, qb: q.amount });
    else if (diff < 0) view.short.push({ line: l, qb: q.amount, signet: l.amount, diff });
    else view.over.push({ line: l, qb: q.amount, signet: l.amount, diff });
  }
  view.dropship.total = sum(view.dropship.lines, (l) => l.amount);
  const invoiceTotal = sum(lines.filter((l) => l.type !== "CREDIT"), (l) => l.amount);
  const dedTotal = sum(view.deductions, (d) => d.line.amount);
  view.header = { invoice_total: invoiceTotal, deduction_total: dedTotal, net_paid: r2(invoiceTotal - dedTotal), line_count: lines.length };
  // What we could apply in QB: matched invoices (at what Signet paid), dropship, repayments, less every deduction.
  // Lines with no QB invoice can't be applied, so the gap = net paid − applied = what is still unaccounted for.
  const applied = r2(
    sum(view.clean, (x) => x.line.amount) + sum(view.short, (x) => x.line.amount) + sum(view.over, (x) => x.line.amount)
    + view.dropship.total + sum(view.repayments, (x) => x.line.amount) - dedTotal,
  );
  view.applied = view.qbChecked ? applied : null;
  view.gap = view.qbChecked ? r2(view.header.net_paid - applied) : null;
  view.cleanTotal = sum(view.clean, (x) => x.line.amount);
  // Repayments are not shown as items: each linked RP is folded into the chargeback type it repays.
  // An RP that can't be linked stays visible (unlinkedRepayments) so nothing disappears. The gap check above is unaffected.
  const linked = view.repayments.filter((x) => x.deduction);
  view.unlinkedRepayments = view.repayments.filter((x) => !x.deduction);
  const types = new Map();
  const slot = (t) => types.get(t) || types.set(t, { type: t, count: 0, deducted: 0, repaid: 0, repaidCount: 0 }).get(t);
  for (const d of view.deductions) { const t = slot(d.type); t.count++; t.deducted += d.line.amount; }
  for (const x of linked) { const t = slot(x.deduction.type); t.repaidCount++; t.repaid += x.line.amount; }
  view.byType = [...types.values()].map((t) => ({ ...t, deducted: r2(t.deducted), repaid: r2(t.repaid), net: r2(t.repaid - t.deducted) }));
  view.deductionNet = r2(dedTotal - sum(linked, (x) => x.line.amount));
  return view;
}

/** applied total must equal net paid to the cent. */
export function appliedGap(netPaid, applied) {
  const gap = r2(netPaid - applied);
  return { gap, ok: Math.abs(gap) < 0.005 };
}

// ── deductions ─────────────────────────────────────────────────────────────
export const HISTORY_CUTOFF = "2026-02-01";

export function classifyDeductionType(row) {
  const k = classifyRef(row.vendor_invoice).kind;
  return DEDUCTION_KINDS.has(k) ? k : "unknown";
}

const vimNum = (v) => (isNaN(Number(v)) ? 0 : Number(v));
const byAge = (a, b) => (a.posting_date || "").localeCompare(b.posting_date || "") || vimNum(a.vim_invoice) - vimNum(b.vim_invoice);

/**
 * Every CREDIT line → a deduction record, with RP repayments attached and re-charges flagged.
 * Output fields: the signet_deductions derived columns + initial_status/initial_done_reason
 * (what a brand-new row starts as) + repaid (RP line is PAID).
 */
export function deriveDeductions(rows, { historyCutoff = HISTORY_CUTOFF } = {}) {
  const credits = rows.filter((r) => r.type === "CREDIT").sort(byAge);
  const rps = rows.filter(isRepaymentRow).sort(byAge);
  const byRef = new Map();
  for (const c of credits) {
    const k = c.vendor_invoice.toUpperCase();
    if (!byRef.has(k)) byRef.set(k, []);
    byRef.get(k).push(c);
  }
  const linked = new Map(); // credit vim → rp row
  const usedRp = new Set();
  for (const rp of rps) {
    const cands = byRef.get(classifyRef(rp.vendor_invoice).base) || [];
    const open = cands.filter((c) => !linked.has(c.vim_invoice));
    const pick = open.find((c) => Math.abs(c.amount - rp.amount) <= TOL) || open[0] || null;
    if (pick) { linked.set(pick.vim_invoice, rp); usedRp.add(rp.vim_invoice); }
  }

  // single Signet invoice with the same PO (best effort) for price-variance credits
  const invByPo = new Map();
  for (const r of rows) if (isBillableInvoice(r) && r.po_number) (invByPo.get(r.po_number) || invByPo.set(r.po_number, []).get(r.po_number)).push(r);

  const seen = new Map(); // po|line|amount → earlier deductions
  const out = [];
  for (const c of credits) {
    const cl = classifyRef(c.vendor_invoice);
    const type = classifyDeductionType(c);
    const po = cl.po || c.po_number || null;
    const amount = r2(Math.abs(c.amount));
    const rp = linked.get(c.vim_invoice) || null;
    const repaid = !!rp && rp.status === "PAID";
    let chargedBefore = null;
    if (cl.line && po) {
      const key = `${po}|${cl.line}|${amount}`;
      const prior = (seen.get(key) || []).find((p) => p.reference.toUpperCase() !== c.vendor_invoice.toUpperCase());
      chargedBefore = prior ? prior.vim_invoice : null;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ vim_invoice: c.vim_invoice, reference: c.vendor_invoice });
    }
    const invs = type === "price_variance" && po ? invByPo.get(po) || [] : [];
    out.push({
      vim_invoice: c.vim_invoice, type, reference: c.vendor_invoice, po_number: po, sku: cl.sku || null, line: cl.line || null,
      amount, repayment_vim_invoice: rp ? rp.vim_invoice : null, repayment_due_date: rp ? rp.net_due_date : null,
      repayment_status: rp ? rp.status : null, charged_before_of: chargedBefore,
      linked_invoice: invs.length === 1 ? invs[0].vendor_invoice : null,
      repaid, posting_date: c.posting_date, sap_payment_no: c.sap_payment_no, credit_status: c.status,
      initial_status: repaid ? "done" : "new",
      initial_done_reason: repaid ? ((c.posting_date || "") < historyCutoff ? "history" : "repaid") : null,
    });
  }
  return out;
}

export const DED_DERIVED = ["type", "reference", "po_number", "sku", "line", "amount", "repayment_vim_invoice", "repayment_due_date", "charged_before_of", "linked_invoice"];
const same = (a, b) => (a == null || a === "") && (b == null || b === "") || String(a) === String(b) || (!isNaN(Number(a)) && !isNaN(Number(b)) && a !== "" && b !== "" && Number(a) === Number(b));

/** Best-effort: find a saved invoice_match_notes note for a CB credit ("chargeback:CB#1520871" ↔ "CB01520871"). */
export function carryOverNote(notes, reference) {
  const m = clean(reference).toUpperCase().match(/^CB0*(\d+)$/);
  if (!m || !notes) return "";
  for (const [k, v] of Object.entries(notes)) {
    if (!k.startsWith("chargeback:")) continue;
    const mm = k.slice(11).toUpperCase().match(/^CB\s*#?\s*0*(\d+)$/);
    if (mm && mm[1] === m[1] && clean(v?.note)) return clean(v.note);
  }
  return "";
}

/**
 * Decide what to write. NEVER touches status/note/follow_up_date/qb_txn_id of existing rows,
 * except the automatic move to Done when Signet pays the RP line.
 * existing: signet_deductions rows. notes: { note_key: {note} } for carry-over.
 */
export function planDeductionWrites(derived, existing, { notes = {}, now = new Date().toISOString() } = {}) {
  const ex = new Map((existing || []).map((r) => [String(r.vim_invoice), r]));
  const plan = { inserts: [], updates: [], repaid: [], logs: [] };
  for (const d of derived) {
    const e = ex.get(d.vim_invoice);
    if (!e) {
      const note = carryOverNote(notes, d.reference);
      plan.inserts.push({
        vim_invoice: d.vim_invoice, ...Object.fromEntries(DED_DERIVED.map((f) => [f, d[f] ?? null])),
        status: d.initial_status, done_reason: d.initial_done_reason, note: note || null, updated_at: now,
      });
      if (note) plan.logs.push({ vim_invoice: d.vim_invoice, who: "system", from_value: "", to_value: "note carried over", at: now });
      continue;
    }
    if (DED_DERIVED.some((f) => !same(e[f], d[f]))) {
      plan.updates.push({ vim_invoice: d.vim_invoice, ...Object.fromEntries(DED_DERIVED.map((f) => [f, d[f] ?? null])), updated_at: now });
    }
    if (d.repaid && e.status !== "done") {
      plan.repaid.push({ vim_invoice: d.vim_invoice, status: "done", done_reason: "repaid", updated_at: now });
      plan.logs.push({ vim_invoice: d.vim_invoice, who: "system", from_value: e.status, to_value: "done (repaid)", at: now });
    }
  }
  return plan;
}

/** Group deductions by PO: one expandable row per PO. */
export function groupByPo(items, getPo = (d) => d.po_number) {
  const m = new Map();
  for (const d of items) {
    const po = clean(getPo(d)) || "";
    if (!m.has(po)) m.set(po, []);
    m.get(po).push(d);
  }
  return [...m.entries()].map(([po, list]) => ({
    po, items: list, count: list.length, total: sum(list, (x) => x.amount),
    types: [...new Set(list.map((x) => x.type))],
  })).sort((a, b) => b.total - a.total || a.po.localeCompare(b.po));
}

// ── uploads: diff against what is stored ───────────────────────────────────
const normVal = (c, v) => (v == null || v === "" ? null : NUM_COLS.has(c) ? r2(v) : String(v));

/**
 * incoming: parseSignetExport rows. existing: stored rows (any extra columns ignored).
 * → { inserts, updates (changed rows, full), touched (vims unchanged → only last_seen_at moves), changes }
 */
export function diffSignetRows(incoming, existing, now = new Date().toISOString()) {
  const ex = new Map((existing || []).map((r) => [String(r.vim_invoice), r]));
  const out = { inserts: [], updates: [], touched: [], changes: [] };
  for (const r of incoming) {
    const e = ex.get(r.vim_invoice);
    if (!e) { out.inserts.push({ ...r, first_seen_at: now, last_changed_at: now, last_seen_at: now }); continue; }
    const diffs = DB_COLS.filter((c) => normVal(c, e[c]) !== normVal(c, r[c]));
    if (!diffs.length) { out.touched.push(r.vim_invoice); continue; }
    out.updates.push({ ...r, last_changed_at: now, last_seen_at: now });
    for (const f of TRACKED.filter((t) => diffs.includes(t))) {
      out.changes.push({ vim_invoice: r.vim_invoice, field: f, old_value: normVal(f, e[f]) == null ? null : String(normVal(f, e[f])), new_value: normVal(f, r[f]) == null ? null : String(normVal(f, r[f])), changed_at: now });
    }
  }
  return out;
}

// ── Upcoming ───────────────────────────────────────────────────────────────
export const PAST_DUE_DAYS = 7;

/**
 * Every APPROVED line, bucketed. weeks[] are by expected pay Monday (first Monday on/after Net Due Date).
 * pastDue: invoice/RP lines > 7 days past Net Due Date. dropship: spread over runs. anyRun: APPROVED credits.
 */
export function buildUpcoming(rows, { today }) {
  const weeks = new Map();
  const pastDue = [], dropship = [], anyRun = [], noDate = [];
  for (const r of rows) {
    if (r.status !== "APPROVED") continue;
    if (r.type === "CREDIT") { anyRun.push(r); continue; }
    if (isDropship(r)) { dropship.push(r); continue; }
    if (r.net_due_date && daysBetween(today, r.net_due_date) > PAST_DUE_DAYS) { pastDue.push(r); continue; }
    if (!r.net_due_date) { noDate.push(r); continue; }
    const mon = expectedPayDate(r.net_due_date);
    if (!weeks.has(mon)) weeks.set(mon, { monday: mon, invoices: [], repayments: [] });
    weeks.get(mon)[isRepaymentRow(r) ? "repayments" : "invoices"].push(r);
  }
  const wk = [...weeks.values()].sort((a, b) => a.monday.localeCompare(b.monday)).map((w) => ({
    ...w, invoiceTotal: sum(w.invoices, (x) => x.amount), repaymentTotal: sum(w.repayments, (x) => x.amount),
    net: sum([...w.invoices, ...w.repayments], (x) => x.amount),
  }));
  const tot = (a) => ({ lines: a, count: a.length, total: sum(a, (x) => x.amount) });
  return { weeks: wk, pastDue: tot(pastDue), dropship: tot(dropship), anyRun: tot(anyRun), noDate: tot(noDate) };
}

/** Dollars expected in the next n runs (weeks with a Monday on/after today). */
export function expectedNextRuns(upcoming, today, n = 2) {
  const w = upcoming.weeks.filter((x) => x.monday >= today).slice(0, n);
  return { total: sum(w, (x) => x.net), mondays: w.map((x) => x.monday) };
}

// ── QB side helpers ────────────────────────────────────────────────────────
const isQbCredit = (q) => /credit/i.test(q.type) || /^CB/i.test(q.num);
/** fetchQbArTxns rows → live invoices only (no credit memos, no voids, no zero lines). */
export function qbInvoicesFrom(rows) {
  return normalizeQb(rows || []).filter((q) => q.num && !isQbCredit(q) && !isVoid(q) && q.amount !== 0);
}

// ── Missing from Signet ────────────────────────────────────────────────────
export const MISSING_YELLOW = 7;
export const MISSING_RED = 14;
export const ageLevel = (days) => (days >= MISSING_RED ? "red" : days >= MISSING_YELLOW ? "yellow" : "ok");

/** QB invoices with no line in Signet data. linked: Map(signet vendor_invoice → QB num) from Mark matched. */
export function buildMissingFromSignet({ qb, signet, today, linked = new Map() }) {
  const have = new Set(signet.filter((s) => s.type !== "CREDIT").map((s) => s.vendor_invoice));
  for (const qnum of linked.values()) have.add(qnum);
  return qb.filter((q) => !have.has(q.num) && q.date)
    .map((q) => {
      const days = Math.max(0, daysBetween(today, toIso(q.date)));
      return { num: q.num, po: q.po || "", amount: q.amount, date: toIso(q.date), days, level: ageLevel(days) };
    })
    .sort((a, b) => b.days - a.days);
}

// ── Invoice issues ─────────────────────────────────────────────────────────
export const ISSUE_LABEL = {
  missing: "Signet doesn't have it", amount_diff: "Amount is different", paid_short: "Paid short",
  past_due: "Past due", not_in_qb: "Not in QuickBooks",
};
export const issueKey = (type, ref) => `issue:${type}:${ref}`;

/**
 * Computed live. qb = qbInvoicesFrom(...) or null if QuickBooks is unreachable (then only Past due is computed).
 * qbFrom: start of the QB pull — Signet lines posted before it are not compared (QB side would be missing).
 * linked: Map(signet vendor_invoice → QB invoice num) from "Mark matched".
 */
export function buildInvoiceIssues({ signet, qb, today, qbFrom = null, linked = new Map() }) {
  const issues = [];
  const qbByNum = qb ? new Map(qb.map((q) => [q.num, q])) : null;
  const billable = signet.filter(isBillableInvoice);
  const inWindow = (r) => !qbFrom || !r.posting_date || r.posting_date >= qbFrom;

  for (const r of signet.filter((x) => x.status === "APPROVED" && x.type !== "CREDIT" && !isRepaymentRow(x))) { // an RP line belongs to its chargeback, never an issue
    if (!r.net_due_date) continue;
    const days = daysBetween(today, r.net_due_date);
    if (days > PAST_DUE_DAYS) {
      issues.push({ key: issueKey("past_due", r.vendor_invoice), type: "past_due", ref: r.vendor_invoice, vim: r.vim_invoice, po: r.po_number || "", signetAmount: r.amount, date: r.net_due_date, days, level: days >= MISSING_RED ? "red" : "yellow" });
    }
  }
  if (!qbByNum) return issues;

  for (const r of billable.filter(inWindow)) {
    const q = qbByNum.get(linked.get(r.vendor_invoice) || r.vendor_invoice);
    if (!q) {
      if (linked.has(r.vendor_invoice)) continue;
      issues.push({ key: issueKey("not_in_qb", r.vendor_invoice), type: "not_in_qb", ref: r.vendor_invoice, vim: r.vim_invoice, po: r.po_number || "", signetAmount: r.amount, date: r.posting_date, due: r.net_due_date, payNo: r.sap_payment_no || null, payDate: r.payment_date || null });
      continue;
    }
    const diff = r2(r.amount - q.amount);
    if (Math.abs(diff) <= TOL) continue;
    const base = { ref: r.vendor_invoice, vim: r.vim_invoice, po: r.po_number || q.po || "", qbAmount: q.amount, signetAmount: r.amount, diff, date: r.posting_date, due: r.net_due_date, payNo: r.sap_payment_no || null, payDate: r.payment_date || null };
    if (r.status === "PAID" && diff < 0) issues.push({ key: issueKey("paid_short", r.vendor_invoice), type: "paid_short", ...base });
    else issues.push({ key: issueKey("amount_diff", r.vendor_invoice), type: "amount_diff", paid: r.status === "PAID", direction: diff < 0 ? "less" : "more", ...base });
  }
  for (const m of buildMissingFromSignet({ qb, signet, today, linked })) {
    if (m.days < MISSING_YELLOW) continue;
    issues.push({ key: issueKey("missing", m.num), type: "missing", ref: m.num, po: m.po, qbAmount: m.amount, date: m.date, days: m.days, level: m.level });
  }
  return issues;
}

/** Split issues by their saved status (open / disputed / done). */
export function splitIssues(issues, notes) {
  const st = (i) => notes?.[i.key]?.issue_status || "open";
  return { open: issues.filter((i) => st(i) === "open"), disputed: issues.filter((i) => st(i) === "disputed"), done: issues.filter((i) => st(i) === "done") };
}

/** Map of Signet vendor_invoice → QB invoice number from saved Mark matched links. */
export function linkedRefsFrom(notes) {
  const m = new Map();
  for (const [k, v] of Object.entries(notes || {})) {
    const mm = k.match(/^issue:not_in_qb:(.+)$/);
    if (mm && clean(v?.linked_ref)) m.set(mm[1], clean(v.linked_ref));
  }
  return m;
}

/** Last-updated banner: max last_seen_at; red when > 3 days old. */
export function lastUpdated(rows, now = new Date()) {
  let max = null;
  for (const r of rows) if (r.last_seen_at && (!max || r.last_seen_at > max)) max = r.last_seen_at;
  if (!max) return { at: null, stale: true, days: null };
  const days = (now - new Date(max)) / 864e5;
  return { at: max, days, stale: days > 3 };
}
