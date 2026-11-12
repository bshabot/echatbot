import React, { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import Loading from "../components/Loading";

// Pad stock, kept simple: type the quantity you have once. "Left" = that count minus the pad
// units on every Signet PO dated on/after the day you entered it (see pad_stock_status).
// Typing a new count re-baselines from today (use it after a recount or a delivery).
const fmt = (n) => Number(n ?? 0).toLocaleString();
// "How long will it last" at the recent usage rate (weeks_left comes from the view).
function lasts(w) {
  if (w == null) return "—";
  w = Number(w);
  if (w < 1) return "< 1 week";
  if (w < 13) return `${Math.round(w)} wk${Math.round(w) === 1 ? "" : "s"}`;
  if (w < 104) return `${Math.round(w / 4.345)} months`;
  return "2+ years";
}

// ---- Upload sheet: link items (SKUs) to pads. Existing links are never overwritten. ----
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const SKU_HEADS = ["sku", "skunumber", "item", "itemnumber", "signetsku", "sku#"];
const PAD_HEADS = ["pad", "padno", "padnumber", "padnum", "pad#"];
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function parseSheet(grid) {
  // Find the header row (first 10 rows); fall back to col A = SKU, col B = PAD.
  let hr = -1, skuCol = 0, padCol = 1, descCol = -1, styleCol = -1;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const h = (grid[r] || []).map(norm);
    const sc = h.findIndex((x) => SKU_HEADS.includes(x));
    const pc = h.findIndex((x) => PAD_HEADS.includes(x));
    if (sc >= 0 && pc >= 0) {
      hr = r; skuCol = sc; padCol = pc;
      descCol = h.findIndex((x) => x === "paddescription" || x === "paddescriptionoptional");
      styleCol = h.findIndex((x) => x === "vendorstyle" || x === "style");
      break;
    }
  }
  const out = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const sku = String(row[skuCol] ?? "").trim();
    const pad = String(row[padCol] ?? "").split("|")[0].trim().toUpperCase();
    if (!sku && !pad) continue;
    out.push({
      sku, pad,
      desc: descCol >= 0 ? String(row[descCol] ?? "").trim() : "",
      style: styleCol >= 0 ? String(row[styleCol] ?? "").trim() : "",
    });
  }
  return out;
}

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["SKU", "PAD No", "PAD Description (optional)"],
    ["20632359", "NPP-135GP", "MINI NP RING FLAP"],
  ]);
  ws["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 34 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PAD by SKU");
  XLSX.writeFile(wb, "pad_upload_template.xlsx");
}

