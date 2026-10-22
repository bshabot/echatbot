import { useCallback, useEffect, useState } from "react";
import { portal } from "./api.js";
import { fromData, toPayload } from "./fields.js";
import ItemForm from "./ItemForm.jsx";

const STATUS = {
  pending: { label: "Pending", cls: "bg-yellow-100 text-yellow-800" },
  approving: { label: "Pending", cls: "bg-yellow-100 text-yellow-800" },
  approved: { label: "Approved", cls: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", cls: "bg-red-100 text-red-800" },
  needs_changes: { label: "Needs changes", cls: "bg-orange-100 text-orange-800" },
};

const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "");

// Plain text only: every value is rendered as a React text node, never as HTML.
export default function MySubmissions({ info, onSessionLost }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, row }
  const [correcting, setCorrecting] = useState(null); // { id, note }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await portal("mine");
    if (res.status === 401) return onSessionLost();
    if (!res.ok) return setError("Could not load your submissions.");
    setError(null);
    setRows(res.rows ?? []);
  }, [onSessionLost]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action, payload) => {
    setBusy(true);
    const res = await portal(action, payload);
    setBusy(false);
    if (res.status === 401) return onSessionLost();
    if (!res.ok) return setError(res.message || "That change could not be saved.");
    setEditing(null);
    setCorrecting(null);
    await load();
  };

  if (rows === null) return <p className="text-sm text-gray-500">{error || "Loading…"}</p>;
  if (!rows.length) return <p className="text-sm text-gray-500">Nothing submitted yet.</p>;

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows.map((r) => {
        const st = STATUS[r.status] ?? { label: r.status, cls: "bg-gray-100 text-gray-700" };
        const d = r.data || {};
        const open = ["pending", "rejected", "needs_changes"].includes(r.status);
        return (
          <div key={r.id} className="bg-white rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="font-medium text-gray-900">{d.style_number}</div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
              <div className="text-sm text-gray-500">
                {[d.metal_type, d.karat, d.weight ? `${d.weight} g` : null].filter(Boolean).join(" · ")}
              </div>
              <div className="text-xs text-gray-400 ml-auto">
                Submitted {fmt(r.createdAt)}
                {r.version > 1 ? ` · edited (v${r.version})` : ""}
              </div>
            </div>

            {r.reviewNote && (
              <p className="mt-2 text-sm bg-gray-50 border rounded p-2">
                <span className="font-medium">Note from E. Chabot: </span>
                {r.reviewNote}
              </p>
            )}
            {r.correctionNote && <p className="mt-2 text-sm text-gray-600">Your correction request: {r.correctionNote}</p>}

            {editing?.id === r.id ? (
              <div className="mt-4 space-y-3">
                <ItemForm row={editing.row} info={info} onChange={(row) => setEditing({ id: r.id, row })} />
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50"
                    onClick={() => run("update", { id: r.id, data: toPayload(editing.row) })}
                  >
                    {r.status === "pending" ? "Save changes" : "Save and resubmit"}
                  </button>
                  <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : correcting?.id === r.id ? (
              <div className="mt-3 space-y-2">
                <textarea
                  className="input text-sm h-20"
                  maxLength={1000}
                  placeholder="What should be corrected?"
                  value={correcting.note}
                  onChange={(e) => setCorrecting({ id: r.id, note: e.target.value })}
                />
                <div className="flex gap-2">
                  <button
                    disabled={busy || !correcting.note.trim()}
                    className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50"
                    onClick={() => run("correction", { id: r.id, note: correcting.note })}
                  >
                    Send request
                  </button>
                  <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setCorrecting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex gap-3 text-sm">
                {open && (
                  <button className="text-chabot-gold" onClick={() => setEditing({ id: r.id, row: fromData(d) })}>
                    {r.status === "pending" ? "Edit" : "Correct and resubmit"}
                  </button>
                )}
                {r.status === "pending" && (
                  <button className="text-red-600" onClick={() => run("withdraw", { id: r.id })}>
                    Withdraw
                  </button>
                )}
                {r.status === "approved" && (
                  <button className="text-chabot-gold" onClick={() => setCorrecting({ id: r.id, note: "" })}>
                    Request a correction
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
