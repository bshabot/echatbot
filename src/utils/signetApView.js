// src/utils/signetApView.js
// Pure display helpers for the Signet AP page: date/money formatting, the plain-English run summary,
// the "Coming up" lines, and row grouping (chargebacks by PO + type, issues by payment run).
// No React, no I/O (unit-tested in test/signetApView.test.mjs).

import { r2, sum, daysBetween } from "./signetAp.js";

export const fmtMoney = (n) => (n === "" || n == null ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const mdParts = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? [Number(iso.slice(5, 7)), Number(iso.slice(8, 10)), iso.slice(2, 4)] : null);
/** "2026-11-16" → "11/16" (mm/dd). */
export const fmtMd = (iso) => { const p = mdParts(iso); return p ? `${String(p[0]).padStart(2, "0")}/${String(p[1]).padStart(2, "0")}` : ""; };
/** "2026-12-11" → "12/11/26". */
export const fmtMdy = (iso) => { const p = mdParts(iso); return p ? `${p[0]}/${p[1]}/${p[2]}` : ""; };
/** "2026-12-07" → "Mon 12/7". */
export const fmtDowMd = (iso) => {
  const p = mdParts(iso);
  if (!p) return "";
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]} ${p[0]}/${p[1]}`;
};

/** "Signet data updated today, 9:02 AM" tail. at: ISO timestamp, now: Date. */
export function updatedText(at, now = new Date()) {
  if (!at) return "never";
  const d = new Date(at);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const when = diff === 0 ? "today" : diff === 1 ? "yesterday" : `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  return `${when}, ${time}`;
}

/** "ketty.smith@x.com" → "Ketty"; "Kevin Lee" → "Kevin". */
export function firstName(s) {
  const t = String(s || "").split("@")[0].split(/[\s._-]+/)[0];
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : "";
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Run-row sentence: "2 invoices, all match. 1 chargeback." / "31 invoices. 21 match, 10 paid short. 18 chargebacks." */
export function runSentence(view) {
  const inv = view.clean.length + view.short.length + view.over.length + view.noMatch.length + view.unchecked.length;
  const parts = [];
  if (!view.qbChecked) {
    parts.push(plural(inv, "invoice") + (view.dropship.lines.length ? `, ${view.dropship.lines.length} dropship` : ""));
  } else {
    const bad = [];
    if (view.short.length) bad.push(`${view.short.length} paid short`);
    if (view.over.length) bad.push(`${view.over.length} paid more`);
    if (view.noMatch.length) bad.push(`${view.noMatch.length} not in QB`);
    const drop = view.dropship.lines.length ? `, ${view.dropship.lines.length} dropship` : "";
    parts.push(bad.length ? `${plural(inv, "invoice")}. ${view.clean.length} match, ${bad.join(", ")}${drop}` : `${plural(inv, "invoice")}, all match${drop}`);
  }
  if (view.deductions.length) parts.push(plural(view.deductions.length, "chargeback"));
  return parts.join(". ") + ".";
}

const TYPE_WORD = { price_variance: "price-variance", late: "late-delivery", qc: "quality", zales_late: "Zales late-delivery", allowance: "allowance", unknown: "freight/other" };

/** The expanded run panel: label/amount rows, the total, and the "goes to ..." note. */
export function buildRunSummary(view) {
  const rows = [];
  const add = (label, amount) => rows.push({ label, amount });
  if (view.clean.length) add(`${plural(view.clean.length, "invoice")} paid in full`, view.cleanTotal);
  if (view.short.length) {
    const qb = sum(view.short, (x) => x.qb), got = sum(view.short, (x) => x.signet);
    add(`${plural(view.short.length, "invoice")} paid short (QuickBooks ${fmtMoney(qb)}, short ${fmtMoney(r2(qb - got))})`, got);
  }
  if (view.over.length) add(`${plural(view.over.length, "invoice")} paid more than QuickBooks`, sum(view.over, (x) => x.line.amount));
  if (view.noMatch.length) add(`${plural(view.noMatch.length, "invoice")} not in QuickBooks`, sum(view.noMatch, (l) => l.amount));
  if (view.unchecked.length) add(`${plural(view.unchecked.length, "invoice")} (not checked against QuickBooks)`, sum(view.unchecked, (l) => l.amount));
  if (view.dropship.lines.length) add(`${plural(view.dropship.lines.length, "dropship order")} (not checked against QuickBooks)`, view.dropship.total);
  // repayments are folded into the chargeback type they repay (net amount, signed)
  for (const t of view.byType || []) {
    const w = TYPE_WORD[t.type] || t.type;
    add(t.count ? `${plural(t.count, `${w} chargeback`)}${t.repaidCount ? " (net of repayments)" : ""}` : `Repaid earlier ${w} chargebacks`, t.net);
  }
  const un = view.unlinkedRepayments || [];
  if (un.length) add(un.length === 1 ? "Repayment, no matching chargeback" : `${un.length} repayments, no matching chargeback`, sum(un, (x) => x.line.amount));
  const shortTotal = view.short.length ? r2(sum(view.short, (x) => x.qb) - sum(view.short, (x) => x.signet)) : 0;
  const notes = [];
  if (shortTotal > 0) notes.push(`The ${fmtMoney(shortTotal)} short goes to Invoice issues.`);
  if (view.deductions.length) notes.push(`The ${view.deductions.length} ${view.deductions.length === 1 ? "chargeback goes" : "chargebacks go"} to Chargebacks.`);
  return { rows, total: view.header.net_paid, note: notes.join(" ") };
}

/** "Coming up" card: one line per expected run, plus pending chargebacks. */
export function comingUpLines(upcoming, { max = 4 } = {}) {
  const lines = [];
  if (upcoming.pastDue.count) lines.push({ label: `Past due · ${plural(upcoming.pastDue.count, "invoice")}`, amount: upcoming.pastDue.total, tone: "red" });
  for (const w of upcoming.weeks) {
    const rep = w.repayments.length ? ` + ${fmtMoney(w.repaymentTotal)} repaid` : "";
    lines.push({ label: `${fmtDowMd(w.monday)} · ${plural(w.invoices.length, "invoice")}${rep}`, amount: w.net });
  }
  const shown = lines.slice(0, max);
  const hidden = lines.length - shown.length;
  if (upcoming.anyRun.count) shown.push({ label: "Chargebacks not taken yet", amount: -upcoming.anyRun.total, tone: "muted" });
  return { lines: shown, hidden };
}

// ── grouping ───────────────────────────────────────────────────────────────
/** Chargebacks: one row per PO + type (25 late charges on one PO = one row). */
export function groupByPoType(items, getPo = (d) => d.po_number) {
  const m = new Map();
  for (const d of items) {
    const po = String(getPo(d) ?? "").trim();
    const k = `${po}|${d.type}`;
    if (!m.has(k)) m.set(k, { po, type: d.type, items: [] });
    m.get(k).items.push(d);
  }
  return [...m.values()].map((g) => ({ ...g, count: g.items.length, total: sum(g.items, (x) => x.amount) }))
    .sort((a, b) => b.total - a.total || a.po.localeCompare(b.po));
}

/** Chargebacks as one flat row per deduction (the "Line items" view), same row shape as groupByPoType. */
export function lineItemRows(items, dateOf = () => "") {
  return [...items]
    .sort((a, b) => (dateOf(b) || "").localeCompare(dateOf(a) || "") || b.amount - a.amount)
    .map((d) => ({ po: String(d.po_number ?? "").trim(), type: d.type, items: [d], count: 1, total: r2(d.amount) }));
}

/** "PO 164707 late · QC 141750 / 149920": the Disputed card subtitle. */
export function disputedSubtitle(items, max = 3) {
  const SHORT = { late: "late", qc: "QC", price_variance: "price variance", zales_late: "Zales late", allowance: "allowance", unknown: "other" };
  const by = new Map();
  for (const d of items) {
    if (!by.has(d.type)) by.set(d.type, new Set());
    by.get(d.type).add(d.po_number || "no PO");
  }
  const parts = [...by].map(([t, pos]) => (t === "late" ? `PO ${[...pos].join(" / ")} late` : t === "qc" ? `QC ${[...pos].join(" / ")}` : `${SHORT[t]} ${[...pos].join(" / ")}`));
  return parts.slice(0, max).join(" · ") + (parts.length > max ? ` · +${parts.length - max} more` : "") || "none";
}

const cmpRef = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b));
const ISSUE_ORDER = ["paid_short", "amount_diff", "past_due", "missing", "not_in_qb"];

