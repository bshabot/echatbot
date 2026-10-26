import { useRef, useState } from "react";
import { portal } from "./api.js";
import { emptyRow, isBlank, toPayload, validateRow } from "./fields.js";
import ItemForm from "./ItemForm.jsx";

const MAX_ROWS = 100;

// Simple entry for now: one card per item. The full
// Excel-style grid replaces this once the Bulk Add grid is made injectable.
export default function AddItems({ info, onSubmitted, onSessionLost }) {
  const [rows, setRows] = useState(() => [emptyRow(info)]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const cardRefs = useRef([]);

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
      <p className="text-sm text-gray-600">
        Add each item below. Fields marked * are required. Use <span className="font-medium">Duplicate</span> to start a similar item from one you already filled in.
      </p>

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
