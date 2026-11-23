import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import usePersistedState from "../../Hooks/usePersistedState";
import { buildRunView, appliedGap, DEDUCTION_LABEL } from "../../utils/signetAp";
import { runSentence, buildRunSummary, comingUpLines, fmtMd, firstName } from "../../utils/signetApView";
import { Chip, PostButton, cardCls, headCls, money, rowCls, TH, THEAD } from "./ui";
import { UpcomingDetail } from "./UpcomingTab";

function Section({ title, count, total, tone, defaultOpen = false, note, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{title}</span>
        <Chip tone={tone}>{count}</Chip>
        {total != null && <span className="text-gray-600">{money(total)}</span>}
        {note && <span className="ml-2 text-xs text-gray-500">{note}</span>}
      </button>
      {open && count > 0 && <div className="overflow-x-auto border-t px-3 py-2">{children}</div>}
    </div>
  );
}

const sortAmt = (a, b) => b.line.amount - a.line.amount;

function RunLines({ v, why }) {
  const chk = v.qbChecked ? appliedGap(v.header.net_paid, v.applied) : null;
  const L = (l) => (
    <>
      <td className={TH}>{l.vendor_invoice}</td><td className={TH}>{l.po_number}</td>
    </>
  );
  return (
    <div className="mt-3 space-y-2">
      <div className={`rounded border px-3 py-1.5 text-sm ${chk ? (chk.ok ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800") : "bg-white text-gray-600"}`}>
        {chk
          ? <>Applied total <b>{money(v.applied)}</b> vs net paid <b>{money(v.header.net_paid)}</b>: {chk.ok ? "equal to the cent." : <>gap <b>{money(chk.gap)}</b> (lines not applied: {v.noMatch.length} with no QB invoice).</>}</>
          : <>Not checked against QuickBooks. {why} Signet totals above are still correct.</>}
      </div>

      <Section title="Clean invoices" count={v.clean.length} total={v.cleanTotal} tone="green" note={v.qbChecked ? "Signet = QB within 5¢" : ""}>
        <table className="w-full text-sm"><tbody>
          {v.clean.sort(sortAmt).map((x) => <tr key={x.line.vim_invoice} className="border-t">{L(x.line)}<td className={`${TH} text-right`}>{money(x.line.amount)}</td></tr>)}
        </tbody></table>
      </Section>

      {!v.qbChecked && (
        <Section title="Invoices (Signet only)" count={v.unchecked.length} total={v.unchecked.reduce((a, l) => a + l.amount, 0)} tone="gray" note="not compared to QB">
          <table className="w-full text-sm"><tbody>
            {v.unchecked.map((l) => <tr key={l.vim_invoice} className="border-t">{L(l)}<td className={`${TH} text-right`}>{money(l.amount)}</td></tr>)}
          </tbody></table>
        </Section>
      )}

      <Section title="Short invoices" count={v.short.length} total={v.short.reduce((a, x) => a + x.diff, 0)} tone={v.short.length ? "red" : "gray"} defaultOpen note="Signet paid less than QB">
        <table className="w-full text-sm">
          <thead className={THEAD}><tr><th className={TH}>Invoice</th><th className={TH}>PO</th><th className={`${TH} text-right`}>QB</th><th className={`${TH} text-right`}>Signet</th><th className={`${TH} text-right`}>Short by</th></tr></thead>
          <tbody>{v.short.map((x) => <tr key={x.line.vim_invoice} className="border-t">{L(x.line)}<td className={`${TH} text-right`}>{money(x.qb)}</td><td className={`${TH} text-right`}>{money(x.signet)}</td><td className={`${TH} text-right text-red-700`}>{money(x.diff)}</td></tr>)}</tbody>
        </table>
      </Section>

      {v.over.length > 0 && (
        <Section title="Paid more than QB" count={v.over.length} total={v.over.reduce((a, x) => a + x.diff, 0)} tone="amber" defaultOpen>
          <table className="w-full text-sm"><tbody>
            {v.over.map((x) => <tr key={x.line.vim_invoice} className="border-t">{L(x.line)}<td className={`${TH} text-right`}>{money(x.qb)}</td><td className={`${TH} text-right`}>{money(x.signet)}</td><td className={`${TH} text-right text-amber-700`}>+{money(x.diff)}</td></tr>)}
          </tbody></table>
        </Section>
      )}

      <Section title="Deductions" count={v.deductions.length} total={v.header.deduction_total} tone={v.deductions.length ? "red" : "gray"} defaultOpen>
        <table className="w-full text-sm"><tbody>
          {v.deductions.map((d) => <tr key={d.line.vim_invoice} className="border-t"><td className={TH}><Chip>{DEDUCTION_LABEL[d.type]}</Chip></td>{L(d.line)}<td className={`${TH} text-right`}>{money(d.line.amount)}</td></tr>)}
        </tbody></table>
      </Section>

      <Section title="Repayments" count={v.repayments.length} total={v.repayments.reduce((a, x) => a + x.line.amount, 0)} tone="blue" defaultOpen>
        <table className="w-full text-sm"><tbody>
          {v.repayments.map((x) => (
            <tr key={x.line.vim_invoice} className="border-t">{L(x.line)}
              <td className={`${TH} text-gray-600`}>{x.deduction ? <>repays {x.deduction.reference}{x.deduction.po_number ? ` (PO ${x.deduction.po_number})` : ""}</> : <span className="text-amber-700">repays {x.base} (deduction not found)</span>}</td>
              <td className={`${TH} text-right`}>{money(x.line.amount)}</td></tr>
          ))}
        </tbody></table>
      </Section>

      <Section title="Dropship" count={v.dropship.lines.length} total={v.dropship.total} tone={v.dropship.mismatch.length ? "red" : "gray"} defaultOpen={v.dropship.mismatch.length > 0}
        note={v.dropship.mismatch.length ? `${v.dropship.mismatch.length} don't match QB` : "not checked against QB"}>
        <table className="w-full text-sm"><tbody>
          {(v.dropship.mismatch.length ? v.dropship.mismatch : v.dropship.lines.map((l) => ({ line: l }))).map((x) => (
            <tr key={x.line.vim_invoice} className="border-t">{L(x.line)}<td className={`${TH} text-right`}>{money(x.line.amount)}</td>{x.qb != null && <td className={`${TH} text-right text-red-700`}>QB {money(x.qb)}</td>}</tr>
          ))}
        </tbody></table>
      </Section>

      <Section title="No match" count={v.noMatch.length} total={v.noMatch.reduce((a, l) => a + l.amount, 0)} tone={v.noMatch.length ? "red" : "gray"} defaultOpen note="Signet lines with no QB invoice">
        <table className="w-full text-sm"><tbody>
          {v.noMatch.map((l) => <tr key={l.vim_invoice} className="border-t">{L(l)}<td className={`${TH} text-right`}>{money(l.amount)}</td></tr>)}
        </tbody></table>
      </Section>
    </div>
  );
}


