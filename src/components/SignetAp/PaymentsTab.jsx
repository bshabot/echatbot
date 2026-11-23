import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import usePersistedState from "../../Hooks/usePersistedState";
import { buildRunView, appliedGap, DEDUCTION_LABEL } from "../../utils/signetAp";
import { Chip, PostButton, money, TH, THEAD } from "./ui";

const STATUS = { new: ["New", "blue"], approved: ["Approved", "amber"], posted: ["Posted", "green"] };

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

function RunDetail({ run, lines, deductions, qb, qbFrom, linked }) {
  const covered = qb.status === "ok" && lines.every((l) => !l.posting_date || l.posting_date >= qbFrom);
  const why = qb.status === "ok" ? `The QuickBooks pull starts ${qbFrom}; this run has older invoices.`
    : qb.status === "off" ? "QuickBooks integration is off (Settings)." : qb.status === "loading" ? "Loading QuickBooks…"
      : qb.status === "error" ? `QuickBooks not reachable: ${qb.error}` : "QuickBooks not loaded.";
  const v = useMemo(() => {
    const byNum = covered ? new Map(qb.invoices.map((q) => [q.num, q])) : null;
    return buildRunView(lines, { qbByNum: byNum, deductions, lookup: (l) => (linked.has(l.vendor_invoice) ? byNum.get(linked.get(l.vendor_invoice)) : null) });
  }, [lines, deductions, qb.invoices, covered, linked]);
  const chk = v.qbChecked ? appliedGap(v.header.net_paid, v.applied) : null;
  const L = (l) => (
    <>
      <td className={TH}>{l.vendor_invoice}</td><td className={TH}>{l.po_number}</td>
    </>
  );
  return (
    <div className="space-y-2 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded border bg-white px-3 py-2 text-sm">
        <span>Payment <b>{run.sap_payment_no}</b></span>
        <span>Date <b>{run.payment_date}</b></span>
        <span>Invoices <b>{money(v.header.invoice_total)}</b></span>
        <span>Deductions <b className="text-red-700">{money(v.header.deduction_total)}</b></span>
        <span>Net paid <b>{money(v.header.net_paid)}</b></span>
        <span className="ml-auto flex items-center gap-2"><PostButton>Approve and post</PostButton></span>
      </div>
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

export default function PaymentsTab({ rows, runs, deductions, qb, qbFrom, linked }) {
  const [open, setOpen] = usePersistedState("signetap.run", null);
  const byRun = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.sap_payment_no) (m.get(r.sap_payment_no) || m.set(r.sap_payment_no, []).get(r.sap_payment_no)).push(r);
    return m;
  }, [rows]);
  if (!runs.length) return <div className="rounded border bg-white p-6 text-center text-gray-400">No payment runs yet. Upload the Signet export.</div>;
  return (
    <div className="max-h-[75vh] overflow-auto rounded border bg-white">
      <table className="w-full text-sm">
        <thead className={THEAD}><tr><th className={TH} /><th className={TH}>Payment #</th><th className={TH}>Date</th><th className={`${TH} text-right`}>Invoices</th><th className={`${TH} text-right`}>Deductions</th><th className={`${TH} text-right`}>Net paid</th><th className={`${TH} text-right`}>Lines</th><th className={TH}>Status</th></tr></thead>
        <tbody>
          {runs.map((r) => {
            const isOpen = open === r.sap_payment_no, [lab, tone] = STATUS[r.status] || STATUS.new;
            return (
              <Fragment key={r.sap_payment_no}>
                <tr onClick={() => setOpen(isOpen ? null : r.sap_payment_no)} className={`cursor-pointer border-t hover:bg-gray-50 ${isOpen ? "bg-gray-50" : ""}`}>
                  <td className={TH}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td className={TH}>{r.sap_payment_no}</td><td className={TH}>{r.payment_date}</td>
                  <td className={`${TH} text-right`}>{money(r.invoice_total)}</td><td className={`${TH} text-right text-red-700`}>{money(r.deduction_total)}</td>
                  <td className={`${TH} text-right font-medium`}>{money(r.net_paid)}</td><td className={`${TH} text-right`}>{r.line_count}</td>
                  <td className={TH}><Chip tone={tone}>{lab}</Chip></td>
                </tr>
                {isOpen && <tr><td colSpan={8} className="p-0"><RunDetail run={r} lines={byRun.get(r.sap_payment_no) || []} deductions={deductions} qb={qb} qbFrom={qbFrom} linked={linked} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
