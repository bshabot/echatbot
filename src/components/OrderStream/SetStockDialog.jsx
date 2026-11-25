import { useState } from "react";
import { X } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import { useAlert } from "../Alerts/AlertContext";
import { recordConnections } from "../../utils/sampleConnections";

// A stock count: paste SKU + quantity pairs and SET each SKU's current quantity on OrderStream to that number.
// (Receive-from-PO ADDS to Next Available; this replaces the current quantity.)
// Nothing is sent until you have seen current vs new numbers and confirmed. SKUs that are not on the OrderStream grid
// are never created: they are listed, with close matches you can click (e.g. N1587NK-JUN -> N1587NK-JUNE).

// Accepts one pair per line, "SKU<tab or spaces>qty", and also several pairs side by side as pasted from Excel.
// A SKU with no number after it (blank cell) is skipped.
export function parseCount(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.split(/[\t ]+/).map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < t.length; i++) {
      if (/[A-Za-z]/.test(t[i]) && /^\d+$/.test(t[i + 1] || "")) { out.push({ sku: t[i], qty: t[i + 1] }); i++; }
    }
  }
  return out;
}

export default function SetStockDialog({ onClose }) {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm } = useAlert();
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null); // { sku, qty, use, before, after, problem, suggest }
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [result, setResult] = useState(null);

  const edit = (i, patch) => { setPreviewed(false); setResult(null); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, before: null, after: null, problem: "", suggest: [] } : r))); };

  function read() {
    const pairs = parseCount(text);
    if (!pairs.length) return showAlert("No SKU + quantity pairs found. Paste lines like: N1587NK-JAN 31", { variant: "error" });
    const seen = new Set(); let dup = 0;
    const list = pairs.filter((p) => { const k = p.sku.toLowerCase(); if (seen.has(k)) { dup++; return false; } seen.add(k); return true; });
    setRows(list.map((p) => ({ ...p, use: true, before: null, after: null, problem: "", suggest: [] })));
    setPreviewed(false); setResult(null);
    if (dup) showAlert(`${dup} repeated SKU(s) were skipped (the first one is kept).`, { variant: "warning" });
  }

  const chosen = () => (rows || []).filter((r) => r.use && r.sku.trim() && /^\d+$/.test(String(r.qty)));

  async function call(items, dry) {
    const { data, error } = await supabase.functions.invoke("orderstream-bridge", { body: { action: "setstock", dry, items } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function preview() {
    const list = chosen();
    if (!list.length) return showAlert("Nothing selected. Each line needs a SKU and a whole-number quantity.", { variant: "error" });
    if (list.length > 80) return showAlert("Do 80 SKUs or fewer at a time.", { variant: "error" });
    setBusy(true); setResult(null);
    try {
      const d = await call(list.map((r) => ({ vendor_sku: r.sku.trim(), qty: Number(r.qty) })), true);
      const by = Object.fromEntries((d.plan || []).map((p) => [p.sku, p]));
      const miss = Object.fromEntries((d.missing || []).map((m) => [m.sku, m]));
      setRows((rs) => rs.map((r) => {
        const k = r.sku.trim();
        if (!r.use) return r;
        return { ...r, before: by[k]?.before ?? null, after: by[k]?.after ?? null, problem: miss[k]?.reason || "", suggest: miss[k]?.suggest || [] };
      }));
      setPreviewed(true);
    } catch (e) { showAlert("Preview failed: " + (e?.message || e), { variant: "error" }); } finally { setBusy(false); }
  }

  const changes = () => chosen().filter((r) => r.after != null && !r.problem && r.before !== r.after);

  async function send() {
    const todo = changes();
    if (!todo.length) return showAlert("No lines need changing.", { variant: "error" });
    const list = todo.map((r) => `${r.sku.trim()}   ${r.before} -> ${r.after}`).join("\n");
    const ok = await showConfirm(
      `Set the CURRENT quantity on OrderStream for ${todo.length} SKU(s)? This replaces the numbers below.\n\n${list}`,
      { title: "Set OrderStream quantities", confirmText: "Set quantities" }
    );
    if (!ok) return;
    setBusy(true);
    try {
      const d = await call(todo.map((r) => ({ vendor_sku: r.sku.trim(), qty: Number(r.after) })), false);
      const applied = d.plan || [];
      if (applied.length) await recordConnections(supabase, applied.map((p) => p.sku), "orderstream");
      setResult({ applied, missing: d.missing || [] });
      setPreviewed(false);
    } catch (e) { showAlert("Update failed: " + (e?.message || e) + "\nCheck the quantities on OrderStream before trying again.", { variant: "error" }); } finally { setBusy(false); }
  }

  const same = chosen().filter((r) => r.after != null && !r.problem && r.before === r.after).length;
  const bad = (rows || []).filter((r) => r.use && r.problem).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b p-3">
          <h2 className="font-semibold">Set OrderStream stock from a count</h2>
          <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="space-y-3 overflow-auto p-3 text-sm">
          <p className="text-gray-600">Paste your count (SKU then quantity, one per line or side by side from Excel). Each SKU's current quantity on OrderStream is set to your number, replacing what is there. SKUs not on OrderStream are listed and never created. You will see current vs new and confirm before anything is sent.</p>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setRows(null); setPreviewed(false); setResult(null); }} rows={6} placeholder={"N1587NK-JAN\t31\nN1587NK-FEB\t26"} className="w-full rounded border p-2 font-mono text-xs" />
          <div><button onClick={read} disabled={busy || !text.trim()} className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50">Read list</button></div>
          {rows && (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-gray-500"><th /><th>OrderStream SKU</th><th>Count</th><th>Now</th><th>Change</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={"border-b " + (r.use ? "" : "opacity-50")}>
                    <td><input type="checkbox" checked={r.use} onChange={(e) => edit(i, { use: e.target.checked })} /></td>
                    <td><input value={r.sku} onChange={(e) => edit(i, { sku: e.target.value })} className="w-48 rounded border px-1 py-0.5" /></td>
                    <td><input value={r.qty} onChange={(e) => edit(i, { qty: e.target.value.replace(/[^0-9]/g, "") })} className="w-16 rounded border px-1 py-0.5" /></td>
                    <td>{r.before ?? ""}</td>
                    <td className="font-medium">{r.after == null ? "" : r.before === r.after ? "no change" : `${r.before} -> ${r.after}`}</td>
                    <td className="text-amber-700">
                      {r.problem}
                      {(r.suggest || []).map((s) => <button key={s} onClick={() => edit(i, { sku: s })} className="ml-1 rounded border border-amber-400 px-1 text-amber-800 hover:bg-amber-50">use {s}</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result && (
            <div className="rounded border bg-gray-50 p-2 text-xs">
              <div className="font-medium">Set {result.applied.filter((p) => p.before !== p.after).length} SKU(s) on OrderStream and re-read the grid to confirm.</div>
              {result.applied.filter((p) => p.before !== p.after).map((p) => <div key={p.sku}>{p.sku}: {p.before} to {p.after}</div>)}
              {result.missing.map((m) => <div key={m.sku} className="text-red-700">{m.sku}: {m.reason}</div>)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t p-3">
          <span className="text-xs text-gray-500">{previewed ? `${changes().length} to change, ${same} already match, ${bad} need attention` : ""}</span>
          <button onClick={preview} disabled={busy || !rows} className="ml-auto rounded border px-3 py-1 disabled:opacity-50">{busy ? "Working..." : "Preview"}</button>
          <button onClick={send} disabled={busy || !previewed || !changes().length} className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50">Set quantities</button>
        </div>
      </div>
    </div>
  );
}