/** Issue rows for display: paid-short and not-in-QB lines from the same payment run become one row. */
export function groupIssues(issues, { grouped = true } = {}) {
  const slots = [], groups = new Map();
  for (const i of issues) {
    if (!grouped || (i.type !== "paid_short" && i.type !== "not_in_qb")) { slots.push([i]); continue; }
    const k = `${i.type}|${i.payNo || "unpaid"}`;
    if (!groups.has(k)) { groups.set(k, []); slots.push(groups.get(k)); }
    groups.get(k).push(i);
  }
  const rows = slots.map((items) => {
    const refs = items.map((x) => x.ref).sort(cmpRef);
    const num = (f) => { const v = items.filter((x) => x[f] != null); return v.length ? sum(v, (x) => x[f]) : null; };
    const pos = [...new Set(items.map((x) => x.po).filter(Boolean))];
    const dues = items.map((x) => x.due).filter(Boolean).sort();
    return {
      id: items.length === 1 ? items[0].key : `${items[0].type}|${items[0].payNo || "unpaid"}`,
      type: items[0].type, items, count: items.length, refs,
      refText: refs.length <= 3 ? refs.join(", ") : `${refs[0]} to ${refs[refs.length - 1]}`,
      po: pos.length === 1 ? pos[0] : "", qbAmount: num("qbAmount"), signetAmount: num("signetAmount"), diff: num("diff"),
      payDate: items[0].payDate || null, due: dues[0] || null, days: Math.max(...items.map((x) => x.days ?? 0)),
      level: items.some((x) => x.level === "red") ? "red" : items.some((x) => x.level === "yellow") ? "yellow" : "ok",
      paid: items.every((x) => x.paid),
    };
  });
  return rows.sort((a, b) => ISSUE_ORDER.indexOf(a.type) - ISSUE_ORDER.indexOf(b.type) || b.days - a.days || Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
}

export { daysBetween };