const GRID = "grid grid-cols-[90px_130px_minmax(0,1fr)_150px_190px] gap-4";
const stop = (e) => e.stopPropagation();

function RunRow({ run, lines, deductions, qb, qbFrom, linked, open, onToggle }) {
  const [showLines, setShowLines] = useState(false);
  const covered = qb.status === "ok" && lines.every((l) => !l.posting_date || l.posting_date >= qbFrom);
  const why = qb.status === "ok" ? `The QuickBooks pull starts ${qbFrom}; this run has older invoices.`
    : qb.status === "off" ? "QuickBooks integration is off (Settings)." : qb.status === "loading" ? "Loading QuickBooks…"
      : qb.status === "error" ? `QuickBooks not reachable: ${qb.error}` : "QuickBooks not loaded.";
  const v = useMemo(() => {
    const byNum = covered ? new Map(qb.invoices.map((q) => [q.num, q])) : null;
    return buildRunView(lines, { qbByNum: byNum, deductions, lookup: (l) => (linked.has(l.vendor_invoice) ? byNum.get(linked.get(l.vendor_invoice)) : null) });
  }, [lines, deductions, qb.invoices, covered, linked]);
  const sum = open ? buildRunSummary(v) : null;
  const chk = open && v.qbChecked ? appliedGap(v.header.net_paid, v.applied) : null;
  return (
    <div className={rowCls}>
      <div onClick={onToggle} className={`${GRID} cursor-pointer items-center py-3 text-sm hover:bg-gray-50`}>
        <span>{fmtMd(run.payment_date)}</span>
        <span className="text-[#4b5563]">{run.sap_payment_no}</span>
        <span>{runSentence(v)}</span>
        <span className="text-right font-semibold tabular-nums">{money(run.net_paid)}</span>
        <span className="flex justify-end" onClick={stop}>
          {run.status === "posted"
            ? <span className="text-[13px] font-semibold text-[#166534]">Posted {fmtMd((run.approved_at || "").slice(0, 10))}{run.approved_by ? ` by ${firstName(run.approved_by)}` : ""}</span>
            : <PostButton className="px-[18px]">Post to QB</PostButton>}
        </span>
      </div>
      {open && (
        <div className="mb-3.5 ml-[106px] rounded-[10px] bg-[#f9fafb] px-[18px] py-3.5 text-sm">
          <div className="grid grid-cols-[1fr_140px] gap-y-2">
            {sum.rows.map((r) => <Fragment key={r.label}><span>{r.label}</span><span className="text-right tabular-nums">{money(r.amount)}</span></Fragment>)}
            <span className="border-t border-[#e5e7eb] pt-2 font-semibold">Goes to QuickBooks as one payment</span>
            <span className="border-t border-[#e5e7eb] pt-2 text-right font-semibold tabular-nums">{money(sum.total)}</span>
            {sum.note && <span className="col-span-full text-[13px] text-[#4b5563]">{sum.note}</span>}
            {!v.qbChecked && <span className="col-span-full text-[13px] text-[#4b5563]">Not checked against QuickBooks. {why}</span>}
            {chk && !chk.ok && <span className="col-span-full text-[13px] font-semibold text-[#9a3412]">Applied total is {money(chk.gap)} off the net paid ({v.noMatch.length} lines have no QuickBooks invoice).</span>}
          </div>
          <button onClick={() => setShowLines(!showLines)} className="mt-1 min-h-[44px] text-[13px] text-[#1d4ed8] underline">{showLines ? "Hide lines" : "Show lines"}</button>
          {showLines && <RunLines v={v} why={why} />}
        </div>
      )}
    </div>
  );
}

