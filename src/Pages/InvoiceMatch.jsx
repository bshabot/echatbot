import { useMemo } from "react";
import { Upload, RefreshCw } from "lucide-react";
import usePersistedState from "../Hooks/usePersistedState";
import useSignetAp, { QB_DAYS, localToday } from "../components/SignetAp/useSignetAp";
import PaymentsTab from "../components/SignetAp/PaymentsTab";
import ChargebacksTab from "../components/SignetAp/ChargebacksTab";
import IssuesTab from "../components/SignetAp/IssuesTab";
import UpcomingTab from "../components/SignetAp/UpcomingTab";
import CompareTab from "../components/SignetAp/CompareTab";
import { Stat, money } from "../components/SignetAp/ui";
import {
  addDays, buildInvoiceIssues, buildMissingFromSignet, buildUpcoming, derivePaymentRuns, expectedNextRuns, lastUpdated, linkedRefsFrom, splitIssues, MISSING_YELLOW,
} from "../utils/signetAp";

// Signet AP (route /invoice-match): what Signet paid, what they took, what's coming, what they don't have.
// Logic lives in utils/signetAp.js (pure, tested); data + writes in components/SignetAp/useSignetAp.js.
// Nothing here writes to QuickBooks: "Approve and post" / "Add to QB" are switched off in this build.
const TABS = ["payments", "chargebacks", "issues", "upcoming", "compare"];

export default function InvoiceMatch() {
  const sa = useSignetAp();
  const [tab, setTab] = usePersistedState("signetap.tab", "payments", (v) => TABS.includes(v));
  const today = localToday();
  const qbFrom = addDays(today, -QB_DAYS);
  const { rows, notes, qb } = sa;

  const runs = useMemo(() => {
    const st = new Map(sa.runs.map((r) => [r.sap_payment_no, r.status]));
    return derivePaymentRuns(rows).map((r) => ({ ...r, status: st.get(r.sap_payment_no) || "new" }));
  }, [rows, sa.runs]);
  const linked = useMemo(() => linkedRefsFrom(notes), [notes]);
  const issues = useMemo(() => buildInvoiceIssues({ signet: rows, qb: qb.invoices, today, qbFrom, linked }), [rows, qb.invoices, today, qbFrom, linked]);
  const openIssues = useMemo(() => splitIssues(issues, notes).open.length, [issues, notes]);
  const upcoming = useMemo(() => buildUpcoming(rows, { today }), [rows, today]);
  const next2 = useMemo(() => expectedNextRuns(upcoming, today, 2), [upcoming, today]);
  const missing = useMemo(() => (qb.invoices ? buildMissingFromSignet({ qb: qb.invoices, signet: rows, today, linked }) : null), [qb.invoices, rows, today, linked]);
  const missingOld = missing ? missing.filter((m) => m.days >= MISSING_YELLOW).length : null;
  const rowsByVim = useMemo(() => new Map(rows.map((r) => [r.vim_invoice, r])), [rows]);
  const upd = useMemo(() => lastUpdated(rows), [rows]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (f) sa.upload(f).finally(() => { e.target.value = ""; });
  };
  const tabs = [
    ["payments", "Payments"], ["chargebacks", "Chargebacks"], ["issues", `Invoice issues${openIssues ? ` (${openIssues})` : ""}`],
    ["upcoming", "Upcoming"], ["compare", "Compare"],
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Signet AP</h1>
        <label className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-gray-50 ${sa.busy ? "pointer-events-none opacity-50" : ""}`}>
          <Upload size={14} /> {sa.busy === "upload" ? "Saving…" : "Upload Signet export (.xlsx)"}
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} />
        </label>
        <button onClick={sa.fetchQb} disabled={qb.status === "loading"} className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50" title={`Pulls QuickBooks invoices from the last ${QB_DAYS} days (office network)`}>
          <RefreshCw size={14} className={qb.status === "loading" ? "animate-spin" : ""} /> QuickBooks
        </button>
        <span className={`text-xs ${qb.status === "ok" ? "text-emerald-700" : qb.status === "error" ? "text-red-600" : "text-gray-500"}`}>
          {qb.status === "ok" ? `QB: ${qb.invoices.length} invoices since ${qbFrom}` : qb.status === "error" ? "QB not reachable (needs the office network)" : qb.status === "off" ? "QB integration is off (Settings)" : qb.status === "loading" ? "Pulling QB…" : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat label="Expected in the next 2 runs" value={money(next2.total)} sub={next2.mondays.length ? next2.mondays.join(" and ") : "no approved invoices"} />
        <Stat label={`Invoices missing ${MISSING_YELLOW}+ days`} value={missingOld ?? "?"} sub={missing ? "billed, not in Signet" : "needs QuickBooks"} tone={missingOld ? "yellow" : undefined} />
        <Stat label="Signet data last updated" value={upd.at ? new Date(upd.at).toLocaleDateString() : "never"} sub={upd.stale && upd.at ? `${Math.floor(upd.days)} days old, upload a new export` : upd.at ? "from the uploaded export" : "upload the export"} tone={upd.stale ? "red" : undefined} />
      </div>

      <div className="flex gap-2 border-b pb-2">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded px-3 py-1 text-sm ${tab === id ? "bg-gray-900 text-white" : "border bg-white hover:bg-gray-50"}`}>{label}</button>
        ))}
      </div>

      {!sa.loaded && <div className="p-6 text-center text-gray-400">Loading…</div>}
      {sa.loaded && !rows.length && tab !== "compare" && <div className="rounded border bg-white p-6 text-center text-gray-500">No Signet data saved yet. Upload the Signet export (.xlsx) to start.</div>}
      {sa.loaded && (rows.length > 0 || tab === "compare") && (
        <>
          {tab === "payments" && <PaymentsTab rows={rows} runs={runs} deductions={sa.deductions} qb={qb} qbFrom={qbFrom} linked={linked} />}
          {tab === "chargebacks" && <ChargebacksTab deductions={sa.deductions} rowsByVim={rowsByVim} onDispute={sa.disputeDeductions} onNote={sa.saveDeductionNote} />}
          {tab === "issues" && <IssuesTab issues={issues} notes={notes} qb={qb} onSave={sa.saveNoteRow} />}
          {tab === "upcoming" && <UpcomingTab upcoming={upcoming} missing={missing} qb={qb} today={today} />}
          {tab === "compare" && <CompareTab savedRows={rows} notes={notes} saveNote={sa.saveNoteRow} setNoteStatus={sa.setNoteStatus} />}
        </>
      )}
    </div>
  );
}
