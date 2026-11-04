import { useState } from "react";
import { X } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import { useAlert } from "../Alerts/AlertContext";
import { findPurchaseOrder } from "../../utils/qbClient";
import { recordConnections } from "../../utils/sampleConnections";

// Goods are in: look up a QuickBooks vendor PO, then ADD its quantities to the matching OrderStream inventory SKUs.
// Nothing is sent until you have seen the before/after preview and confirmed.
export default function ReceivePoDialog({ onClose }) {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm } = useAlert();
  const [po, setPo] = useState("");
  const [rows, setRows] = useState(null); // { key, item, sku, qty, use, before, after, problem }
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [prior, setPrior] = useState(null);
  const [result, setResult] = useState(null);

  const edit = (i, patch) => { setPreviewed(false); setResult(null); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, before: null, after: null, problem: "" } : r))); };

  async function lookup() {
    const ref = po.trim();
    if (!ref) return;
    setBusy(true); setRows(null); setPreviewed(false); setResult(null); setPrior(null);
    try {
      const found = await findPurchaseOrder(ref);
      if (!found) { showAlert(`PO ${ref} was not found in QuickBooks.`, { variant: "error" }); return; }
      const lines = (found.lines || []).filter((l) => l?.item && Number(l.quantity) > 0);
      if (!lines.length) { showAlert(`PO ${ref} has no item lines with a quantity.`, { variant: "error" }); return; }
      setRows(lines.map((l, i) => ({ key: l.txn_line_id || i, item: l.item, sku: String(l.item).trim(), qty: String(parseInt(l.quantity, 10) || ""), use: true, before: null, after: null, problem: "" })));
      const { data } = await supabase.from("orderstream_receipts").select("applied_at,qty").eq("po_number", ref);
      if (data?.length) setPrior({ at: data.map((d) => d.applied_at).sort().pop(), lines: data.length });
    } catch (e) { showAlert("QuickBooks lookup failed: " + (e?.message || e), { variant: "error" }); } finally { setBusy(false); }
  }

  const chosen = () => (rows || []).filter((r) => r.use && r.sku && Number(r.qty) >= 1);

  async function call(dry) {
    const items = chosen().map((r) => ({ vendor_sku: r.sku, qty: Number(r.qty) }));
    const { data, error } = await supabase.functions.invoke("orderstream-bridge", { body: { action: "receive", dry, items } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function preview() {
    if (!chosen().length) return showAlert("Nothing selected. Each line needs an OrderStream SKU and a whole-number quantity.", { variant: "error" });
    setBusy(true); setResult(null);
    try {
      const d = await call(true);
      const by = Object.fromEntries((d.plan || []).map((p) => [p.sku, p]));
      const miss = Object.fromEntries((d.missing || []).map((m) => [m.sku, m.reason]));
      setRows((rs) => rs.map((r) => ({ ...r, before: by[r.sku]?.before ?? null, after: by[r.sku]?.after ?? null, problem: r.use ? miss[r.sku] || "" : "" })));
      setPreviewed(true);
    } catch (e) { showAlert("Preview failed: " + (e?.message || e), { variant: "error" }); } finally { setBusy(false); }
  }

  async function send() {
    const todo = chosen().filter((r) => r.after != null && !r.problem);
    if (!todo.length) return showAlert("No lines are ready to add.", { variant: "error" });
    const list = todo.map((r) => `${r.sku}   ${r.before} + ${r.qty} = ${r.after}`).join("\n");
    const ok = await showConfirm(
      `Add these quantities to OrderStream for PO ${po.trim()}?${prior ? `\n\nThis PO was already added on ${new Date(prior.at).toLocaleDateString()}. Adding again will double-count.` : ""}\n\n${list}`,
      { title: "Add to OrderStream inventory", confirmText: "Add to OrderStream", variant: prior ? "error" : undefined }
    );
    if (!ok) return;
    setBusy(true);
    try {
      const d = await (async () => {
        const items = todo.map((r) => ({ vendor_sku: r.sku, qty: Number(r.qty) }));
        const { data, error } = await supabase.functions.invoke("orderstream-bridge", { body: { action: "receive", dry: false, items } });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        return data;
      })();
      const applied = d.plan || [];
      if (applied.length) {
        await supabase.from("orderstream_receipts").insert(applied.map((p) => ({ po_number: po.trim(), vendor_sku: p.sku, qty: p.add, before_qty: p.before, after_qty: p.after })));
        await recordConnections(supabase, applied.map((p) => p.sku), "orderstream");
      }
      setResult({ applied, missing: d.missing || [] });
      setPreviewed(false);
    } catch (e) { showAlert("Update failed: " + (e?.message || e) + "\nCheck the quantities on OrderStream before trying again.", { variant: "error" }); } finally { setBusy(false); }
  }

  const ready = chosen().filter((r) => r.after != null && !r.problem).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b p-3">
          <h2 className="font-semibold">Add QuickBooks PO to OrderStream inventory</h2>
          <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="space-y-3 overflow-auto p-3 text-sm">
          <p className="text-gray-600">Enter the vendor PO number. Its quantities are added on top of what OrderStream already has. You will see before and after numbers and confirm before anything is sent.</p>
          <div className="flex items-center gap-2">
            <input value={po} onChange={(e) => setPo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && lookup()} placeholder="QB PO number" className="w-48 rounded border px-2 py-1" />
            <button onClick={lookup} disabled={busy || !po.trim()} className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50">Look up</button>
          </div>
          {prior && <div className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-800">This PO was already added to OrderStream on {new Date(prior.at).toLocaleDateString()} ({prior.lines} line{prior.lines === 1 ? "" : "s"}).</div>}
          {rows && (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-gray-500"><th /><th>QB item</th><th>OrderStream SKU</th><th>Qty in</th><th>Now</th><th>After</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key} className="border-b">
                    <td><input type="checkbox" checked={r.use} onChange={(e) => edit(i, { use: e.target.checked })} /></td>
                    <td>{r.item}</td>
                    <td><input value={r.sku} onChange={(e) => edit(i, { sku: e.target.value })} className="w-44 rounded border px-1 py-0.5" /></td>
                    <td><input value={r.qty} onChange={(e) => edit(i, { qty: e.target.value.replace(/[^0-9]/g, "") })} className="w-16 rounded border px-1 py-0.5" /></td>
                    <td>{r.before ?? ""}</td>
                    <td className="font-medium">{r.after ?? ""}</td>
                    <td className="text-amber-700">{r.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result && (
            <div className="rounded border bg-gray-50 p-2 text-xs">
              <div className="font-medium">Added {result.applied.length} SKU(s) to OrderStream.</div>
              {result.applied.map((p) => <div key={p.sku}>{p.sku}: {p.before} to {p.after}</div>)}
              {result.missing.map((m) => <div key={m.sku} className="text-red-700">{m.sku}: {m.reason}</div>)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t p-3">
          <span className="text-xs text-gray-500">{previewed ? `${ready} line(s) ready` : ""}</span>
          <button onClick={preview} disabled={busy || !rows} className="ml-auto rounded border px-3 py-1 disabled:opacity-50">{busy ? "Working..." : "Preview"}</button>
          <button onClick={send} disabled={busy || !previewed || !ready} className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50">Add to OrderStream</button>
        </div>
      </div>
    </div>
  );
}
