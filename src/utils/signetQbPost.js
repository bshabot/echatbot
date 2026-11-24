// Signet chargeback -> QuickBooks payloads. PURE: no network, no Supabase, so it is unit-tested and the UI preview
// is exactly what the connector is asked to validate. Nothing here talks to QuickBooks.
//
// A chargeback becomes a QB CREDIT MEMO: CM# = the Signet chargeback number, PO # = the PO, one "Chargebacks" line.
// A repayment (Signet paid the RP line back) becomes a SALES ORDER with the same shape.
import { QB_SALES_ORDER_CUSTOMER } from "./qbClient.js";

export const QB_REF_MAX = 11; // QuickBooks RefNumber limit
export const QB_PO_MAX = 25; // QuickBooks PO # limit
export const QB_CHARGEBACK_ITEM = "Chargebacks";
export const TOO_LONG_MSG = `Number too long for QuickBooks (max ${QB_REF_MAX}). Enter a short number`;
export const NO_PO_NOTE = "No PO on this chargeback - the PO # on the QuickBooks document will be left empty.";

const clean = (v) => String(v ?? "").trim();
const cents = (n) => Math.round(Number(n) * 100) / 100;
export const qbAmount = (n) => cents(n).toFixed(2);
export const moneyText = (n) => `$${cents(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The QuickBooks document number for a Signet reference.
 * Fits in 11 chars -> used exactly as Signet writes it (CB01520871 stays CB01520871, no reformatting).
 * Too long -> blocked until the user types a short one; the suggestion is the reference with a trailing RP
 * removed if that fits, else its last 11 characters.
 */
export function qbNumberFor(reference) {
  const ref = clean(reference);
  if (ref.length <= QB_REF_MAX) return { ref, fits: !!ref, number: ref, suggestion: ref, message: ref ? "" : "No reference" };
  const noRp = ref.replace(/RP$/i, "");
  const suggestion = noRp.length <= QB_REF_MAX ? noRp : ref.slice(-QB_REF_MAX);
  return { ref, fits: false, number: "", suggestion, message: TOO_LONG_MSG };
}

/** Resolve the number actually used: the user's typed override wins, else the reference if it fits. */
function resolveNumber(reference, overrideNumber) {
  const base = qbNumberFor(reference);
  const typed = overrideNumber == null ? null : clean(overrideNumber);
  const number = typed != null && typed !== "" ? typed : base.fits ? base.number : "";
  const errors = [];
  if (!number) errors.push(TOO_LONG_MSG);
  else if (number.length > QB_REF_MAX) errors.push(TOO_LONG_MSG);
  return { number, suggestion: base.suggestion, tooLong: !base.fits && base.ref.length > QB_REF_MAX, errors };
}

function poFields(po) {
  const p = clean(po);
  if (!p) return { po: "", errors: [], note: NO_PO_NOTE };
  if (p.length > QB_PO_MAX) return { po: p, errors: [`PO number too long for QuickBooks (max ${QB_PO_MAX})`], note: "" };
  return { po: p, errors: [], note: "" };
}

/**
 * Credit memo for one chargeback (never combined with another).
 * overrides: { number, txnDate, customer }
 * -> { ok, errors, number, suggestion, tooLong, payload, preview }
 */
export function buildCreditMemoPayload(deduction, memo, overrides = {}) {
  const d = deduction || {};
  const reference = clean(d.reference);
  const amount = cents(Math.abs(Number(d.amount)));
  const typed = clean(memo);
  const n = resolveNumber(reference, overrides.number);
  const po = poFields(d.po_number);
  const customer = overrides.customer || QB_SALES_ORDER_CUSTOMER;
  const errors = [...n.errors, ...po.errors];
  if (!reference) errors.push("This chargeback has no Signet reference");
  if (!typed) errors.push("Memo is required");
  if (!(amount > 0)) errors.push("Amount must be more than 0");
  if (overrides.txnDate && !/^\d{4}-\d{2}-\d{2}$/.test(overrides.txnDate)) errors.push("Date must be YYYY-MM-DD");

  const memoText = typed ? `${typed} | Signet ref ${reference}` : "";
  const payload = {
    customer,
    ref_number: n.number,
    ...(po.po ? { po_number: po.po } : {}),
    memo: memoText,
    ...(overrides.txnDate ? { txn_date: overrides.txnDate } : {}),
    lines: [{ item: QB_CHARGEBACK_ITEM, amount: qbAmount(amount), description: `Signet ref ${reference}` }],
  };
  return {
    ok: errors.length === 0, errors, number: n.number, suggestion: n.suggestion, tooLong: n.tooLong, payload,
    preview: previewOf("Credit memo", { number: n.number, customer, po: po.po, noPo: po.note, item: QB_CHARGEBACK_ITEM, amount, memo: memoText }),
  };
}

/**
 * Sales order that adds a repaid chargeback back. rpLine = the saved RP row ({ vendor_invoice, amount, payment_date, status }).
 * overrides: { number, txnDate, customer }
 */
export function buildRepaymentSoPayload(deduction, rpLine, overrides = {}) {
  const d = deduction || {}, rp = rpLine || {};
  const original = clean(d.reference), rpRef = clean(rp.vendor_invoice);
  const amount = cents(Math.abs(Number(rp.amount)));
  const n = resolveNumber(rpRef, overrides.number);
  const po = poFields(d.po_number);
  const customer = overrides.customer || QB_SALES_ORDER_CUSTOMER;
  const errors = [...n.errors, ...po.errors];
  if (!rpRef) errors.push("No repayment line found for this chargeback");
  if (!(amount > 0)) errors.push("Repayment amount must be more than 0");
  if (rpRef && rp.status !== "PAID") errors.push("Signet has not paid this repayment yet (status " + (rp.status || "unknown") + ")");
  if (overrides.txnDate && !/^\d{4}-\d{2}-\d{2}$/.test(overrides.txnDate)) errors.push("Date must be YYYY-MM-DD");

  const memoText = `Repayment of ${original} (${rpRef})`;
  const payload = {
    customer,
    ref_number: n.number,
    ...(po.po ? { po_number: po.po } : {}),
    memo: memoText,
    ...(overrides.txnDate ? { txn_date: overrides.txnDate } : {}),
    lines: [{ item: QB_CHARGEBACK_ITEM, amount: qbAmount(amount), description: `Signet ref ${rpRef}` }],
  };
  return {
    ok: errors.length === 0, errors, number: n.number, suggestion: n.suggestion, tooLong: n.tooLong, payload,
    preview: previewOf("Sales order", { number: n.number, customer, po: po.po, noPo: po.note, item: QB_CHARGEBACK_ITEM, amount, memo: memoText }),
  };
}

function previewOf(kind, f) {
  const lines = [
    `${kind} ${f.number || "(number needed)"}`,
    `Customer: ${f.customer}`,
    `PO #: ${f.po || "(empty)"}`,
    `Item: ${f.item}`,
    `Amount: ${moneyText(f.amount)}`,
    `Memo: ${f.memo || "(required)"}`,
  ];
  if (f.noPo) lines.push(f.noPo);
  return { kind, number: f.number, customer: f.customer, po: f.po, item: f.item, amount: f.amount, memo: f.memo, text: lines.join("\n") };
}