export default function PadStock() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [drafts, setDrafts] = useState({}); // pad_no -> typed-but-unsaved count
  const [saving, setSaving] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (supabase) refresh();
  }, [supabase]);

  async function refresh(silent = false) {
    if (!silent) setLoading(true);
    const { data, error } = await supabase.from("pad_stock_status").select("*");
    if (error) showMessage(error.message, "error");
    setRows(data ?? []);
    setLoading(false);
  }

  const savedText = (r) => (r.counted_at ? String(r.counted) : "");
  const isChanged = (r) => drafts[r.pad_no] !== undefined && drafts[r.pad_no] !== savedText(r) && drafts[r.pad_no] !== "";

  async function saveCount(row) {
    const raw = drafts[row.pad_no];
    if (raw === undefined || raw === "") return;
    const value = Math.max(0, parseInt(raw, 10) || 0);
    setSaving(row.pad_no);
    const { error } = await supabase
      .from("pad_inventory")
      .update({ on_hand: value, counted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("pad_no", row.pad_no);
    setSaving(null);
    if (error) return showMessage(error.message, "error");
    setDrafts(({ [row.pad_no]: _drop, ...rest }) => rest);
    await refresh(true); // update the numbers in place, no loading flash
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
      const parsed = parseSheet(grid);

      const bad = [], noPad = [], seen = new Set(), clean = [];
      for (const r of parsed) {
        if (!r.sku || !r.pad) { bad.push(r); continue; }
        if (r.pad === "NPP-000" || r.pad === "NO PAD REQUIRED") { noPad.push(r); continue; }
        if (seen.has(r.sku)) continue; // duplicate row in the sheet: first one wins
        seen.add(r.sku);
        clean.push(r);
      }

      // Which SKUs are already linked? Those are skipped, never overwritten.
      const existing = new Set();
      for (const part of chunk(clean.map((r) => r.sku), 200)) {
        const { data, error } = await supabase.from("sku_pad_map").select("sku_number").in("sku_number", part);
        if (error) throw error;
        (data ?? []).forEach((d) => existing.add(d.sku_number));
      }
      const toAdd = clean.filter((r) => !existing.has(r.sku));

      // Create any pad numbers we haven't seen yet (ignore ones that exist).
      const padRows = [...new Map(toAdd.map((r) => [r.pad, { pad_no: r.pad, description: r.desc || null }])).values()];
      let newPads = 0;
      if (padRows.length) {
        const known = new Set((rows ?? []).map((r) => r.pad_no));
        newPads = padRows.filter((r) => !known.has(r.pad_no)).length;
        const { error } = await supabase.from("pad_inventory").upsert(padRows, { onConflict: "pad_no", ignoreDuplicates: true });
        if (error) throw error;
      }

      let added = 0;
      for (const part of chunk(toAdd, 200)) {
        const { error } = await supabase.from("sku_pad_map").upsert(
          part.map((r) => ({ sku_number: r.sku, pad_no: r.pad, vendor_style: r.style || null, source: "Upload" })),
          { onConflict: "sku_number", ignoreDuplicates: true }
        );
        if (error) throw error;
        added += part.length;
      }

      setResult({ added, skipped: clean.length - toAdd.length, noPad: noPad.length, bad: bad.length, newPads, file: file.name });
      await refresh();
    } catch (err) {
      showMessage(err.message || "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows
      .filter((r) => !f || `${r.pad_no} ${r.description ?? ""}`.toLowerCase().includes(f))
      .sort((a, b) => {
        const wa = a.weeks_left == null ? Infinity : Number(a.weeks_left);
        const wb = b.weeks_left == null ? Infinity : Number(b.weeks_left);
        return wa - wb || Number(a.remaining) - Number(b.remaining) || a.pad_no.localeCompare(b.pad_no);
      });
  }, [rows, filter]);

  if (loading) return <Loading />;

  return (
    <div className="p-4 max-w-4xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-xl font-semibold">Pad Stock</h1>
        <input
          className="border rounded px-2 py-1 text-sm ml-auto"
          placeholder="Filter pad or description"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={downloadTemplate} className="flex items-center gap-1 px-2 py-1 border rounded text-sm" title="Blank upload sheet">
          <Download size={14} /> Template
        </button>
        <label className={`flex items-center gap-1 px-2 py-1 border rounded text-sm cursor-pointer ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
          <Upload size={14} /> {uploading ? "Uploading…" : "Upload sheet"}
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} />
        </label>
        <button onClick={() => refresh()} className="p-1 border rounded" title="Refresh">
          <RefreshCw size={16} />
        </button>
      </div>
      {result && (
        <div className="mb-3 text-sm border rounded px-3 py-2 bg-gray-50">
          <b>{result.file}:</b> {result.added.toLocaleString()} items linked
          {result.newPads > 0 && `, ${result.newPads} new pad${result.newPads === 1 ? "" : "s"} added`}
          {`, ${result.skipped.toLocaleString()} skipped (already linked)`}
          {result.noPad > 0 && `, ${result.noPad} "no pad required"`}
          {result.bad > 0 && `, ${result.bad} rows missing a SKU or pad`}.
        </div>
      )}
      <p className="text-sm text-gray-500 mb-4">
        Left = what you set, minus pads on POs written since. Lasts about = Left at the last 26 weeks' usage; red means under ~7 weeks. To reset a pad (recount or new delivery), type the new total.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-1">Pad</th>
            <th>Description</th>
            <th className="text-right">Left</th>
            <th className="pl-6">Lasts about</th>
            <th className="pl-6">Set count</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.pad_no} className="border-b">
              <td className="py-1.5 font-medium">{r.pad_no}</td>
              <td>{r.description}</td>
              <td
                className={`text-right text-base font-semibold ${
                  r.counted_at && Number(r.remaining) <= 0 ? "text-red-600" : ""
                }`}
                title={r.counted_at ? `Counted ${fmt(r.counted)} on ${new Date(r.counted_at).toLocaleDateString()}, ${fmt(r.used_since_count)} used on POs since` : "No count entered yet"}
              >
                {r.counted_at ? fmt(r.remaining) : "—"}
              </td>
              <td
                className={`pl-6 ${r.weeks_left != null && Number(r.weeks_left) < 7 ? "text-red-600 font-semibold" : ""}`}
                title={r.weekly_usage ? `Using about ${fmt(r.weekly_usage)} per week (last 26 weeks of POs)` : "No PO usage in the last 26 weeks"}
              >
                {lasts(r.weeks_left)}
                {r.runout_date && Number(r.weeks_left) < 104 && (
                  <span className="text-gray-400 font-normal text-xs ml-2">
                    {new Date(r.runout_date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </td>
              <td className="pl-6">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    className="w-24 border rounded px-1"
                    placeholder="enter"
                    value={drafts[r.pad_no] ?? savedText(r)}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.pad_no]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && isChanged(r)) saveCount(r);
                      if (e.key === "Escape") setDrafts(({ [r.pad_no]: _drop, ...rest }) => rest);
                    }}
                  />
                  {isChanged(r) && (
                    <>
                      <button
                        onClick={() => saveCount(r)}
                        disabled={saving === r.pad_no}
                        className="px-2 py-0.5 rounded bg-blue-600 text-white text-xs disabled:opacity-50"
                      >
                        {saving === r.pad_no ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => setDrafts(({ [r.pad_no]: _drop, ...rest }) => rest)}
                        className="text-xs text-gray-500 underline"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="text-sm text-gray-500 mt-4">No pads match.</p>}
    </div>
  );
}
