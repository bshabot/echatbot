import { useState } from "react";
import usePersistedState from "../../Hooks/usePersistedState";
import { ISSUE_LABEL, splitIssues } from "../../utils/signetAp";
import { Chip, MemoBox, PostButton, SubTabs, money, TH, THEAD } from "./ui";

const SUBS = ["open", "disputed", "done"];
const ORDER = ["paid_short", "amount_diff", "past_due", "missing", "not_in_qb"];
const TONE = { paid_short: "red", amount_diff: "amber", past_due: "yellow", missing: "blue", not_in_qb: "sky" };

function Detail({ i }) {
  if (i.type === "missing") return <>QB {money(i.qbAmount)}, billed {i.date}, <b className={i.level === "red" ? "text-red-700" : i.level === "yellow" ? "text-yellow-700" : ""}>{i.days} days</b> and Signet has no line</>;
  if (i.type === "past_due") return <>Signet {money(i.signetAmount)}, approved, due {i.date}, <b className={i.level === "red" ? "text-red-700" : "text-yellow-700"}>{i.days} days past due</b></>;
  if (i.type === "not_in_qb") return <>Signet {money(i.signetAmount)} posted {i.date}; no QB invoice with this number</>;
  return <>QB {money(i.qbAmount)}, Signet {money(i.signetAmount)} ({i.diff < 0 ? "short" : "over"} <b>{money(Math.abs(i.diff))}</b>){i.type === "amount_diff" && !i.paid ? ", approved, not paid yet" : ""}</>;
}

function Row({ i, notes, onSave, sub }) {
  const [qbNum, setQbNum] = useState("");
  const n = notes[i.key] || {};
  const legacy = notes[`invoice:${i.ref}`]?.note || ""; // memo from the old Compare screen, until a memo is saved here
  const memo = n.note || legacy;
  return (
    <tr className="border-t align-top">
      <td className={TH}><Chip tone={TONE[i.type]}>{ISSUE_LABEL[i.type]}</Chip></td>
      <td className={TH}>{i.ref}</td>
      <td className={TH}>{i.po}</td>
      <td className={`${TH} text-sm`}><Detail i={i} /></td>
      <td className={TH}><MemoBox value={memo} onSave={(v) => onSave(i.key, { note: v })} /></td>
      <td className={TH}>
        {i.type === "paid_short" && sub !== "done" && (
          <span className="flex gap-1">
            <PostButton>Add to QB</PostButton>
            {sub === "open" && <button onClick={() => onSave(i.key, { issue_status: "disputed" })} className="rounded bg-amber-500 px-2 py-1 text-xs text-white hover:bg-amber-600">Dispute</button>}
          </span>
        )}
        {i.type === "not_in_qb" && sub !== "done" && (
          <span className="flex gap-1">
            <input value={qbNum} onChange={(e) => setQbNum(e.target.value)} placeholder="QB invoice #" className="w-28 rounded border px-1 py-0.5 text-xs" />
            <button disabled={!qbNum.trim()} onClick={() => onSave(i.key, { linked_ref: qbNum.trim(), issue_status: "done" })} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white disabled:opacity-40">Mark matched</button>
          </span>
        )}
      </td>
    </tr>
  );
}

export default function IssuesTab({ issues, notes, qb, onSave }) {
  const [sub, setSub] = usePersistedState("signetap.issues.sub", "open", (v) => SUBS.includes(v));
  const s = splitIssues(issues, notes);
  const list = [...s[sub]].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || (b.days ?? 0) - (a.days ?? 0) || Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
  return (
    <div className="space-y-3">
      {qb.status !== "ok" && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          QuickBooks is not loaded{qb.error ? ` (${qb.error})` : ""}, so only Past due can be shown. The other issue types need the QB side.
        </div>
      )}
      <SubTabs value={sub} onChange={setSub} items={[{ id: "open", label: "Open", count: s.open.length }, { id: "disputed", label: "Disputed", count: s.disputed.length }, { id: "done", label: "Done", count: s.done.length }]} />
      <div className="max-h-[70vh] overflow-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className={THEAD}><tr><th className={TH}>Issue</th><th className={TH}>Invoice</th><th className={TH}>PO</th><th className={TH}>Details</th><th className={TH}>Memo</th><th className={TH} /></tr></thead>
          <tbody>
            {list.map((i) => <Row key={i.key} i={i} notes={notes} onSave={onSave} sub={sub} />)}
            {!list.length && <tr><td colSpan={6} className="p-6 text-center text-gray-400">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
