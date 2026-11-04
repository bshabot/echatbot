import { useRef, useState } from "react";
import { portal } from "./api.js";
import { emptyRow, isBlank, toPayload, validateRow } from "./fields.js";
import ItemForm from "./ItemForm.jsx";
import { downloadTemplate, parseUpload } from "./bulkUpload.js";

const MAX_ROWS = 100;

// Simple entry for now: one card per item. The full
// Excel-style grid replaces this once the Bulk Add grid is made injectable.
export default function AddItems({ info, onSubmitted, onSessionLost }) {
  const [rows, setRows] = useState(() => [emptyRow(info)]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const cardRefs = useRef([]);
  const fileInput = useRef(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);

  const update = (i, next) => setRows((rs) => rs.map((r, idx) => (idx === i ? (typeof next === "function" ? next(r) : next) : r)));
  const filled = rows.filter((r) => !isBlank(r));
  const blankPayload = JSON.stringify(toPayload(emptyRow(info)));
  const untouched = (r) => JSON.stringify(toPayload(r)) === blankPayload;

  // Copy an item as a starting point; the style number is cleared so it can't be sent twice by accident.
  const duplicate = (i) =>
    setRows((rs) => {
      if (rs.length >= MAX_ROWS) return rs;
      const copy = { ...rs[i], manufacturer_code: "", files: [], stones: (rs[i].stones || []).map((s) => ({ ...s })) };
      return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
    });

  const remove = (i) => {
    // Files already uploaded for this item are deleted with it.
    (rows[i]?.files || []).filter((f) => f.status === "done" && f.id && !f.attached).forEach((f) => portal("fileRemove", { id: f.id }));
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [emptyRow(info)]));
  };

  // Many items at once: fill in the Excel template, upload it, review the cards, then submit as usual.
  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMessage(null);
    setNotes([]);
    if (file.size > 5 * 1024 * 1024) return setMessage({ type: "error", text: "That file is too large (5 MB max)." });
    setLoading(true);
    try {
      const keep = rows.filter((r) => !untouched(r));
      const { rows: loaded, notes: n } = await parseUpload(file, info, MAX_ROWS - keep.length);
      if (!loaded.length) return setMessage({ type: "error", text: n[0] || "No items found in that file." });
      setRows([...keep, ...loaded]);
      setNotes(n);
      setShowErrors(true);
      setMessage({ type: "ok", text: `Loaded ${loaded.length} item${loaded.length === 1 ? "" : "s"}. Check them below, then submit.` });
    } catch {
      setMessage({ type: "error", text: "Could not read that file. Use the template (.xlsx or .csv)." });
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    setMessage(null);
    if (!filled.length) {
      setShowErrors(true);
      return setMessage({ type: "error", text: "Fill in at least one item (manufacturer code and weight)." });
    }
    const firstBad = rows.findIndex((r) => !isBlank(r) && Object.keys(validateRow(r)).length > 0);
    if (firstBad >= 0) {
      setShowErrors(true);
      cardRefs.current[firstBad]?.scrollIntoView({ behavior: "smooth", block: "center" });
      return setMessage({ type: "error", text: "Some items need attention. They are highlighted below." });
    }
    // A row with only some fields typed counts as unfinished, not blank
    const half = rows.findIndex((r) => isBlank(r) && !untouched(r));
    if (half >= 0) {
      setShowErrors(true);
      cardRefs.current[half]?.scrollIntoView({ behavior: "smooth", block: "center" });
      return setMessage({ type: "error", text: `Item ${half + 1} needs a manufacturer code and weight, or remove it.` });
    }
    setBusy(true);
    const res = await portal("submit", { rows: filled.map(toPayload) });
    setBusy(false);
    if (res.status === 401) return onSessionLost();
    if (!res.ok) return setMessage({ type: "error", text: res.message || "Could not submit. Nothing was saved." });
    setRows([emptyRow(info)]);
    setShowErrors(false);
    onSubmitted(res.result?.count ?? filled.length);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3">
        <div className="flex-1 min-w-[16rem] text-sm text-gray-600">
          Add each item below, or add many at once with a spreadsheet. Fields marked * are required.
        </div>
        <button type="button" onClick={() => downloadTemplate(info)} className="px-3 py-1.5 text-sm rounded-lg border bg-white">
          Download template
        </button>
        <button type="button" disabled={loading} onClick={() => fileInput.current?.click()} className="px-3 py-1.5 text-sm rounded-lg border border-chabot-gold text-chabot-gold bg-white disabled:opacity-50">
          {loading ? "Reading…" : "Upload filled template"}
        </button>
        <input ref={fileInput} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onUpload} />
      </div>
      {notes.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900">
          <div className="font-medium mb-1">Please check these:</div>
          <ul className="list-disc pl-5 space-y-0.5">
            {notes.slice(0, 12).map((n, i) => <li key={i}>{n}</li>)}
            {notes.length > 12 && <li>and {notes.length - 12} more</li>}
          </ul>
        </div>
      )}

      {rows.map((row, i) => (
        <div key={i} ref={(el) => (cardRefs.current[i] = el)} className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold text-gray-800">
              Item {i + 1}
              {row.manufacturer_code.trim() && <span className="ml-2 font-normal text-gray-500">{row.manufacturer_code.trim()}</span>}
            </div>
            <div className="flex gap-4 text-sm">
              <button type="button" className="text-chabot-gold disabled:opacity-40" disabled={rows.length >= MAX_ROWS} onClick={() => duplicate(i)}>
                Duplicate
              </button>
              {(rows.length > 1 || !isBlank(row)) && (
                <button type="button" className="text-red-600" onClick={() => remove(i)}>
                  Remove
                </button>
              )}
            </div>
          </div>
          <ItemForm
            row={row}
            info={info}
            onChange={(r) => update(i, r)}
            onSessionLost={onSessionLost}
            errors={validateRow(row)}
            showErrors={showErrors && !untouched(row)}
          />
        </div>
      ))}

      <div className="sticky bottom-0 -mx-1 px-1 py-3 bg-gray-50/95 backdrop-blur border-t flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={rows.length >= MAX_ROWS}
          onClick={() => {
            setRows((rs) => [...rs, emptyRow(info)]);
          }}
          className="px-3 py-2 text-sm rounded-lg border bg-white"
        >
          + Add another item
        </button>
        <button type="button" onClick={submit} disabled={busy} className="px-4 py-2 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50">
          {busy ? "Submitting…" : `Submit ${filled.length || ""} ${filled.length === 1 ? "item" : "items"} for review`.replace("  ", " ")}
        </button>
        {message && <p className={`text-sm ${message.type === "error" ? "text-red-600" : "text-green-700"}`}>{message.text}</p>}
      </div>
    </div>
  );
}
