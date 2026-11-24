// Data + actions for the Signet AP page: loads the saved tables, pulls QB, handles the upload,
// and holds every Supabase write (deduction memo/dispute, issue memo/status, Compare notes).
import { useCallback, useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useSupabase } from "../SupaBaseProvider";
import { useAlert } from "../Alerts/AlertContext";
import { useGenericStore } from "../../store/VendorStore";
import { fetchQbArTxns, findCreditMemo, findSalesOrder, isQbEnabled, isUnknownOutcome, postSignetDocument } from "../../utils/qbClient";
import { idempotencyKeyFor, savedFieldsAfterCreate, txnIdOf } from "../../utils/signetQbPost";
import {
  parseSignetExport, diffSignetRows, derivePaymentRuns, deriveDeductions, planDeductionWrites, planRunWrites, qbInvoicesFrom, qbWindowStart, splitByDataStart, DATA_START, applyDataStart,
} from "../../utils/signetAp";

export const QB_DAYS = 150; // how far back the QB pull reaches (Signet lines older than this aren't compared)
export const localToday = () => new Date().toLocaleDateString("en-CA");

const PAGE = 1000;
async function fetchAll(supabase, table, order) {
  const all = [];
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase.from(table).select("*").order(order).range(off, off + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}
const num = (v) => (v == null ? v : Number(v));
const normRow = (r) => ({ ...r, amount: num(r.amount), disc1_pct: num(r.disc1_pct), disc2_pct: num(r.disc2_pct) });
const normDed = (r) => ({ ...r, amount: num(r.amount) });
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export default function useSignetAp() {
  const { supabase, session } = useSupabase();
  const { showAlert } = useAlert();
  const settings = useGenericStore((s) => s.getEntity("settings"));
  const err = useCallback((m) => showAlert(m, { variant: "error" }), [showAlert]);
  const who = session?.user?.email ?? null;
  const [data, setData] = useState({ rows: [], runs: [], deductions: [], notes: {}, loaded: false });
  const [qb, setQb] = useState({ status: "idle", invoices: null, error: null });
  const [busy, setBusy] = useState("");
  const qbTried = useRef(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    try {
      const [rows, runs, deductions, notes] = await Promise.all([
        fetchAll(supabase, "signet_ap_rows", "vim_invoice"), fetchAll(supabase, "signet_payment_runs", "sap_payment_no"),
        fetchAll(supabase, "signet_deductions", "vim_invoice"), fetchAll(supabase, "invoice_match_notes", "note_key"),
      ]);
      const f = applyDataStart(rows.map(normRow), deductions.map(normDed)); // nothing before DATA_START, even if old rows are in the DB
      setData({
        rows: f.rows, runs, deductions: f.deductions, loaded: true,
        notes: Object.fromEntries(notes.map((n) => [n.note_key, { note: n.note ?? "", status: n.status ?? "", linked_ref: n.linked_ref ?? "", issue_status: n.issue_status ?? "" }])),
      });
    } catch (e) {
      err(`Couldn't load Signet data (have the migrations been run?): ${e.message}`);
      setData((d) => ({ ...d, loaded: true }));
    }
  }, [supabase, err]);
  useEffect(() => { load(); }, [load]);

  const fetchQb = useCallback(async () => {
    if (!isQbEnabled(settings)) return setQb({ status: "off", invoices: null, error: null });
    setQb((q) => ({ ...q, status: "loading", error: null }));
    try {
      const today = localToday();
      const res = await fetchQbArTxns({ settings, dateFrom: qbWindowStart(today, QB_DAYS), dateTo: today });
      setQb({ status: "ok", invoices: qbInvoicesFrom(res.rows), error: null });
    } catch (e) {
      setQb({ status: "error", invoices: null, error: e.message });
      err(`QuickBooks: ${e.message} (needs the office network). Signet-only parts still work.`);
    }
  }, [settings, err]);
  useEffect(() => { // pull QB once, automatically, when the saved data is in and QB is on
    if (data.loaded && settings && !qbTried.current) { qbTried.current = true; fetchQb(); }
  }, [data.loaded, settings, fetchQb]);

  // ── upload: parse → diff/upsert rows → write changes → derive runs + deductions (never clobber user fields) ──
  const upload = async (file) => {
    setBusy("upload");
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: "" });
      if (!raw.length || !("Vim Invoice#" in raw[0])) throw new Error("This doesn't look like the Signet export (no Vim Invoice# column).");
      const parsed = parseSignetExport(raw);
      const { kept, skipped: tooOld } = splitByDataStart(parsed.rows);
      if (!kept.length) throw new Error(`No lines on or after the data start date (${DATA_START}).`);
      const now = new Date().toISOString();
      const existing = (await fetchAll(supabase, "signet_ap_rows", "vim_invoice")).map(normRow);
      const d = diffSignetRows(kept, existing, now);
      const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); };
      for (const c of chunks(d.inserts, 500)) must(await supabase.from("signet_ap_rows").upsert(c), "Saving new Signet lines");
      for (const c of chunks(d.updates, 500)) must(await supabase.from("signet_ap_rows").upsert(c), "Saving changed Signet lines");
      for (const c of chunks(d.touched, 300)) must(await supabase.from("signet_ap_rows").update({ last_seen_at: now }).in("vim_invoice", c), "Marking lines seen");
      for (const c of chunks(d.changes, 500)) must(await supabase.from("signet_ap_changes").insert(c), "Saving change history");

      const fresh = applyDataStart((await fetchAll(supabase, "signet_ap_rows", "vim_invoice")).map(normRow)).rows;
      const [exRuns, exDed, noteRows] = await Promise.all([
        fetchAll(supabase, "signet_payment_runs", "sap_payment_no"), fetchAll(supabase, "signet_deductions", "vim_invoice"), fetchAll(supabase, "invoice_match_notes", "note_key"),
      ]);
      const runPlan = planRunWrites(derivePaymentRuns(fresh), exRuns);
      for (const c of chunks(runPlan.upserts, 500)) must(await supabase.from("signet_payment_runs").upsert(c), "Saving payment runs");
      const plan = planDeductionWrites(deriveDeductions(fresh), exDed.map(normDed), { notes: Object.fromEntries(noteRows.map((n) => [n.note_key, n])), now });
      for (const c of chunks(plan.inserts, 500)) must(await supabase.from("signet_deductions").insert(c), "Saving new chargebacks");
      for (const c of chunks(plan.updates, 500)) must(await supabase.from("signet_deductions").upsert(c), "Updating chargebacks");
      for (const c of chunks(plan.repaid, 500)) must(await supabase.from("signet_deductions").upsert(c), "Moving repaid chargebacks to Done");
      for (const c of chunks(plan.logs, 500)) must(await supabase.from("signet_deduction_log").insert(c), "Saving log");
      await load();
      showAlert(`Signet export: ${d.inserts.length} new, ${d.updates.length} changed, ${d.touched.length} unchanged lines${parsed.skipped ? `, ${parsed.skipped} skipped (no Vim Invoice#)` : ""}${tooOld.length ? `, ${tooOld.length} skipped (before ${DATA_START})` : ""}. ${plan.inserts.length} new chargebacks.`);
    } catch (e) {
      err(`Upload failed: ${e.message}`);
    } finally {
      setBusy("");
    }
  };

  // ── chargebacks (signet_deductions): memo + dispute, applied to every row in a PO group; each click is logged ──
  const patchDeductions = async (items, patch, logOf) => {
    const vims = items.map((x) => x.vim_invoice), at = new Date().toISOString();
    setData((s) => ({ ...s, deductions: s.deductions.map((x) => (vims.includes(x.vim_invoice) ? { ...x, ...patch } : x)) }));
    for (const c of chunks(vims, 200)) {
      const { error } = await supabase.from("signet_deductions").update({ ...patch, updated_at: at }).in("vim_invoice", c);
      if (error) { err(`Couldn't save: ${error.message}`); return load(); }
    }
    const logs = items.map((x) => ({ vim_invoice: x.vim_invoice, who, at, ...logOf(x) }));
    for (const c of chunks(logs, 500)) {
      const { error } = await supabase.from("signet_deduction_log").insert(c);
      if (error) err(`Saved, but couldn't write the log: ${error.message}`);
    }
  };
  const disputeDeductions = (items) => patchDeductions(items, { status: "disputed", done_reason: null }, (x) => ({ from_value: x.status, to_value: "disputed" }));
  const saveDeductionNote = (items, note) => patchDeductions(items, { note: note || null }, (x) => ({ from_value: `note: ${(x.note || "").slice(0, 300)}`, to_value: `note: ${note.slice(0, 300)}` }));

  // ── QuickBooks: credit memo per chargeback / sales order per repayment. DRY RUN unless the confirm click calls createInQb. ──
  const qbEnabled = isQbEnabled(settings);
  const previewQb = useCallback((kind, payload) => postSignetDocument(kind, payload, { settings, dryRun: true }), [settings]);
  const createInQb = async (kind, d, payload) => {
    const number = payload.ref_number, label = kind === "so" ? "sales order" : "credit memo";
    try {
      // Re-check right before writing: QuickBooks is the source of truth for "does this number exist".
      const existing = kind === "so" ? await findSalesOrder(number) : await findCreditMemo(number);
      if (existing) return { ok: false, message: `QuickBooks already has ${label} ${number}. Nothing was created.` };
      const created = await postSignetDocument(kind, payload, { settings, dryRun: false, idempotencyKey: idempotencyKeyFor(kind, number) });
      if (created?.skipped) return { ok: false, message: "The QuickBooks integration is off in Settings." };
      const txnId = txnIdOf(created), at = new Date().toISOString();
      const fields = savedFieldsAfterCreate(kind, { number, txnId: txnId || null, who, at });
      setData((s) => ({ ...s, deductions: s.deductions.map((x) => (x.vim_invoice === d.vim_invoice ? { ...x, ...fields } : x)) }));
      let saveError = "";
      const up = await supabase.from("signet_deductions").update({ ...fields, updated_at: at }).eq("vim_invoice", d.vim_invoice);
      if (up.error) saveError = up.error.message;
      const lg = await supabase.from("signet_deduction_log").insert({
        vim_invoice: d.vim_invoice, who, at, from_value: kind === "so" ? "repayment" : d.status,
        to_value: kind === "so" ? `repayment added to QB as sales order ${number}` : `done (added to QB as credit memo ${number})`,
      });
      if (lg.error && !saveError) saveError = `log: ${lg.error.message}`;
      return { ok: true, number, txnId, saveError };
    } catch (e) {
      if (isUnknownOutcome(e)) return { ok: false, unknown: true, message: `QuickBooks did not answer in time. ${label} ${number} may or may not have been created. Check QuickBooks for ${number} before trying again.` };
      return { ok: false, message: e.message };
    }
  };

  // ── invoice issues + Compare notes (invoice_match_notes) ──
  const saveNoteRow = async (key, patch) => {
    const cur = { note: "", status: "", linked_ref: "", issue_status: "", ...data.notes[key], ...patch };
    setData((s) => ({ ...s, notes: { ...s.notes, [key]: cur } }));
    const { error } = await supabase.from("invoice_match_notes").upsert({
      note_key: key, note: cur.note, status: cur.status || null, linked_ref: cur.linked_ref || null, issue_status: cur.issue_status || null,
      updated_by: who, updated_at: new Date().toISOString(),
    });
    if (error) err(`Couldn't save: ${error.message}`);
  };
  const setNoteStatus = async (keys, status) => {
    const at = new Date().toISOString();
    setData((s) => { const n = { ...s.notes }; keys.forEach((k) => { n[k] = { note: "", ...n[k], status }; }); return { ...s, notes: n }; });
    const recs = keys.map((k) => ({ note_key: k, note: data.notes[k]?.note ?? "", status: status || null, updated_by: who, updated_at: at }));
    const { error } = await supabase.from("invoice_match_notes").upsert(recs);
    if (error) err(`Couldn't save status: ${error.message}`);
    return !error;
  };

  return { ...data, qb, fetchQb, busy, upload, reload: load, disputeDeductions, saveDeductionNote, saveNoteRow, setNoteStatus, who, qbEnabled, previewQb, createInQb };
}
