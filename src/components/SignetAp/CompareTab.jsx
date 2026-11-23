import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { RefreshCw, Download } from "lucide-react";
import { useGenericStore } from "../../store/VendorStore";
import usePersistedState from "../../Hooks/usePersistedState";
import { useAlert } from "../Alerts/AlertContext";
import { fetchQbArTxns, isQbEnabled } from "../../utils/qbClient";
import { runMatch } from "../../utils/signetQbMatch";

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
  ready: "bg-green-100 text-green-800 border-green-400",
  "fee-not-in-qb": "bg-blue-50 text-blue-600 border-blue-200",
};

export default function CompareTab({ savedRows, notes, saveNote, setNoteStatus }) {
  const { showAlert } = useAlert();
  const err = (m) => showAlert(m, { variant: "error" });
  const settings = useGenericStore((s) => s.getEntity("settings"));
  const signetRows = useMemo(() => savedRows.map((r) => ({
    "Vendor Invoice#": r.vendor_invoice, Type: r.type, "Invoice Status": r.status ?? "", "PO Number": r.po_number ?? "",
    "Amount Due": Number(r.amount), "Posting Date": r.posting_date ?? "", "Payment Date": r.payment_date ?? "",
  })), [savedRows]);
  const [from, setFrom] = usePersistedState("invmatch.from", () => iso(new Date(Date.now() - 90 * 864e5)));
  const [to, setTo] = usePersistedState("invmatch.to", () => iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [tab, setTab] = usePersistedState("invmatch.tab", "invoices");
  const [filters, setFilters] = usePersistedState("invmatch.filters", [], Array.isArray); // chips switched on; none = show all
  const didAuto = useRef(false);

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

  const chips = tab === "invoices"
    ? ["equal", "under", "over", "pending", "no-signet-match", "not-in-qb", "ready"]
    : ["equal", "under", "over", "pending", "no-signet-match", "not-in-qb", "fee-not-in-qb", "ready"];
  const [sel, setSel] = useState(() => new Set()); // selected note_keys (this visit only)
  const setStatus = async (keys, status) => { if (await setNoteStatus(keys, status)) setSel(new Set()); };
  const toggle = (k) => setFilters((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
  const resetView = () => { setFilters([]); setTab("invoices"); setFrom(iso(new Date(Date.now() - 90 * 864e5))); setTo(iso(new Date())); };
  const noteKey = (r) => `${tab === "invoices" ? "invoice" : "chargeback"}:${r.qb?.num || r.signet?.num}`;
  const rows = useMemo(() => {
    if (!result) return [];
    const all = tab === "invoices"
      ? [...result.invoices, ...result.invoiceSignetOnly.map((s) => ({ section: "invoice", result: "not-in-qb", qb: null, signet: s }))]
      : [...result.chargebacks, ...result.chargebackSignetOnly];
    const on = filters.filter((k) => chips.includes(k));
    const key = (r) => `${tab === "invoices" ? "invoice" : "chargeback"}:${r.qb?.num || r.signet?.num}`;
    return on.length ? all.filter((r) => on.includes(r.result) || (on.includes("ready") && notes[key(r)]?.status === "ready")) : all;
  }, [result, tab, filters, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportXlsx = () => {
    const flat = (x) => ({
      Result: x.result, "QB Num": x.qb?.num ?? "", "QB Date": x.qb?.date ?? "", "QB Amount": x.qb?.amount ?? "",
      "Signet #": x.signet?.num ?? "", "Signet Amount": x.signet?.amount ?? "", "Diff (Signet-QB)": x.diff ?? "",
      "Signet Status": x.signet?.status ?? "", "Signet Posted": fmtD(x.signet?.postingDate), "Signet Paid": fmtD(x.signet?.paymentDate), "Lag days": x.lagDays ?? "", PO: x.qb?.po || x.signet?.po || "", "QB Memo": x.qb?.memo ?? "", Via: x.via ?? "", Ready: notes[`${x.section}:${x.qb?.num || x.signet?.num}`]?.status ?? "", Note: notes[`${x.section}:${x.qb?.num || x.signet?.num}`]?.note ?? "",
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...result.invoices, ...result.invoiceSignetOnly.map((s) => ({ section: "invoice", result: "not-in-qb", signet: s }))].map(flat)), "Invoices");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...result.chargebacks, ...result.chargebackSignetOnly].map(flat)), "Chargebacks");
    XLSX.writeFile(wb, `signet-qb-match_${to}.xlsx`);
  };

  const count = (k) => k === "ready" ? Object.entries(notes).filter(([nk, v]) => nk.startsWith(tab === "invoices" ? "invoice:" : "chargeback:") && v.status === "ready").length : (result ? (tab === "invoices" ? [...result.invoices, ...result.invoiceSignetOnly.map(() => ({ result: "not-in-qb" }))] : [...result.chargebacks, ...result.chargebackSignetOnly]).filter((r) => r.result === k).length : 0);

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded border bg-white p-3">
        <label className="text-xs text-gray-500">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded border px-1 py-1 text-sm text-gray-900" /></label>
        <label className="text-xs text-gray-500">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded border px-1 py-1 text-sm text-gray-900" /></label>
        <button disabled={!signetRows.length || busy} onClick={run} className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> {busy ? "Pulling QB…" : "Match"}
        </button>
        {result && <button onClick={exportXlsx} className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm hover:bg-gray-50"><Download size={14} /> Export</button>}
        <span className="text-xs text-gray-500">QB pull needs the office network. Customer: Zales. Within 5¢ = equal. Matching ignores dates; QB is pulled 30 days earlier since Signet posts later. Pending = QB invoice under 21 days old, not in Signet yet.</span>
      </div>

      {result && (
        <>
          <div className="flex gap-2">
            {["invoices", "chargebacks"].map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded px-3 py-1 text-sm capitalize ${tab === t ? "bg-gray-900 text-white" : "border"}`}>{t}</button>
            ))}
            <span className="mx-2 border-l" />
            {chips.map((k) => (
              <button key={k} onClick={() => toggle(k)} aria-pressed={filters.includes(k)} className={`rounded border px-2 py-1 text-xs ${filters.includes(k) ? `${CHIP[k]} ring-2 ring-gray-500 font-semibold` : "bg-white text-gray-400 border-gray-200"}`}>{filters.includes(k) ? "● " : "○ "}{k} · {count(k)}</button>
            ))}
            <button onClick={resetView} className="ml-auto rounded border px-2 py-1 text-xs hover:bg-gray-50" title="Clear filters, back to Invoices, last 90 days">Reset view</button>
          </div>
          {sel.size > 0 && (
            <div className="flex items-center gap-2 rounded border border-green-300 bg-green-50 px-3 py-1.5 text-sm">
              <span className="font-medium">{sel.size} selected</span>
              <button onClick={() => setStatus([...sel], "ready")} className="rounded bg-green-600 px-3 py-1 text-xs text-white">Mark ready</button>
              <button onClick={() => setStatus([...sel], "")} className="rounded border px-3 py-1 text-xs hover:bg-white">Clear status</button>
              <button onClick={() => setSel(new Set())} className="ml-auto text-xs text-gray-500 underline">Deselect</button>
            </div>
          )}
          <div className="max-h-[70vh] overflow-auto rounded border bg-white">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_0_#e5e7eb] text-left text-xs uppercase text-gray-500">
                <tr>{[<input key="all" type="checkbox" title="Select all shown" checked={rows.length > 0 && rows.every((r) => sel.has(noteKey(r)))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map(noteKey)) : new Set())} />, "Result", "Status", "QB #", "QB date", "QB amount", "Signet #", "Signet amount", "Diff", "Signet status", "Signet posted", "Signet paid", "Lag", "PO", "QB memo", "Memo (edit)"].map((h) => <th key={h} className="px-2 py-1">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1"><input type="checkbox" checked={sel.has(noteKey(r))} onChange={() => setSel((s) => { const n = new Set(s); n.has(noteKey(r)) ? n.delete(noteKey(r)) : n.add(noteKey(r)); return n; })} /></td>
                    <td className="px-2 py-1"><span className={`rounded border px-1.5 py-0.5 text-xs ${CHIP[r.result]}`}>{r.result}{r.via === "memo" ? " (memo)" : ""}</span></td>
                    <td className="px-2 py-1">{notes[noteKey(r)]?.status === "ready" && <span className={`rounded border px-1.5 py-0.5 text-xs ${CHIP.ready}`}>ready</span>}</td>
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
                    <td className="px-2 py-1"><textarea key={noteKey(r) + (notes[noteKey(r)]?.note ?? "")} defaultValue={notes[noteKey(r)]?.note ?? ""} rows={1} placeholder="Edit memo…" onBlur={(e) => e.target.value !== (notes[noteKey(r)]?.note ?? "") && saveNote(noteKey(r), { note: e.target.value })} className="w-72 rounded border px-1 py-0.5 text-xs" /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={16} className="p-4 text-center text-gray-400">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