// ── idempotency / duplicate guards ─────────────────────────────────────────

/** Local guard: a deduction already saved as posted can never be posted again. kind: "cm" | "so". */
export function alreadyPostedMessage(deduction, kind = "cm") {
  const d = deduction || {};
  if (kind === "cm" && (d.qb_txn_id || d.qb_cm_ref)) return `Already added to QuickBooks${d.qb_cm_ref ? ` as ${d.qb_cm_ref}` : ""}.`;
  if (kind === "so" && (d.qb_repayment_txn_id || d.qb_repayment_ref)) return `Repayment already added to QuickBooks${d.qb_repayment_ref ? ` as ${d.qb_repayment_ref}` : ""}.`;
  return "";
}

/**
 * Read the connector's duplicate answer. Accepts a dry-run result ({ duplicate_check:{checked,found,error?} })
 * or a plain "found it" record. -> { state: "clear"|"duplicate"|"unchecked", message }
 * "unchecked" (the lookup failed) is NOT clear: the UI must not offer the confirm button on it.
 */
export function duplicateState(check, label = "credit memo", number = "") {
  if (!check) return { state: "unchecked", message: "Duplicate check has not run." };
  if (check.error) return { state: "unchecked", message: `Couldn't check QuickBooks for an existing ${label}: ${check.error}` };
  const found = Array.isArray(check.found) ? check.found.length > 0 : Boolean(check.found);
  if (found) return { state: "duplicate", message: `QuickBooks already has ${label} ${number}. Not creating a second one.` };
  if (check.checked === false) return { state: "unchecked", message: "QuickBooks was not checked for duplicates." };
  return { state: "clear", message: `No ${label} ${number} in QuickBooks yet.` };
}

/** The key the connector dedupes on (matches its default `cm:{ref}` / `so:{ref}`), so retries can never double-post. */
export const idempotencyKeyFor = (kind, number) => `${kind === "so" ? "so" : "cm"}:${clean(number)}`;

/** Fields saved on the signet_deductions row after a real create. */
export function savedFieldsAfterCreate(kind, { number, txnId, who, at }) {
  if (kind === "so") return { qb_repayment_ref: number, qb_repayment_txn_id: txnId };
  return { qb_cm_ref: number, qb_txn_id: txnId, qb_posted_by: who || null, qb_posted_at: at, status: "done", done_reason: "added_to_qb" };
}

/** Pull the QuickBooks txn id out of a create response (connector returns txn_id). */
export function txnIdOf(created) {
  return clean(created?.txn_id || created?.TxnID || created?.id) || "";
}

/** Repayment can be added once: Signet PAID the RP line, the chargeback is in QB as a credit memo, no repayment posted yet. */
export function repaymentEligibility(deduction, rpLine) {
  const d = deduction || {};
  if (alreadyPostedMessage(d, "so")) return { ok: false, reason: alreadyPostedMessage(d, "so") };
  if (!d.qb_txn_id && !d.qb_cm_ref) return { ok: false, reason: "Add the chargeback to QuickBooks first." };
  if (!rpLine) return { ok: false, reason: "No repayment line saved for this chargeback." };
  if (rpLine.status !== "PAID") return { ok: false, reason: "Signet has not paid the repayment yet." };
  return { ok: true, reason: "" };
}
