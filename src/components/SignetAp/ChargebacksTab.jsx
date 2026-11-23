import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import usePersistedState from "../../Hooks/usePersistedState";
import { groupByPo, sum, DEDUCTION_LABEL } from "../../utils/signetAp";
import { Chip, MemoBox, PostButton, Stat, SubTabs, money, TH, THEAD } from "./ui";

const SUBS = ["new", "disputed", "done"];
const DONE_LABEL = { repaid: "Repaid", added_to_qb: "Added to QB", history: "Old, repaid" };
const comingOf = (d) => d.status !== "done" && !!d.repayment_vim_invoice;

function Detail({ d, rowsByVim, dedByVim }) {
  const row = rowsByVim.get(d.vim_invoice), rp = d.repayment_vim_invoice ? rowsByVim.get(d.repayment_vim_invoice) : null;
  const inv = d.linked_invoice ? [...rowsByVim.values()].find((r) => r.vendor_invoice === d.linked_invoice && r.type !== "CREDIT") : null;
  const before = d.charged_before_of ? dedByVim.get(d.charged_before_of) : null;
  const Item = ({ k, children }) => <div><div className="text-xs text-gray-500">{k}</div><div>{children || "-"}</div></div>;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 bg-gray-50 px-4 py-3 text-sm md:grid-cols-4">
      <Item k="Reference">{d.reference}</Item>
      <Item k="Type">{DEDUCTION_LABEL[d.type]}</Item>
      <Item k="PO / line / SKU">{[d.po_number, d.line, d.sku].filter(Boolean).join(" / ")}</Item>
      <Item k="Amount deducted">{money(d.amount)}</Item>
      <Item k="Posted">{row?.posting_date}</Item>
      <Item k="Payment run">{row?.sap_payment_no ? `${row.sap_payment_no} on ${row.payment_date}` : row?.status === "APPROVED" ? "not netted yet (approved)" : ""}</Item>
      <Item k="First seen">{d.first_seen_at?.slice(0, 10)}</Item>
      <Item k="Related invoice">{inv ? `${inv.vendor_invoice}: Signet ${money(inv.amount)}` : d.linked_invoice}</Item>
      <Item k="Repayment">{rp ? `${rp.vendor_invoice} ${money(rp.amount)} (${rp.status}), due ${rp.net_due_date || "?"}` : d.repayment_vim_invoice ? "RP line not in saved data" : ""}</Item>
      <Item k="Charged before">{before ? `${before.reference} (${money(before.amount)})` : d.charged_before_of}</Item>
      <Item k="Status">{d.status}{d.done_reason ? ` (${DONE_LABEL[d.done_reason] || d.done_reason})` : ""}</Item>
      <Item k="Follow up">{d.follow_up_date}</Item>
    </div>
  );
}

function Flags({ items, dedByVim }) {
  const coming = items.filter(comingOf), before = items.filter((d) => d.charged_before_of);
  const due = coming.map((d) => d.repayment_due_date).filter(Boolean).sort()[0];
  return (
    <span className="flex flex-wrap gap-1">
      {coming.length > 0 && <Chip tone="sky" title="Signet posted a repayment line for this">repayment coming{coming.length > 1 ? ` (${coming.length})` : ""}{due ? ` ${due}` : ""}</Chip>}
      {before.length > 0 && <Chip tone="amber" title={`Same PO, line and amount as ${dedByVim.get(before[0].charged_before_of)?.reference || "an earlier charge"}`}>charged before{before.length > 1 ? ` (${before.length})` : ""}</Chip>}
    </span>
  );
}

