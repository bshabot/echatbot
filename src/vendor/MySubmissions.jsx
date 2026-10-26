import { useCallback, useEffect, useMemo, useState } from "react";
import { portal } from "./api.js";
import { fromData, toPayload, validateRow } from "./fields.js";
import ItemForm from "./ItemForm.jsx";

const STATUS = {
  pending: { label: "Pending review", cls: "bg-yellow-100 text-yellow-800" },
  approving: { label: "Pending review", cls: "bg-yellow-100 text-yellow-800" },
  approved: { label: "Approved", cls: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", cls: "bg-red-100 text-red-800" },
  needs_changes: { label: "Needs changes", cls: "bg-orange-100 text-orange-800" },
};

// Filter chips: key -> which statuses it covers
const FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "pending", label: "Pending", match: (s) => s === "pending" || s === "approving" },
  { key: "attention", label: "Needs attention", match: (s) => s === "needs_changes" || s === "rejected" },
  { key: "approved", label: "Approved", match: (s) => s === "approved" },
];

const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "");
const btn = "px-3 py-1.5 text-sm rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50";
const primary = "px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold disabled:opacity-50";

function Detail({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-800">{String(value)}</dd>
    </div>
  );
}

// Plain text only: every value is rendered as a React text node, never as HTML.
export default function MySubmissions({ info, onSessionLost }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, row, show }
  const [correcting, setCorrecting] = useState(null); // { id, note }
  const [confirming, setConfirming] = useState(null); // id being withdrawn
  const [expanded, setExpanded] = useState(() => new Set());
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
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
    setError(null);
    setEditing(null);
    setCorrecting(null);
    setConfirming(null);
    await load();
  };

  const counts = useMemo(() => {
    const c = {};
    for (const f of FILTERS) c[f.key] = (rows ?? []).filter((r) => f.match(r.status)).length;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) => f.match(r.status) && (!needle || String(r.data?.manufacturer_code ?? r.data?.style_number ?? "").toLowerCase().includes(needle))
    );
  }, [rows, filter, q]);

  const toggle = (id) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (rows === null) return <p className="text-sm text-gray-500">{error || "Loading…"}</p>;
  if (!rows.length)
    return (
      <div className="bg-white rounded-lg border p-8 text-center">
        <p className="text-sm text-gray-700">You have not submitted anything yet.</p>
        <p className="text-xs text-gray-500 mt-1">Items you submit on the Add items tab will appear here with their review status.</p>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm rounded-full border ${filter === f.key ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 hover:bg-gray-50"}`}
          >
            {f.label} <span className={filter === f.key ? "opacity-80" : "text-gray-400"}>{counts[f.key]}</span>
          </button>
        ))}
        <input
          className="input !p-1.5 text-sm ml-auto w-full sm:w-56"
          type="search"
          placeholder="Search manufacturer code"
          maxLength={40}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {counts.attention > 0 && filter !== "attention" && (
        <button type="button" className="text-sm text-orange-700 underline" onClick={() => setFilter("attention")}>
          {counts.attention} {counts.attention === 1 ? "item needs" : "items need"} your attention
        </button>
      )}
      {!visible.length && <p className="text-sm text-gray-500">No items match.</p>}

      {visible.map((r) => {
        const st = STATUS[r.status] ?? { label: r.status, cls: "bg-gray-100 text-gray-700" };
        const d = r.data || {};
        const open = ["pending", "rejected", "needs_changes"].includes(r.status);
        const attention = r.status === "needs_changes" || r.status === "rejected";
        const isOpen = expanded.has(r.id);
        const dims = [d.length, d.width, d.height].some(Boolean) ? [d.length, d.width, d.height].map((x) => x ?? "-").join(" x ") + " in" : "";
        const stones = Array.isArray(d.stones) ? d.stones.length : 0;
        return (
          <div key={r.id} className={`bg-white rounded-lg border p-4 ${attention ? "border-orange-300" : ""}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="text-base font-semibold text-gray-900">{d.manufacturer_code || d.style_number}</div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
              <div className="text-xs text-gray-400 ml-auto">
                Submitted {fmt(r.createdAt)}
                {r.version > 1 ? ` · edited (v${r.version})` : ""}
              </div>
            </div>
            <div className="mt-1 text-sm text-gray-600">
              {[d.type, [d.metal_type, d.karat].filter(Boolean).join(" "), d.color, d.weight ? `${d.weight} g` : null, stones ? `${stones} ${stones === 1 ? "stone" : "stones"}` : null]
                .filter(Boolean)
                .join(" · ")}
            </div>

            {r.reviewNote && (
              <p className={`mt-3 text-sm rounded border p-2 ${attention ? "bg-orange-50 border-orange-200" : "bg-gray-50"}`}>
                <span className="font-medium">Note from E. Chabot: </span>
                {r.reviewNote}
              </p>
            )}
            {r.correctionNote && <p className="mt-2 text-sm text-gray-600">Your correction request: {r.correctionNote}</p>}

            {isOpen && editing?.id !== r.id && (
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border-t pt-3">
                <Detail label="Manufacturer code" value={d.manufacturer_code} />
                <Detail label="Plating" value={d.plating} />
                <Detail label="Size" value={dims} />
                <Detail label="Detail" value={d.detail} />
                <Detail label="Description" value={d.description} />
                <Detail label="CAD files" value={(r.files || []).map((f) => f.name).join(", ")} />
                {Array.isArray(d.stones) &&
                  d.stones.map((s, i) => (
                    <Detail
                      key={i}
                      label={`Stone ${i + 1}`}
                      value={[s.type, s.color, s.shape, s.size ? `${s.size} mm` : null, s.quantity ? `x ${s.quantity}` : null].filter(Boolean).join(", ")}
                    />
                  ))}
              </dl>
            )}

            {editing?.id === r.id ? (
              <div className="mt-4 space-y-4 border-t pt-4">
                <ItemForm
                  row={editing.row}
                  info={info}
                  onChange={(next) => setEditing((cur) => (cur ? { ...cur, row: typeof next === "function" ? next(cur.row) : next } : cur))}
                  onSessionLost={onSessionLost}
                  errors={validateRow(editing.row)}
                  showErrors={editing.show}
                />
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    className={primary}
                    onClick={() => {
                      if (Object.keys(validateRow(editing.row)).length) return setEditing({ ...editing, show: true });
                      const { files, ...data } = toPayload(editing.row);
                      run("update", { id: r.id, data, files: files ?? [] });
                    }}
                  >
                    {r.status === "pending" ? "Save changes" : "Save and resubmit"}
                  </button>
                  <button className={btn} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : correcting?.id === r.id ? (
              <div className="mt-3 space-y-2">
                <textarea
                  className="input text-sm h-20 w-full"
                  maxLength={1000}
                  placeholder="What should be corrected?"
                  value={correcting.note}
                  onChange={(e) => setCorrecting({ id: r.id, note: e.target.value })}
                />
                <div className="flex gap-2">
                  <button disabled={busy || !correcting.note.trim()} className={primary} onClick={() => run("correction", { id: r.id, note: correcting.note })}>
                    Send request
                  </button>
                  <button className={btn} onClick={() => setCorrecting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : confirming === r.id ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-700">Withdraw this item? It will be removed from review.</span>
                <button disabled={busy} className="px-3 py-1.5 text-sm rounded-lg text-white bg-red-600 disabled:opacity-50" onClick={() => run("withdraw", { id: r.id })}>
                  Yes, withdraw
                </button>
                <button className={btn} onClick={() => setConfirming(null)}>
                  Keep it
                </button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {open && (
                  <button className={attention ? primary : btn} onClick={() => setEditing({ id: r.id, row: fromData(d, r.files), show: false })}>
                    {r.status === "pending" ? "Edit" : "Fix and resubmit"}
                  </button>
                )}
                {r.status === "approved" && (
                  <button className={btn} onClick={() => setCorrecting({ id: r.id, note: "" })}>
                    Request a correction
                  </button>
                )}
                <button className={btn} onClick={() => toggle(r.id)}>
                  {isOpen ? "Hide details" : "Details"}
                </button>
                {r.status === "pending" && (
                  <button className={`${btn} text-red-600`} onClick={() => setConfirming(r.id)}>
                    Withdraw
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
