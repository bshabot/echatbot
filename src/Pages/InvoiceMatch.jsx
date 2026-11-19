import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Upload, RefreshCw, Download } from "lucide-react";
import { useGenericStore } from "../store/VendorStore";
import { useSupabase } from "../components/SupaBaseProvider";
import usePersistedState from "../Hooks/usePersistedState";
import { useAlert } from "../components/Alerts/AlertContext";
import { fetchQbArTxns, isQbEnabled } from "../utils/qbClient";
import { runMatch } from "../utils/signetQbMatch";

// Signet vs QuickBooks: upload Signet's AP payment export (xlsx), pull QB
// invoices + credit memos live (needs the office network, same as other QB
// buttons), and see invoices over/under/equal plus chargebacks. Matching is in
// utils/signetQbMatch.js (QB Num first, QB memo as fallback).

const iso = (d) => d.toISOString().slice(0, 10);
const fmtD = (d) => (d instanceof Date ? iso(d) : d || "");
const money = (n) => (n === "" || n == null ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const CHIP = {
  equal: "bg-emerald-100 text-emerald-700 border-emerald-300",
  under: "bg-red-100 text-red-700 border-red-300",
  over: "bg-amber-100 text-amber-700 border-amber-300",
  "no-signet-match": "bg-gray-100 text-gray-600 border-gray-300",
  pending: "bg-sky-100 text-sky-700 border-sky-300",
  "not-in-qb": "bg-blue-100 text-blue-700 border-blue-300",
  "fee-not-in-qb": "bg-blue-50 text-blue-600 border-blue-200",
};

export default function InvoiceMatch() {
  const { showAlert } = useAlert();
  const err = (m) => showAlert(m, { variant: "error" });
  const settings = useGenericStore((s) => s.getEntity("settings"));
  const { supabase, session } = useSupabase();
  const [signetRows, setSignetRows] = useState(null);
  const [saved, setSaved] = useState(""); // "N rows, latest posted YYYY-MM-DD"
  const [from, setFrom] = usePersistedState("invmatch.from", () => iso(new Date(Date.now() - 90 * 864e5)));
  const [to, setTo] = usePersistedState("invmatch.to", () => iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [tab, setTab] = usePersistedState("invmatch.tab", "invoices");
  const [filter, setFilter] = usePersistedState("invmatch.filter", "all");
  const [notes, setNotes] = useState({}); // note_key -> { note, resolved }
  const didAuto = useRef(false);

  // ── saved Signet export + notes (Supabase; see migration 20261119000000) ──
  const loadSaved = useCallback(async () => {
    if (!supabase) return;
    const all = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from("signet_ap_rows").select("*").order("vendor_invoice").range(off, off + 999);
      if (error) return err(`Saved Signet data: ${error.message}`);
      all.push(...data);
      if (data.length < 1000) break;
    }
    setSignetRows(all.map((r) => ({
      "Vendor Invoice#": r.vendor_invoice, Type: r.type, "Invoice Status": r.status ?? "", "PO Number": r.po_number ?? "",
      "Amount Due": Number(r.amount), "Posting Date": r.posting_date ?? "", "Payment Date": r.payment_date ?? "",
    })));
    const latest = all.reduce((m, r) => (r.posting_date > m ? r.posting_date : m), "");
    setSaved(all.length ? `${all.length} rows saved, latest posted ${latest}` : "");
    const { data: n } = await supabase.from("invoice_match_notes").select("*");
    setNotes(Object.fromEntries((n ?? []).map((x) => [x.note_key, { note: x.note, resolved: x.resolved }])));
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadSaved(); }, [loadSaved]);

  const saveNote = async (key, patch) => {
    const cur = { note: "", resolved: false, ...notes[key], ...patch };
    setNotes((n) => ({ ...n, [key]: cur }));
    const { error } = await supabase.from("invoice_match_notes").upsert({
      note_key: key, note: cur.note, resolved: cur.resolved,
      updated_by: session?.user?.email ?? null, updated_at: new Date().toISOString(),
    });
    if (error) err(`Couldn't save note: ${error.message}`);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: "" });
    const d = (v) => (v instanceof Date ? iso(v) : null);
    const recs = rows.filter((r) => r["Vendor Invoice#"] !== "").map((r) => ({
      vendor_invoice: String(r["Vendor Invoice#"]).trim(), type: String(r["Type"]).toUpperCase(), status: r["Invoice Status"] || null,
      po_number: r["PO Number"] === "" ? null : String(r["PO Number"]), amount: Number(r["Amount Due"]) || 0,
      posting_date: d(r["Posting Date"]), payment_date: d(r["Payment Date"]), uploaded_at: new Date().toISOString(),
    }));
    setBusy(true);
    for (let i = 0; i < recs.length; i += 500) {
      const { error } = await supabase.from("signet_ap_rows").upsert(recs.slice(i, i + 500));
      if (error) { setBusy(false); return err(`Couldn't save Signet export: ${error.message}`); }
    }
    await loadSaved();
    setBusy(false);
    setResult(null);
    e.target.value = "";
    showAlert(`Saved ${recs.length} Signet rows. Future visits load them automatically.`);
  };

  const run = async () => {
    if (!isQbEnabled(settings)) return err("QuickBooks integration is off (Settings).");
    setBusy(true);
    try {
      const qb = await fetchQbArTxns({ settings, dateFrom: iso(new Date(new Date(from) - 30 * 864e5)), dateTo: to });
      setResult(runMatch({ qbRows: qb.rows, signetRows, from }));
    } catch (e) {
      err(`QuickBooks: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { // first time Signet data loads: run it, no clicking
    if (signetRows?.length && !didAuto.current && isQbEnabled(settings)) { didAuto.current = true; run(); }
  }, [signetRows, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const noteKey = (r) => `${tab === "invoices" ? "invoice" : "chargeback"}:${r.qb?.num || r.signet?.num}`;
  const rows = useMemo(() => {
    if (!result) return [];
    const all = tab === "invoices"
      ? [...result.invoices, ...result.invoiceSignetOnly.map((s) => ({ section: "invoice", result: "not-in-qb", qb: null, signet: s }))]
      : [...result.chargebacks, ...result.chargebackSignetOnly];
    return filter === "all" ? all : all.filter((r) => r.result === filter);
  }, [result, tab, filter]);

  const exportXlsx = () => {
    const flat = (x) => ({
      Result: x.result, "QB Num": x.qb?.num ?? "", "QB Date": x.qb?.date ?? "", "QB Amount": x.qb?.amount ?? "",
      "Signet #": x.signet?.num ?? "", "Signet Amount": x.signet?.amount ?? "", "Diff (Signet-QB)": x.diff ?? "",
      Status: x.signet?.status ?? "", "Signet Posted": fmtD(x.signet?.postingDate), "Signet Paid": fmtD(x.signet?.paymentDate), "Lag days": x.lagDays ?? "", PO: x.qb?.po || x.signet?.po || "", "QB Memo": x.qb?.memo ?? "", Via: x.via ?? "", Resolved: notes[`${x.section}:${x.qb?.num || x.signet?.num}`]?.resolved ? "yes" : "", Note: notes[`${x.section}:${x.qb?.num || x.signet?.num}`]?.note ?? "",
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...result.invoices, ...result.invoiceSignetOnly.map((s) => ({ section: "invoice", result: "not-in-qb", signet: s }))].map(flat)), "Invoices");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...result.chargebacks, ...result.chargebackSignetOnly].map(flat)), "Chargebacks");
    XLSX.writeFile(wb, `signet-qb-match_${to}.xlsx`);
  };

  const sm = result?.summary?.[tab];
  const chips = tab === "invoices"
    ? ["equal", "under", "over", "pending", "no-signet-match", "not-in-qb"]
    : ["equal", "under", "over", "pending", "no-signet-match", "not-in-qb", "fee-not-in-qb"];
  const count = (k) => (result ? (tab === "invoices" ? [...result.invoices, ...result.invoiceSignetOnly.map(() => ({ result: "not-in-qb" }))] : [...result.chargebacks, ...result.chargebackSignetOnly]).filter((r) => r.result === k).length : 0);

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-semibold">Signet vs QuickBooks</h1>
      <div className="flex flex-wrap items-end gap-3 rounded border bg-white p-3">
        <label className="flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
          <Upload size={14} /> {saved ? "Update Signet export (.xlsx)" : "Signet export (.xlsx)"}
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} />
        </label>
        <label className="text-xs text-gray-500">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded border px-1 py-1 text-sm text-gray-900" /></label>
        <label className="text-xs text-gray-500">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded border px-1 py-1 text-sm text-gray-900" /></label>
        <button disabled={!signetRows || busy} onClick={run} className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> {busy ? "Pulling QB…" : "Match"}
        </button>
        {result && <button onClick={exportXlsx} className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm hover:bg-gray-50"><Download size={14} /> Export</button>}
        {saved && <span className="text-xs text-emerald-700">{saved}</span>}
        <span className="text-xs text-gray-500">QB pull needs the office network. Customer: Zales. Within 10¢ = equal. Matching ignores dates; QB is pulled 30 days earlier since Signet posts later. Pending = QB invoice under 21 days old, not in Signet yet.</span>
      </div>

      {result && (
        <>
          <div className="flex gap-2">
            {["invoices", "chargebacks"].map((t) => (
              <button key={t} onClick={() => { setTab(t); setFilter("all"); }} className={`rounded px-3 py-1 text-sm capitalize ${tab === t ? "bg-gray-900 text-white" : "border"}`}>{t}</button>
            ))}
            <span className="mx-2 border-l" />
            <button onClick={() => setFilter("all")} className={`rounded border px-2 py-1 text-xs ${filter === "all" ? "bg-gray-200" : ""}`}>all</button>
            {chips.map((k) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded border px-2 py-1 text-xs ${CHIP[k]} ${filter === k ? "ring-2 ring-gray-400" : ""}`}>{k} · {count(k)}</button>
            ))}
          </div>
          <div className="max-h-[70vh] overflow-auto rounded border bg-white">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_0_#e5e7eb] text-left text-xs uppercase text-gray-500">
                <tr>{["Result", "QB #", "QB date", "QB amount", "Signet #", "Signet amount", "Diff", "Status", "Signet posted", "Signet paid", "Lag", "PO", "QB memo", "Done", "Note"].map((h) => <th key={h} className="px-2 py-1">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1"><span className={`rounded border px-1.5 py-0.5 text-xs ${CHIP[r.result]}`}>{r.result}{r.via === "memo" ? " (memo)" : ""}</span></td>
                    <td className="px-2 py-1">{r.qb?.num}</td>
                    <td className="px-2 py-1">{r.qb?.date}</td>
                    <td className="px-2 py-1 text-right">{money(r.qb?.amount)}</td>
                    <td className="px-2 py-1">{r.signet?.num}</td>
                    <td className="px-2 py-1 text-right">{money(r.signet?.amount)}</td>
                    <td className="px-2 py-1 text-right">{r.diff ? money(r.diff) : ""}</td>
                    <td className="px-2 py-1">{r.signet?.status}</td>
                    <td className="px-2 py-1">{fmtD(r.signet?.postingDate)}</td>
                    <td className="px-2 py-1">{fmtD(r.signet?.paymentDate)}</td>
                    <td className="px-2 py-1 text-right">{r.lagDays != null ? `${r.lagDays}d` : ""}</td>
                    <td className="px-2 py-1">{r.qb?.po || r.signet?.po}</td>
                    <td className="px-2 py-1">{r.qb?.memo}{r.memoDisagrees ? " ⚠ memo≠Signet" : ""}</td>
                    <td className="px-2 py-1"><input type="checkbox" checked={!!notes[noteKey(r)]?.resolved} onChange={(e) => saveNote(noteKey(r), { resolved: e.target.checked })} title="Resolved" /></td>
                    <td className="px-2 py-1"><textarea key={noteKey(r) + (notes[noteKey(r)]?.note ?? "")} defaultValue={notes[noteKey(r)]?.note ?? ""} rows={1} placeholder="Add note…" onBlur={(e) => e.target.value !== (notes[noteKey(r)]?.note ?? "") && saveNote(noteKey(r), { note: e.target.value })} className="w-56 rounded border px-1 py-0.5 text-xs" /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={15} className="p-4 text-center text-gray-400">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
