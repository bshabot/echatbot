// Preview + explicit confirm for writing chargebacks (credit memos) or repayments (sales orders) to QuickBooks.
// Opening this dialog and editing fields only ever runs the connector's DRY RUN (validate, show the exact qbXML,
// look for a duplicate). Nothing is created until the user clicks "Create in QuickBooks".
import { useEffect, useMemo, useRef, useState } from "react";
import {
  qbNumberFor, buildCreditMemoPayload, buildRepaymentSoPayload, duplicateState, moneyText, QB_REF_MAX,
} from "../../utils/signetQbPost";
import { btnOutline, btnPrimary } from "./ui";

const WORDS = {
  cm: { doc: "credit memo", num: "CM#", title: "Add chargeback to QuickBooks", go: "Create in QuickBooks" },
  so: { doc: "sales order", num: "SO#", title: "Add repayment to QuickBooks", go: "Create in QuickBooks" },
};
const refOf = (kind, d, rp) => (kind === "so" ? rp?.vendor_invoice : d.reference);

export default function QbPostDialog({ kind, items, enabled, onClose, onPreview, onCreate }) {
  const W = WORDS[kind];
  const [fields, setFields] = useState(() =>
    Object.fromEntries(items.map(({ d, rp }) => {
      const q = qbNumberFor(refOf(kind, d, rp));
      return [d.vim_invoice, { number: q.fits ? "" : q.suggestion, memo: kind === "so" ? "" : d.note || "" }];
    }))
  );
  const [checks, setChecks] = useState({});
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const seen = useRef({}), timers = useRef({}), alive = useRef(true);
  useEffect(() => () => { alive.current = false; Object.values(timers.current).forEach(clearTimeout); }, []);

  const built = useMemo(() => items.map(({ d, rp }) => {
    const f = fields[d.vim_invoice];
    const b = kind === "so" ? buildRepaymentSoPayload(d, rp, { number: f.number }) : buildCreditMemoPayload(d, f.memo, { number: f.number });
    return { d, rp, b, key: JSON.stringify(b.payload) };
  }), [items, fields, kind]);

  // Dry-run each valid item (debounced); the answer is what gates the confirm button.
  useEffect(() => {
    if (!enabled) return;
    built.forEach(({ d, b, key }) => {
      const vim = d.vim_invoice;
      if (results[vim]?.ok) return;
      if (!b.ok) { delete seen.current[vim]; setChecks((c) => (c[vim] ? { ...c, [vim]: undefined } : c)); return; }
      if (seen.current[vim] === key) return;
      seen.current[vim] = key;
      setChecks((c) => ({ ...c, [vim]: { key, state: "checking" } }));
      clearTimeout(timers.current[vim]);
      timers.current[vim] = setTimeout(async () => {
        let next;
        try {
          const res = await onPreview(kind, b.payload);
          if (res?.skipped) next = { key, state: "unchecked", message: "QuickBooks integration is off in Settings." };
          else {
            const dup = duplicateState(res?.duplicate_check, W.doc, b.number);
            const state = dup.state !== "clear" ? dup.state : res?.valid ? "clear" : "invalid";
            next = { key, state, message: state === "invalid" ? (res?.errors || []).join("; ") || "QuickBooks rejected the preview." : dup.message, xml: res?.request_xml };
          }
        } catch (e) {
          next = { key, state: "unchecked", message: `Couldn't reach QuickBooks: ${e.message}` };
        }
        if (alive.current && seen.current[vim] === key) setChecks((c) => ({ ...c, [vim]: next }));
      }, 450);
    });
  }, [built, enabled, kind, onPreview, W.doc, results]);

  const pending = built.filter((x) => !results[x.d.vim_invoice]?.ok);
  const unknown = Object.values(results).some((r) => r?.unknown);
  const ready = enabled && !unknown && pending.length > 0 && pending.every(({ d, b, key }) => b.ok && checks[d.vim_invoice]?.state === "clear" && checks[d.vim_invoice].key === key);

  const confirm = async () => {
    setBusy(true);
    for (const x of pending) {
      const r = await onCreate(kind, x.d, x.b.payload, x.rp);
      if (!alive.current) return;
      setResults((s) => ({ ...s, [x.d.vim_invoice]: r }));
      if (!r.ok) break; // never carry on after a failure or an unknown outcome
    }
    if (alive.current) setBusy(false);
  };

  const set = (vim, patch) => setFields((s) => ({ ...s, [vim]: { ...s[vim], ...patch } }));
  const total = built.reduce((a, x) => a + (x.b.preview.amount || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={W.title}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl">
        <div className="border-b border-[#e5e7eb] px-6 py-4">
          <div className="text-lg font-semibold">{W.title}</div>
          <div className="text-sm text-[#4b5563]">
            {kind === "so"
              ? "Signet paid this repayment, so it goes back into QuickBooks as a sales order (customer, PO and the Chargebacks item as on the credit memo)."
              : `Each chargeback becomes its own credit memo (${items.length} here, ${moneyText(total)}). Nothing is sent to QuickBooks until you click ${W.go}.`}
          </div>
          {!enabled && <div className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">The QuickBooks integration is off in Settings, so nothing can be previewed or created.</div>}
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-4">
          {built.map(({ d, rp, b }) => {
            const vim = d.vim_invoice, f = fields[vim], c = checks[vim], r = results[vim];
            const q = qbNumberFor(refOf(kind, d, rp));
            return (
              <div key={vim} className="rounded-[10px] border border-[#e5e7eb] p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="text-sm"><span className="mb-1 block text-xs text-[#4b5563]">{W.num}{q.fits ? " (as Signet writes it)" : ""}</span>
                    {q.fits ? <div className="flex min-h-[44px] items-center font-semibold">{q.number}</div>
                      : <input value={f.number} onChange={(e) => set(vim, { number: e.target.value })} disabled={!!r?.ok || busy} aria-label={W.num} className="min-h-[44px] w-full rounded-lg border border-[#d1d5db] px-3 text-sm" />}
                    {!q.fits && <span className="mt-1 block text-xs text-amber-700">{`Signet's number ${q.ref} is longer than QuickBooks allows (max ${QB_REF_MAX}). Enter a short number.`}</span>}
                  </label>
                  {kind === "cm" && (
                    <label className="text-sm"><span className="mb-1 block text-xs text-[#4b5563]">Memo (required)</span>
                      <input value={f.memo} onChange={(e) => set(vim, { memo: e.target.value })} disabled={!!r?.ok || busy} placeholder="What is this chargeback?" aria-label="Memo" className="min-h-[44px] w-full rounded-lg border border-[#d1d5db] px-3 text-sm" />
                    </label>
                  )}
                </div>
                <pre className="mt-3 whitespace-pre-wrap rounded bg-[#f9fafb] p-3 text-sm">{b.preview.text}</pre>
                {b.errors.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-red-700">{b.errors.map((m) => <li key={m}>{m}</li>)}</ul>}
                {!r && b.ok && c && (
                  <div className={`mt-2 text-sm ${c.state === "clear" ? "text-emerald-700" : c.state === "checking" ? "text-[#4b5563]" : "text-red-700"}`}>
                    {c.state === "checking" ? "Checking QuickBooks for a duplicate (dry run)..." : c.message}
                  </div>
                )}
                {c?.xml && !r && <details className="mt-2 text-xs text-[#4b5563]"><summary className="cursor-pointer">Exact qbXML request (dry run)</summary><pre className="mt-1 whitespace-pre-wrap break-all">{c.xml}</pre></details>}
                {r?.ok && <div className="mt-2 rounded bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{`Added to QB ${r.number}`}{r.saveError ? <span className="mt-1 block font-normal text-red-700">{`It is in QuickBooks, but saving it here failed: ${r.saveError}. Do not create it again.`}</span> : null}</div>}
                {r?.unknown && <div className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{r.message}</div>}
                {r && !r.ok && !r.unknown && <div className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{r.message}</div>}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-3 border-t border-[#e5e7eb] px-6 py-4">
          <button onClick={onClose} disabled={busy} className={btnOutline}>{pending.length === 0 ? "Close" : "Cancel"}</button>
          {pending.length > 0 && (
            <button onClick={confirm} disabled={!ready || busy} className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-40`}>
              {busy ? "Creating..." : items.length > 1 ? `${W.go} (${pending.length})` : W.go}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