function ComingUp({ upcoming, today }) {
  const [by, setBy] = useState(false);
  const { lines, hidden } = comingUpLines(upcoming);
  return (
    <div className={`${cardCls} flex flex-col gap-2.5`}>
      <h2 className="text-[15px] font-semibold">Coming up</h2>
      <div className="grid grid-cols-[1fr_140px] gap-y-2 text-sm">
        {lines.map((l) => (
          <Fragment key={l.label}>
            <span className={l.tone === "muted" ? "text-[#4b5563]" : l.tone === "red" ? "font-semibold text-[#9a3412]" : ""}>{l.label}</span>
            <span className={`text-right tabular-nums ${l.tone === "muted" ? "text-[#4b5563]" : ""}`}>{money(l.amount)}</span>
          </Fragment>
        ))}
        {!lines.length && <span className="col-span-full text-[#4b5563]">No approved invoices waiting.</span>}
      </div>
      <div className="flex items-center gap-3 text-[13px] text-[#4b5563]">
        {hidden > 0 && <span>+{hidden} more weeks</span>}
        <button onClick={() => setBy(!by)} className="min-h-[44px] text-[#1d4ed8] underline">{by ? "Hide weeks" : "See by week"}</button>
      </div>
      {by && <UpcomingDetail upcoming={upcoming} today={today} />}
    </div>
  );
}

function Missing({ missing, qb }) {
  const [all, setAll] = useState(false);
  const list = missing ? (all ? missing : missing.slice(0, 8)) : [];
  return (
    <div className={`${cardCls} flex flex-col gap-2.5`}>
      <h2 className="text-[15px] font-semibold">Billed, but Signet doesn&apos;t have it</h2>
      {!missing ? (
        <span className="text-sm text-[#4b5563]">Load QuickBooks to check{qb.error ? ` (${qb.error})` : ""}.</span>
      ) : (
        <div className="grid grid-cols-[1fr_140px] gap-y-2 text-sm">
          {list.map((m) => (
            <Fragment key={m.num}>
              <span>{m.num}{m.po ? ` · PO ${m.po}` : ""} · {m.days} days</span>
              <span className={`text-right tabular-nums ${m.days >= 14 ? "font-semibold text-[#9a3412]" : ""}`}>{money(m.amount)}</span>
            </Fragment>
          ))}
          {!missing.length && <span className="col-span-full text-[#4b5563]">Signet has everything we billed.</span>}
        </div>
      )}
      {missing && missing.length > 8 && <button onClick={() => setAll(!all)} className="min-h-[44px] self-start text-[13px] text-[#1d4ed8] underline">{all ? "Show fewer" : `Show all ${missing.length}`}</button>}
      <span className="text-[13px] text-[#4b5563]">Fills in from QuickBooks. Over 14 days turns red.</span>
    </div>
  );
}

export default function PaymentsTab({ rows, runs, deductions, qb, qbFrom, linked, upcoming, missing, today }) {
  const [open, setOpen] = usePersistedState("signetap.run", null);
  const [limit, setLimit] = useState(10);
  const byRun = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.sap_payment_no) (m.get(r.sap_payment_no) || m.set(r.sap_payment_no, []).get(r.sap_payment_no)).push(r);
    return m;
  }, [rows]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2.5">
        <h2 className="text-[15px] font-semibold">Paid by Signet</h2>
        <div className={`${GRID} ${headCls}`}><span>Paid</span><span>Signet payment</span><span>What&apos;s in it</span><span className="text-right">Net paid</span><span /></div>
        {!runs.length && <div className="py-6 text-center text-gray-400">No payment runs yet. Upload the Signet export.</div>}
        {runs.slice(0, limit).map((r) => (
          <RunRow key={r.sap_payment_no} run={r} lines={byRun.get(r.sap_payment_no) || []} deductions={deductions} qb={qb} qbFrom={qbFrom} linked={linked}
            open={open === r.sap_payment_no} onToggle={() => setOpen(open === r.sap_payment_no ? null : r.sap_payment_no)} />
        ))}
        {runs.length > limit && <button onClick={() => setLimit(limit + 15)} className="min-h-[44px] self-start text-sm text-[#1d4ed8] underline">Show older payments ({runs.length - limit} more)</button>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <ComingUp upcoming={upcoming} today={today} />
        <Missing missing={missing} qb={qb} />
      </div>
    </div>
  );
}