function Group({ g, sub, rowsByVim, dedByVim, onDispute, onNote }) {
  const [open, setOpen] = useState(false);
  const [det, setDet] = useState(null);
  const single = g.count === 1;
  const dates = g.items.map((d) => rowsByVim.get(d.vim_invoice)?.posting_date).filter(Boolean).sort();
  const date = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`) : "";
  const memo = g.items.map((d) => d.note).find(Boolean) || "";
  const done = [...new Set(g.items.map((d) => DONE_LABEL[d.done_reason]).filter(Boolean))].join(", ");
  return (
    <tbody className="border-t">
      <tr onClick={() => setOpen(!open)} className="cursor-pointer align-top hover:bg-gray-50">
        <td className={TH}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
        <td className={TH}>
          {single ? DEDUCTION_LABEL[g.types[0]] : g.types.map((t) => DEDUCTION_LABEL[t]).join(", ")}
          <div className="text-xs text-gray-500">{single ? g.items[0].reference : `${g.count} charges`}</div>
        </td>
        <td className={TH}>{g.po || <span className="text-gray-400">(no PO)</span>}</td>
        <td className={`${TH} text-right font-medium`}>{money(g.total)}</td>
        <td className={`${TH} whitespace-nowrap`}>{date}</td>
        <td className={TH}><Flags items={g.items} dedByVim={dedByVim} />{sub === "done" && <Chip tone="green">{done}</Chip>}</td>
        <td className={TH}><MemoBox value={memo} onSave={(v) => onNote(g.items, v)} placeholder={g.count > 1 ? `Memo for all ${g.count}…` : "Memo…"} /></td>
        <td className={TH}>
          {sub !== "done" && (
            <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <PostButton>Add to QB</PostButton>
              {sub === "new" && <button onClick={() => onDispute(g.items)} className="rounded bg-amber-500 px-2 py-1 text-xs text-white hover:bg-amber-600">{g.count > 1 ? `Dispute ${g.count}` : "Dispute"}</button>}
            </span>
          )}
        </td>
      </tr>
      {open && g.items.map((d) => (
        <Fragment key={d.vim_invoice}>
          {!single && (
            <tr onClick={() => setDet(det === d.vim_invoice ? null : d.vim_invoice)} className="cursor-pointer bg-gray-50/60 text-xs hover:bg-gray-100">
              <td /><td className={TH}><span className="pl-3">{d.reference}</span></td><td className={TH}>{DEDUCTION_LABEL[d.type]}</td>
              <td className={`${TH} text-right`}>{money(d.amount)}</td><td className={TH}>{rowsByVim.get(d.vim_invoice)?.posting_date}</td>
              <td className={TH} colSpan={3}><Flags items={[d]} dedByVim={dedByVim} /></td>
            </tr>
          )}
          {(single || det === d.vim_invoice) && <tr><td colSpan={8} className="p-0"><Detail d={d} rowsByVim={rowsByVim} dedByVim={dedByVim} /></td></tr>}
        </Fragment>
      ))}
    </tbody>
  );
}

export default function ChargebacksTab({ deductions, rowsByVim, onDispute, onNote }) {
  const [sub, setSub] = usePersistedState("signetap.cb.sub", "new", (v) => SUBS.includes(v));
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(150);
  const dedByVim = useMemo(() => new Map(deductions.map((d) => [d.vim_invoice, d])), [deductions]);
  const by = useMemo(() => ({ new: deductions.filter((d) => d.status === "new"), disputed: deductions.filter((d) => d.status === "disputed"), done: deductions.filter((d) => d.status === "done") }), [deductions]);
  const coming = useMemo(() => deductions.filter(comingOf), [deductions]);
  const nextDue = coming.map((d) => d.repayment_due_date).filter(Boolean).sort()[0];
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const src = sub === "done" && t ? by.done.filter((d) => [d.reference, d.po_number, d.note, d.amount, d.sku, d.linked_invoice].join(" ").toLowerCase().includes(t)) : by[sub];
    return groupByPo(src);
  }, [by, sub, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Stat label="New" value={money(sum(by.new, (d) => d.amount))} sub={`${by.new.length} chargebacks`} tone={by.new.length ? "yellow" : undefined} />
        <Stat label="Disputed" value={money(sum(by.disputed, (d) => d.amount))} sub={`${by.disputed.length} chargebacks`} />
        <Stat label="Repayment coming" value={money(sum(coming, (d) => d.amount))} sub={coming.length ? `${coming.length} rows${nextDue ? `, next ${nextDue}` : ""}` : "none"} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubTabs value={sub} onChange={(v) => { setSub(v); setLimit(150); }} items={[{ id: "new", label: "New", count: by.new.length }, { id: "disputed", label: "Disputed", count: by.disputed.length }, { id: "done", label: "Done", count: by.done.length }]} />
        {sub === "done" && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reference, PO, amount, memo…" className="w-72 rounded border px-2 py-1 text-sm" />}
        <span className="text-xs text-gray-500">Rows are grouped by PO. Memo and Dispute apply to the whole group. Click a row for details.</span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className={THEAD}><tr><th className={TH} /><th className={TH}>Type</th><th className={TH}>PO</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>Date</th><th className={TH}>Flags</th><th className={TH}>Memo</th><th className={TH} /></tr></thead>
          {list.slice(0, limit).map((g) => <Group key={`${sub}:${g.po}`} g={g} sub={sub} rowsByVim={rowsByVim} dedByVim={dedByVim} onDispute={onDispute} onNote={onNote} />)}
          {!list.length && <tbody><tr><td colSpan={8} className="p-6 text-center text-gray-400">{sub === "new" ? "Nothing new. Everything is handled." : "Nothing here."}</td></tr></tbody>}
        </table>
        {list.length > limit && <button onClick={() => setLimit(limit + 150)} className="m-2 rounded border px-3 py-1 text-xs hover:bg-gray-50">Show more ({list.length - limit} more POs)</button>}
      </div>
    </div>
  );
}
