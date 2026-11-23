import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Chip, money, TH } from "./ui";

function Bucket({ title, sub, count, total, tone, lines, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{title}</span>
        {sub && <span className="text-xs text-gray-500">{sub}</span>}
        <Chip tone={tone}>{count}</Chip>
        <span className="ml-auto font-medium">{money(total)}</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t px-3 py-2">
          {children}
          <table className="w-full text-sm"><tbody>
            {lines.map((l) => (
              <tr key={l.vim_invoice} className="border-t">
                <td className={TH}>{l.vendor_invoice}</td><td className={TH}>{l.po_number}</td><td className={`${TH} text-gray-500`}>due {l.net_due_date || "?"}</td>
                <td className={`${TH} text-right`}>{money(l.amount)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}

export function UpcomingDetail({ upcoming: u, today }) {
  return (
    <div className="space-y-2">
      {u.pastDue.count > 0 && <Bucket title="Past due" sub="more than 7 days past Net Due Date" count={u.pastDue.count} total={u.pastDue.total} tone="red" lines={u.pastDue.lines} defaultOpen />}
      {u.weeks.map((w) => (
        <Bucket key={w.monday} title={`Run ${w.monday}`} sub={`${w.invoices.length} invoices${w.repayments.length ? `, ${w.repayments.length} repayments (${money(w.repaymentTotal)})` : ""}${w.monday < today ? ", run date passed" : ""}`}
          count={w.invoices.length + w.repayments.length} total={w.net} tone={w.monday < today ? "yellow" : "blue"} lines={[...w.invoices, ...w.repayments]} />
      ))}
      {u.noDate.count > 0 && <Bucket title="No due date" count={u.noDate.count} total={u.noDate.total} tone="gray" lines={u.noDate.lines} />}
      <Bucket title="Spread over runs" sub="dropship" count={u.dropship.count} total={u.dropship.total} tone="gray" lines={u.dropship.lines} />
      <Bucket title="Any run" sub="pending deductions, not netted yet" count={u.anyRun.count} total={-u.anyRun.total} tone="red" lines={u.anyRun.lines} />
    </div>
  );
}
