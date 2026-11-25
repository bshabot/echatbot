import { useState } from "react";
import usePersistedState from "../../Hooks/usePersistedState";
import { ISSUE_LABEL, splitIssues } from "../../utils/signetAp";
import { fmtMd, groupIssues } from "../../utils/signetApView";
import { MemoBox, PostButton, SubTabs, ViewSwitch, btnDanger, btnOutline, headCls, money, rowCls } from "./ui";

const SUBS = ["open", "disputed", "done"];
const GRID = "grid grid-cols-[170px_170px_110px_110px_110px_minmax(0,1fr)_240px] gap-3.5";
const MUTED = "text-[#4b5563]";

function detailLine(r) {
  const po = r.po ? `PO ${r.po}` : "No PO";
  if (r.type === "paid_short") return { text: r.count > 1 ? `${r.refText} · paid ${fmtMd(r.payDate)}` : `${po} · paid ${fmtMd(r.payDate)}` };
  if (r.type === "missing") return { text: `${po} · ${r.days} days`, hot: r.days >= 14 };
  if (r.type === "amount_diff") return { text: `${po} · due ${fmtMd(r.due)}` };
  if (r.type === "past_due") return { text: `${po} · due ${fmtMd(r.due)} · ${r.days} days past`, hot: r.days >= 14 };
  return { text: `${r.refText}${r.due ? ` · due ${fmtMd(r.due)}` : ""}` };
}

function Row({ r, notes, onSave, sub }) {
  const [matching, setMatching] = useState(false);
  const [nums, setNums] = useState({});
  const memo = r.items.map((i) => notes[i.key]?.note || notes[`invoice:${i.ref}`]?.note).find(Boolean) || ""; // old Compare memo until one is saved here
  const saveAll = (patch) => r.items.forEach((i) => onSave(i.key, patch));
  const d = detailLine(r);
  const title = r.count > 1 ? (r.type === "paid_short" ? `${r.count} invoices` : `${r.count} Signet lines`) : r.items[0].ref;
  const action = () => {
    if (r.type === "paid_short") {
      if (sub === "done") return null;
      return (<><PostButton>Add to QB</PostButton>{sub === "open" && <button onClick={() => saveAll({ issue_status: "disputed" })} className={btnDanger}>Dispute</button>}</>);
    }
    if (r.type === "not_in_qb") return sub === "done" ? null : <button onClick={() => setMatching(!matching)} className={btnOutline}>Mark matched</button>;
    const t = r.type === "missing" ? "Clears when Signet shows it" : r.type === "amount_diff" ? (r.paid ? "Paid. Take it up with Signet." : "Not paid yet. Fix it before they pay.") : "Clears when paid";
    return <span className={`text-right text-[13px] ${MUTED}`}>{t}</span>;
  };
  const doMatch = () => {
    r.items.forEach((i) => { const n = (nums[i.key] || "").trim(); if (n) onSave(i.key, { linked_ref: n, issue_status: "done" }); });
    setMatching(false);
  };
  return (
    <div className={rowCls}>
      <div className={`${GRID} items-center py-2.5 text-sm`}>
        <span className="font-medium">{ISSUE_LABEL[r.type]}</span>
        <span className="flex flex-col gap-0.5"><span>{title}</span><span className={`text-xs ${d.hot ? "font-semibold text-[#9a3412]" : MUTED}`}>{d.text}</span></span>
        <span className={`text-right tabular-nums ${r.type === "not_in_qb" ? MUTED : ""}`}>{r.type === "not_in_qb" ? "No match" : r.qbAmount != null ? money(r.qbAmount) : ""}</span>
        <span className={`text-right tabular-nums ${r.type === "missing" ? MUTED : ""}`}>{r.type === "missing" ? "Not there" : r.signetAmount != null ? money(r.signetAmount) : ""}</span>
        <span className="text-right font-semibold tabular-nums text-[#9a3412]">{r.diff ? money(r.diff) : ""}</span>
        <MemoBox value={memo} onSave={(v) => saveAll({ note: v })} />
        <span className="flex justify-end gap-2">{action()}</span>
      </div>
      {matching && (
        <div className="mb-3 ml-4 flex flex-col gap-2 rounded-[10px] bg-[#f9fafb] p-3 text-sm">
          <span className={MUTED}>Type the QuickBooks invoice number each Signet line belongs to.</span>
          {r.items.map((i) => (
            <label key={i.key} className="flex items-center gap-3">
              <span className="w-48">{i.ref} <span className={MUTED}>{money(i.signetAmount)}</span></span>
              <input value={nums[i.key] || ""} onChange={(e) => setNums({ ...nums, [i.key]: e.target.value })} placeholder="QB invoice #" className="min-h-[44px] w-48 rounded-lg border border-[#d1d5db] px-3 text-sm" />
            </label>
          ))}
          <div className="flex gap-2">
            <button onClick={doMatch} disabled={!r.items.some((i) => (nums[i.key] || "").trim())} className={btnOutline}>Save match</button>
            <button onClick={() => setMatching(false)} className={btnOutline}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Row count per sub-tab (grouped rows, as shown). Used for the tab badge too. */
export function issueRowCounts(issues, notes, grouped = true) {
  const s = splitIssues(issues, notes);
  const g = { grouped };
  const rows = { open: groupIssues(s.open, g), disputed: groupIssues(s.disputed, g), done: groupIssues(s.done, g) };
  return { rows, open: rows.open.length, disputed: rows.disputed.length, done: rows.done.length };
}

export default function IssuesTab({ issues, notes, qb, onSave, view = "grouped", onView }) {
  const [sub, setSub] = usePersistedState("signetap.issues.sub", "open", (v) => SUBS.includes(v));
  const c = issueRowCounts(issues, notes, view !== "lines");
  const list = c.rows[sub];
  return (
    <div className="flex flex-col gap-6">
      {qb.status !== "ok" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          QuickBooks is not loaded{qb.error ? ` (${qb.error})` : ""}, so only Past due can be shown. The other issue types need the QB side.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3"><SubTabs value={sub} onChange={setSub} items={[{ id: "open", label: "Open", count: c.open }, { id: "disputed", label: "Disputed" }, { id: "done", label: "Done" }]} />
        <ViewSwitch value={view} onChange={onView} />
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[1100px]">
          <div className={`${GRID} ${headCls}`}><span>Issue</span><span>Invoice</span><span className="text-right">QuickBooks</span><span className="text-right">Signet</span><span className="text-right">Difference</span><span>Memo</span><span /></div>
          {list.map((r) => <Row key={r.id} r={r} notes={notes} onSave={onSave} sub={sub} />)}
          {!list.length && <div className="py-8 text-center text-gray-400">Nothing here.</div>}
        </div>
      </div>
    </div>
  );
}
