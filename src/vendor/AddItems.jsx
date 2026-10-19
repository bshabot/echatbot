import { useState } from "react";
import { portal } from "./api.js";
import { emptyRow, isBlank, parsePaste, toPayload } from "./fields.js";
import ItemForm from "./ItemForm.jsx";

const MAX_ROWS = 100;

// Simple entry for now: one card per item, plus paste-from-Excel. The full
// Excel-style grid replaces this once the Bulk Add grid is made injectable.
export default function AddItems({ info, onSubmitted, onSessionLost }) {
  const [rows, setRows] = useState(() => [emptyRow(info)]);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const update = (i, row) => setRows((rs) => rs.map((r, idx) => (idx === i ? row : r)));

  const addPasted = () => {
    const parsed = parsePaste(paste, info).slice(0, MAX_ROWS);
    if (!parsed.length) return;
    setRows((rs) => [...rs.filter((r) => !isBlank(r)), ...parsed].slice(0, MAX_ROWS));
    setPaste("");
  };

  const submit = async () => {
    const filled = rows.filter((r) => !isBlank(r));
    if (!filled.length) return setMessage({ type: "error", text: "Add at least one item." });
    if (filled.length > MAX_ROWS) return setMessage({ type: "error", text: `At most ${MAX_ROWS} items per submit.` });
    setBusy(true);
    setMessage(null);
    const res = await portal("submit", { rows: filled.map(toPayload) });
    setBusy(false);
    if (res.status === 401) return onSessionLost();
    if (!res.ok) return setMessage({ type: "error", text: res.message || "Could not submit. Nothing was saved." });
    setRows([emptyRow(info)]);
    onSubmitted(res.result?.count ?? filled.length);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border p-4 space-y-2">
        <div className="text-sm font-medium text-gray-800">Paste from Excel</div>
        <p className="text-xs text-gray-500">
          Columns in this order, tab separated, header row optional: style number, manufacturer code, type, metal, karat,
          color, weight, length, width, height, plating, sells as, back type, detail, description.
        </p>
        <textarea className="input text-sm h-20" value={paste} onChange={(e) => setPaste(e.target.value)} />
        <button type="button" onClick={addPasted} disabled={!paste.trim()} className="px-3 py-1.5 text-sm rounded-lg border disabled:opacity-50">
          Add pasted rows
        </button>
      </div>

      {rows.map((row, i) => (
        <div key={i} className="bg-white rounded-lg border p-4">
          <div className="flex justify-between mb-3">
            <div className="text-sm font-medium text-gray-800">Item {i + 1}</div>
            {rows.length > 1 && (
              <button type="button" className="text-sm text-red-600" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>
                Remove
              </button>
            )}
          </div>
          <ItemForm row={row} info={info} onChange={(r) => update(i, r)} />
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={rows.length >= MAX_ROWS}
          onClick={() => setRows((rs) => [...rs, emptyRow(info)])}
          className="px-3 py-2 text-sm rounded-lg border"
        >
          + Add item
        </button>
        <button type="button" onClick={submit} disabled={busy} className="px-4 py-2 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50">
          {busy ? "Submitting…" : "Submit for review"}
        </button>
      </div>
      {message && <p className={`text-sm ${message.type === "error" ? "text-red-600" : "text-green-700"}`}>{message.text}</p>}
    </div>
  );
}
