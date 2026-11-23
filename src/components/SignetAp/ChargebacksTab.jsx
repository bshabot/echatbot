import { Fragment, useMemo, useState } from "react";
import usePersistedState from "../../Hooks/usePersistedState";
import { sum, DEDUCTION_LABEL } from "../../utils/signetAp";
import { disputedSubtitle, fmtMd, fmtMdy, groupByPoType } from "../../utils/signetApView";
import { Chip, MemoBox, PostButton, SubTabs, btnDanger, cardCls, headCls, money, rowCls } from "./ui";

const SUBS = ["new", "disputed", "done"];
const DONE_LABEL = { repaid: "Closed · repaid", added_to_qb: "Closed · added to QB", history: "Closed · old, repaid" };
const comingOf = (d) => d.status !== "done" && !!d.repayment_vim_invoice;
const GRID = "grid grid-cols-[150px_150px_110px_80px_minmax(0,1fr)_250px] gap-4";
const stop = (e) => e.stopPropagation();

function Detail({ d, rowsByVim, dedByVim }) {
  const row = rowsByVim.get(d.vim_invoice), rp = d.repayment_vim_invoice ? rowsByVim.get(d.repayment_vim_invoice) : null;
  const inv = d.linked_invoice ? [...rowsByVim.values()].find((r) => r.vendor_invoice === d.linked_invoice && r.type !== "CREDIT") : null;
  const before = d.charged_before_of ? dedByVim.get(d.charged_before_of) : null;
  const Item = ({ k, children }) => <div><div className="text-xs text-[#4b5563]">{k}</div><div>{children || "-"}</div></div>;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-[10px] bg-[#f9fafb] px-4 py-3 text-sm md:grid-cols-4">
      <Item k="Reference">{d.reference}</Item>
      <Item k="Type">{DEDUCTION_LABEL[d.type]}</Item>
      <Item k="PO / line / SKU">{[d.po_number, d.line, d.sku].filter(Boolean).join(" / ")}</Item>
      <Item k="Amount deducted">{money(d.amount)}</Item>
      <Item k="Posted">{row?.posting_date}</Item>
      <Item k="Payment run">{row?.sap_payment_no ? `${row.sap_payment_no} on ${row.payment_date}` : row?.status === "APPROVED" ? "not netted yet (approved)" : ""}</Item>
      <Item k="First seen">{d.first_seen_at?.slice(0, 10)}</Item>
      <Item k="Related invoice">{inv ? `${inv.vendor_invoice}: Signet ${money(inv.amount)}` : d.linked_invoice}</Item>
      <Item k="Repayment">{rp ? <>{rp.vendor_invoice}<br />{money(rp.amount)} · {rp.status === "PAID" ? `paid ${fmtMdy(rp.payment_date) || "(date missing)"}` : `${rp.status || "pending"}, due ${fmtMdy(rp.net_due_date) || "?"}`}</> : d.repayment_vim_invoice ? "RP line not in saved data" : ""}</Item>
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
  const latest = g.items.map((d) => rowsByVim.get(d.vim_invoice)?.posting_date).filter(Boolean).sort().pop();
  const memo = g.items.map((d) => d.note).find(Boolean) || "";
  // Closed label; for repaid items add the date Signet paid the RP line back.
  const repaidOn = g.items.map((d) => rowsByVim.get(d.repayment_vim_invoice)?.payment_date).filter(Boolean).sort().pop();
  const done = [...new Set(g.items.map((d) => DONE_LABEL[d.done_reason]).filter(Boolean))].join(", ") + (repaidOn && g.items.some((d) => d.done_reason === "repaid") ? ` ${fmtMd(repaidOn)}` : "");
  return (
    <div className={rowCls}>
      <div onClick={() => setOpen(!open)} className={`${GRID} cursor-pointer items-center py-2.5 text-sm hover:bg-gray-50`}>
        <span className="flex flex-col gap-1"><span className="font-medium">{DEDUCTION_LABEL[g.type]}</span><Flags items={g.items} dedByVim={dedByVim} /></span>
        <span className="flex flex-col gap-0.5"><span>{g.po || "No PO"}</span><span className="text-xs text-[#4b5563]">{single ? g.items[0].reference : `${g.count} lines`}</span></span>
        <span className="text-right tabular-nums">{money(g.total)}</span>
        <span className="text-[#4b5563]">{fmtMd(latest)}</span>
        <span onClick={stop}><MemoBox value={memo} onSave={(v) => onNote(g.items, v)} /></span>
        <span className="flex justify-end gap-2" onClick={stop}>
          {sub === "done" ? <Chip tone="green" title="Signet repaid this charge. The original chargeback is closed.">{"✓ "}{done}</Chip> : (
            <>
              <PostButton className="px-4">Add to QB</PostButton>
              {sub === "new" && <button onClick={() => onDispute(g.items)} className={btnDanger}>Dispute</button>}
            </>
          )}
        </span>
      </div>
      {open && (
        <div className="mb-3 ml-4 flex flex-col gap-1 rounded-[10px] bg-[#f9fafb] p-2">
          {g.items.map((d) => (
            <Fragment key={d.vim_invoice}>
              {!single && (
                <div onClick={() => setDet(det === d.vim_invoice ? null : d.vim_invoice)} className="grid cursor-pointer grid-cols-[1fr_110px_80px_1fr] gap-4 rounded px-2 py-1.5 text-xs hover:bg-gray-100">
                  <span>{d.reference}</span><span className="text-right tabular-nums">{money(d.amount)}</span>
                  <span className="text-[#4b5563]">{fmtMd(rowsByVim.get(d.vim_invoice)?.posting_date)}</span><Flags items={[d]} dedByVim={dedByVim} />
                </div>
              )}
              {(single || det === d.vim_invoice) && <Detail d={d} rowsByVim={rowsByVim} dedByVim={dedByVim} />}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChargebacksTab({ deductions, rowsByVim, onDispute, onNote }) {
  const [sub, setSub] = usePersistedState("signetap.cb.sub", "new", (v) => SUBS.includes(v));
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(150);
  const dedByVim = useMemo(() => new Map(deductions.map((d) => [d.vim_invoice, d])), [deductions]);
  const by = useMemo(() => ({ new: deductions.filter((d) => d.status === "new"), disputed: deductions.filter((d) => d.status === "disputed"), done: deductions.filter((d) => d.status === "done") }), [deductions]);
  const groups = useMemo(() => ({ new: groupByPoType(by.new), disputed: groupByPoType(by.disputed) }), [by]);
  const coming = useMemo(() => deductions.filter(comingOf), [deductions]);
  const nextDue = coming.map((d) => d.repayment_due_date).filter(Boolean).sort()[0];
  const list = useMemo(() => {
    if (sub !== "done") return groups[sub];
    const t = q.trim().toLowerCase();
    return groupByPoType(t ? by.done.filter((d) => [d.reference, d.po_number, d.note, d.amount, d.sku, d.linked_invoice].join(" ").toLowerCase().includes(t)) : by.done);
  }, [by, groups, sub, q]);
  const Card = ({ label, value, sub: s }) => (
    <div className={`${cardCls} flex flex-col gap-1.5 !py-4`}><span className="text-[13px] text-[#4b5563]">{label}</span><span className="text-[26px] font-semibold">{value}</span><span className="text-[13px] text-[#4b5563]">{s}</span></div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <Card label="New, not handled" value={money(sum(by.new, (d) => d.amount))} sub={`${groups.new.length} groups`} />
        <Card label="Disputed" value={money(sum(by.disputed, (d) => d.amount))} sub={disputedSubtitle(by.disputed)} />
        <Card label="Repayment coming" value={money(sum(coming, (d) => d.amount))} sub={nextDue ? `Due ${fmtMdy(nextDue)}` : coming.length ? "due date not set" : "none"} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubTabs value={sub} onChange={(v) => { setSub(v); setLimit(150); }} items={[{ id: "new", label: "New", count: groups.new.length }, { id: "disputed", label: "Disputed", count: groups.disputed.length }, { id: "done", label: "Done" }]} />
        {sub === "done" && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reference, PO, amount, memo…" className="min-h-[44px] w-80 rounded-lg border border-[#d1d5db] px-3 text-sm" />}
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[1000px]">
          <div className={`${GRID} ${headCls}`}><span>Type</span><span>PO</span><span className="text-right">Amount</span><span>Date</span><span>Memo</span><span /></div>
          {list.slice(0, limit).map((g) => <Group key={`${sub}:${g.po}:${g.type}`} g={g} sub={sub} rowsByVim={rowsByVim} dedByVim={dedByVim} onDispute={onDispute} onNote={onNote} />)}
          {!list.length && <div className="py-8 text-center text-gray-400">{sub === "new" ? "Nothing new. Everything is handled." : "Nothing here."}</div>}
          {list.length > limit && <button onClick={() => setLimit(limit + 150)} className="mt-2 min-h-[44px] text-sm text-[#1d4ed8] underline">Show more ({list.length - limit} more rows)</button>}
        </div>
      </div>
    </div>
  );
}
