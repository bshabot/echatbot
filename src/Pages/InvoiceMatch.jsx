import { useMemo, useState } from "react";
import usePersistedState from "../Hooks/usePersistedState";
import useSignetAp, { QB_DAYS, localToday } from "../components/SignetAp/useSignetAp";
import PaymentsTab from "../components/SignetAp/PaymentsTab";
import ChargebacksTab from "../components/SignetAp/ChargebacksTab";
import IssuesTab, { issueRowCounts } from "../components/SignetAp/IssuesTab";
import CompareTab from "../components/SignetAp/CompareTab";
import { qbWindowStart, buildInvoiceIssues, buildMissingFromSignet, buildUpcoming, derivePaymentRuns, lastUpdated, linkedRefsFrom } from "../utils/signetAp";
import { groupByPoType, updatedText } from "../utils/signetApView";

// Signet Invoice Match (route /invoice-match): Payments | Chargebacks | Invoice issues, laid out to Brian's mockups.
// Logic: utils/signetAp.js + utils/signetApView.js (pure, tested). Data + writes: components/SignetAp/useSignetAp.js.
// Nothing here writes to QuickBooks: "Post to QB" / "Add to QB" are switched off in this build.
// The old comparison report is still available behind the "Compare report" link.
const TABS = ["payments", "chargebacks", "issues"];

export default function InvoiceMatch() {
  const sa = useSignetAp();
  const [tab, setTab] = usePersistedState("signetap.tab", "payments", (v) => TABS.includes(v));
  const [compare, setCompare] = useState(false);
  const today = localToday();
  const qbFrom = qbWindowStart(today, QB_DAYS);
  const { rows, notes, qb } = sa;

  const runs = useMemo(() => {
    const st = new Map(sa.runs.map((r) => [r.sap_payment_no, r]));
    return derivePaymentRuns(rows).map((r) => ({ ...r, status: st.get(r.sap_payment_no)?.status || "new", approved_by: st.get(r.sap_payment_no)?.approved_by, approved_at: st.get(r.sap_payment_no)?.approved_at }));
  }, [rows, sa.runs]);
  const linked = useMemo(() => linkedRefsFrom(notes), [notes]);
  const issues = useMemo(() => buildInvoiceIssues({ signet: rows, qb: qb.invoices, today, qbFrom, linked }), [rows, qb.invoices, today, qbFrom, linked]);
  const openIssues = useMemo(() => issueRowCounts(issues, notes).open, [issues, notes]);
  const newGroups = useMemo(() => groupByPoType(sa.deductions.filter((d) => d.status === "new")).length, [sa.deductions]);
  const upcoming = useMemo(() => buildUpcoming(rows, { today }), [rows, today]);
  const missing = useMemo(() => (qb.invoices ? buildMissingFromSignet({ qb: qb.invoices, signet: rows, today, linked }) : null), [qb.invoices, rows, today, linked]);
  const rowsByVim = useMemo(() => new Map(rows.map((r) => [r.vim_invoice, r])), [rows]);
  const upd = useMemo(() => lastUpdated(rows), [rows]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (f) sa.upload(f).finally(() => { e.target.value = ""; });
  };
  const tabs = [["payments", "Payments"], ["chargebacks", `Chargebacks · ${newGroups}`], ["issues", `Invoice issues · ${openIssues}`]];
  const link = "min-h-[44px] px-2 text-[13px] text-[#4b5563] underline hover:text-[#111827] disabled:opacity-50";

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 bg-white px-14 py-10 font-sans text-[#111827]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[26px] font-semibold">Signet Invoice Match</h1>
        <div className="flex flex-wrap items-center gap-1">
          <span className={`mr-2 text-[13px] ${upd.stale ? "font-semibold text-red-600" : "text-[#4b5563]"}`}>Signet data updated {updatedText(upd.at)}</span>
          <label className={`flex cursor-pointer items-center ${link} ${sa.busy ? "pointer-events-none opacity-50" : ""}`}>
            {sa.busy === "upload" ? "Saving…" : "Upload export"}
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} />
          </label>
          <button onClick={sa.fetchQb} disabled={qb.status === "loading"} className={link} title={`Pulls QuickBooks invoices from the last ${QB_DAYS} days (office network)`}>
            {qb.status === "loading" ? "Pulling QB…" : qb.status === "ok" ? "Refresh QB" : qb.status === "error" ? "QB not reachable, retry" : qb.status === "off" ? "QB is off (Settings)" : "Load QB"}
          </button>
          <button onClick={() => setCompare(!compare)} className={link}>{compare ? "Back to Payments" : "Compare report"}</button>
        </div>
      </div>

      {compare ? (
        <CompareTab savedRows={rows} notes={notes} saveNote={sa.saveNoteRow} setNoteStatus={sa.setNoteStatus} />
      ) : (
        <>
          <div className="flex gap-7 border-b border-[#e5e7eb]">
            {tabs.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)} className={`-mb-px min-h-[44px] pb-3 text-[15px] ${tab === id ? "border-b-2 border-[#111827] font-semibold text-[#111827]" : "text-[#4b5563] hover:text-[#111827]"}`}>{label}</button>
            ))}
          </div>
          {!sa.loaded && <div className="p-6 text-center text-gray-400">Loading…</div>}
          {sa.loaded && !rows.length && <div className="rounded-lg border bg-white p-6 text-center text-gray-500">No Signet data saved yet. Use &quot;Upload export&quot; (top right) with the Signet .xlsx.</div>}
          {sa.loaded && rows.length > 0 && (
            <>
              {tab === "payments" && <PaymentsTab rows={rows} runs={runs} deductions={sa.deductions} qb={qb} qbFrom={qbFrom} linked={linked} upcoming={upcoming} missing={missing} today={today} />}
              {tab === "chargebacks" && <ChargebacksTab deductions={sa.deductions} rowsByVim={rowsByVim} onDispute={sa.disputeDeductions} onNote={sa.saveDeductionNote} />}
              {tab === "issues" && <IssuesTab issues={issues} notes={notes} qb={qb} onSave={sa.saveNoteRow} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
