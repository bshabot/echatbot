import { useMemo, useState } from "react";
import { X, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { useSupabase } from "../SupaBaseProvider";
import { useAlert } from "../Alerts/AlertContext";
import { recordConnections, recordSkus } from "../../utils/sampleConnections";

// Reads the Signet "new dropship SKUs" table (pasted from Outlook, or an .xlsx/.csv) and creates each
// Model_Num as an OrderStream inventory SKU. Unit cost comes from running_line_skus by the 8-digit SKU.
const CHUNK = 10;
const mdy = (d = new Date()) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

export function parseSkuSheet(text) {
  const tokens = String(text).split(/[\t\r\n]+/).map((s) => s.trim());
  const recs = [];
  let cur = null;
  for (const t of tokens) {
    if (/^\d{8}$/.test(t)) { cur = { sku: t, toks: [] }; recs.push(cur); } else if (cur && t) cur.toks.push(t);
  }
  return recs.map((r) => {
    const i = r.toks.findIndex((t) => /^\d{5}$/.test(t)); // vendor number (30374); Model_Num follows
    const model = i >= 0 ? r.toks[i + 1] || "" : "";
    const date = r.toks.find((t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) || "";
    const [m, d, y] = date ? date.split("/") : [];
    return { sku: r.sku, desc: r.toks[0] || "", model, avail: date ? `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}` : "" };
  });
}

export default function SkuSheetImport({ onClose }) {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm } = useAlert();
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null); // preview rows
  const [qty, setQty] = useState(30);
  const [availIso, setAvailIso] = useState(""); // required: one available date for every item
  const availDate = availIso ? availIso.slice(5, 7) + "/" + availIso.slice(8, 10) + "/" + availIso.slice(0, 4) : "";
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);

  const ready = useMemo(() => (rows || []).filter((r) => r.model && Number(r.cost) > 0), [rows]);

  async function readFile(f) {
    if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
    setText(grid.map((r) => r.join("\t")).join("\n"));
  }

  async function preview() {
    setResults(null);
    const parsed = parseSkuSheet(text);
    if (!parsed.length) return showAlert("No rows found. Each row needs the 8-digit SKU, and the Model_Num after the vendor number.", { variant: "error" });
    setBusy(true);
    try {
      const { data, error } = await supabase.from("running_line_skus").select("sku_number,vendor_style_number,merchant_unit_cost").in("sku_number", parsed.map((p) => p.sku));
      if (error) throw error;
      const by = Object.fromEntries((data || []).map((d) => [d.sku_number, d]));
      setRows(parsed.map((p) => {
        const k = by[p.sku];
        const cost = k?.merchant_unit_cost != null ? Number(k.merchant_unit_cost).toFixed(2) : "";
        const warn = !k ? "Not in PLM: enter the cost" : k.vendor_style_number && k.vendor_style_number !== p.model ? `PLM style is ${k.vendor_style_number}` : "";
        return { ...p, cost, warn, use: true };
      }));
    } catch (e) { showAlert("Lookup failed: " + e.message, { variant: "error" }); } finally { setBusy(false); }
  }

  const edit = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function run(dry) {
    const todo = ready.filter((r) => r.use);
    if (!todo.length) return showAlert("Nothing to create. Each row needs a Model_Num and a cost.", { variant: "error" });
    if (!availDate) return showAlert("Pick the available date first. It is applied to every item.", { variant: "error" });
    if (!dry && !(await showConfirm(`Create ${todo.length} SKU(s) on OrderStream, quantity ${qty} each, ships in 0-3 business days?`, { title: "Create in OrderStream", confirmText: "Create" }))) return;
    setBusy(true); setResults(null);
    const out = [];
    try {
      for (let i = 0; i < todo.length; i += CHUNK) {
        const items = todo.slice(i, i + CHUNK).map((r) => ({ vendor_sku: r.model, merchant_sku: r.sku, unit_cost: r.cost, qty: Number(qty) || 0, avail_date: availDate }));
        const { data, error } = await supabase.functions.invoke("orderstream-bridge", { body: { action: "addsku", dry, continueOnError: true, items } });
        if (error || data?.error) { out.push({ vendor_sku: "(batch)", error: error?.message || data.error }); break; }
        out.push(...data);
      }
    } catch (e) { out.push({ vendor_sku: "(batch)", error: e.message }); }
    if (!dry) {
      const okSkus = new Set(out.filter((o) => o.result?.done || o.result?.skipped).map((o) => o.vendor_sku));
      await recordConnections(supabase, [...okSkus], "orderstream");
      await recordSkus(supabase, todo.filter((r) => okSkus.has(r.model)).map((r) => ({ vendor_sku: r.model, merchant_sku: r.sku, unit_cost: r.cost })));
    }
    setResults({ dry, out });
    setBusy(false);
  }

  const tally = results && {
    done: results.out.filter((o) => o.result?.done || o.result?.dry).length,
    skipped: results.out.filter((o) => o.result?.skipped).length,
    errs: results.out.filter((o) => o.error),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b p-3">
          <h2 className="font-semibold">Import SKU sheet to OrderStream</h2>
          <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="space-y-3 overflow-auto p-3 text-sm">
          <p className="text-gray-600">Paste the table from the Signet email (or choose a file). Each Model_Num is created as the Vendor SKU, with the 8-digit SKU as the Merchant SKU. Cost comes from the PLM.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Paste the rows here" className="w-full rounded border p-2 font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-1 hover:bg-gray-50">
              <Upload size={14} /> Choose .xlsx / .csv
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
            </label>
            <label className="inline-flex items-center gap-1 font-medium">Available date (all items) <input type="date" value={availIso} onChange={(e) => setAvailIso(e.target.value)} className={`rounded border px-1 py-0.5 ${availIso ? "" : "border-red-400"}`} /></label>
            <label className="inline-flex items-center gap-1">Quantity each <input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className="w-20 rounded border px-1 py-0.5" /></label>
            <button onClick={preview} disabled={busy || !text.trim()} className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50">Preview</button>
          </div>
          {rows && (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-gray-500"><th /><th>SKU</th><th>Model_Num (Vendor SKU)</th><th>Cost</th><th>Available</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.sku} className="border-b">
                    <td><input type="checkbox" checked={r.use} onChange={(e) => edit(i, { use: e.target.checked })} /></td>
                    <td>{r.sku}</td>
                    <td><input value={r.model} onChange={(e) => edit(i, { model: e.target.value.trim() })} className="w-52 rounded border px-1 py-0.5" /></td>
                    <td><input value={r.cost} onChange={(e) => edit(i, { cost: e.target.value.replace(/[^0-9.]/g, "") })} className="w-20 rounded border px-1 py-0.5" /></td>
                    <td>{availDate || <span className="text-red-600">pick a date</span>}</td>
                    <td className="text-amber-700">{r.warn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {results && (
            <div className="rounded border bg-gray-50 p-2 text-xs">
              <div className="font-medium">{results.dry ? "Dry run (nothing created)" : "Done"}: {tally.done} {results.dry ? "ready" : "created"}, {tally.skipped} already there, {tally.errs.length} error(s).</div>
              {tally.errs.map((o, i) => <div key={i} className="text-red-700">{o.vendor_sku}: {o.error}</div>)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t p-3">
          <span className="text-xs text-gray-500">{rows ? `${ready.filter((r) => r.use).length} of ${rows.length} ready` : ""}</span>
          <button onClick={() => run(true)} disabled={busy || !rows || !availDate} className="ml-auto rounded border px-3 py-1 disabled:opacity-50">Dry run</button>
          <button onClick={() => run(false)} disabled={busy || !rows || !availDate} className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50">{busy ? "Working..." : "Create in OrderStream"}</button>
        </div>
      </div>
    </div>
  );
}
