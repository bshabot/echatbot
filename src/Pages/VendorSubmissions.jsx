import { useCallback, useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMessage } from "../components/Messages/MessageContext";
import { useMetalPriceStore } from "../store/MetalPrices";
import { formatImportRow } from "../utils/formatImportRow";
import { insertFormattedSampleRows } from "../utils/insertSampleRows";
import { STAFF_ITEM_INFO_STATIC, submissionToImportRow } from "../utils/vendorSubmissionToImportRow";
import ItemForm from "../vendor/ItemForm.jsx";
import { fromData, toPayload } from "../vendor/fields.js";

// Staff review of what vendors entered through the portal. Vendor-entered text
// is only ever rendered as React text nodes (escaped), never as HTML.

const TABS = [
  { key: "pending", label: "Pending", statuses: ["pending", "approving"] },
  { key: "waiting", label: "With vendor", statuses: ["rejected", "needs_changes"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
];

const fmt = (d) => (d ? new Date(d).toLocaleString() : "");

export default function VendorSubmissions() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const { prices } = useMetalPriceStore();

  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [dropdown, setDropdown] = useState(null);
  const [dupes, setDupes] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // { id, row }
  const [noting, setNoting] = useState(null); // { id, kind: 'rejected'|'needs_changes', note }
  const [openInternal, setOpenInternal] = useState({});

  const statuses = TABS.find((t) => t.key === tab).statuses;

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: subs, error }, { data: v }] = await Promise.all([
      supabase.from("vendor_submissions").select("*").in("status", statuses).order("created_at", { ascending: false }).limit(2000),
      supabase.from("vendors").select("id,name"),
    ]);
    if (error) {
      showMessage("Could not load vendor submissions", { type: "error" });
      setLoading(false);
      return;
    }
    setRows(subs ?? []);
    setVendors(v ?? []);
    const styles = [...new Set((subs ?? []).map((s) => s.data?.style_number).filter(Boolean))];
    if (styles.length && tab === "pending") {
      const { data: existing } = await supabase.from("samples").select("styleNumber").in("styleNumber", styles.slice(0, 500));
      setDupes(new Set((existing ?? []).map((e) => String(e.styleNumber).toLowerCase())));
    } else {
      setDupes(new Set());
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, tab]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    supabase.rpc("get_dropdown_options").then(({ data }) => setDropdown(data));
  }, [supabase]);

  const vendorName = useCallback((id) => vendors.find((v) => v.id === id)?.name ?? `Vendor ${id}`, [vendors]);

  const info = useMemo(
    () => ({
      ...STAFF_ITEM_INFO_STATIC,
      types: (dropdown?.category ?? []).map((c) => c.name),
      plating: (dropdown?.plating ?? []).map((p) => p.name),
    }),
    [dropdown]
  );

  const grouped = useMemo(() => {
    const byVendor = new Map();
    for (const r of rows) {
      if (!byVendor.has(r.vendor_id)) byVendor.set(r.vendor_id, new Map());
      const batches = byVendor.get(r.vendor_id);
      if (!batches.has(r.batch_id)) batches.set(r.batch_id, []);
      batches.get(r.batch_id).push(r);
    }
    return byVendor;
  }, [rows]);

  // ------------------------------------------------------------ actions

  const approve = async (seen, { force = false } = {}) => {
    if (!dropdown) return showMessage("Still loading options, try again", { type: "info" });
    const isDupe = dupes.has(String(seen.data?.style_number).toLowerCase());
    if (isDupe && !force) return { skipped: "duplicate" };
    setBusyId(seen.id);
    try {
      // Approval applies only to the version staff saw. If the vendor edited
      // the row since, the guarded update below matches nothing and we stop.
      const { data: claimed, error: claimErr } = await supabase
        .from("vendor_submissions")
        .update({ status: "approving" })
        .eq("id", seen.id)
        .eq("status", "pending")
        .eq("version", seen.version)
        .select("id,version,data")
        .maybeSingle();
      if (claimErr || !claimed) {
        showMessage("That row changed since you loaded it. Reloading, then review it again.", { type: "error" });
        await load();
        return { skipped: "changed" };
      }

      const importRow = submissionToImportRow(claimed.data, vendorName(seen.vendor_id));
      const formatted = formatImportRow(importRow, "samples", dropdown, prices);
      const { successfulRows, failedRows } = await insertFormattedSampleRows(supabase, [formatted]);
      if (failedRows.length || !successfulRows.length) {
        await supabase.from("vendor_submissions").update({ status: "pending" }).eq("id", seen.id).eq("status", "approving");
        showMessage(`Could not create the sample: ${failedRows[0]?.error ?? "unknown error"}`, { type: "error" });
        return { skipped: "failed" };
      }
      const { error: doneErr } = await supabase
        .from("vendor_submissions")
        .update({ status: "approved", sample_id: successfulRows[0].id, reviewed_at: new Date().toISOString() })
        .eq("id", seen.id);
      if (doneErr) showMessage("Sample created, but the submission could not be marked approved. Check it manually.", { type: "error" });
      return { ok: true };
    } finally {
      setBusyId(null);
    }
  };

  const approveOne = async (r, force) => {
    const res = await approve(r, { force });
    if (res?.skipped === "duplicate") return showMessage("Style number already exists. Use Approve anyway if it is intended.", { type: "error" });
    if (res?.ok) showMessage("Approved. Sample created.");
    await load();
  };

  const approveBatch = async (batchRows) => {
    let ok = 0;
    let skipped = 0;
    for (const r of batchRows.filter((x) => x.status === "pending")) {
      const res = await approve(r);
      if (res?.ok) ok++;
      else skipped++;
    }
    showMessage(`Approved ${ok}${skipped ? `, skipped ${skipped} (duplicates or changed rows)` : ""}`);
    await load();
  };

  const sendBack = async () => {
    const { id, kind, note } = noting;
    const seen = rows.find((r) => r.id === id);
    setBusyId(id);
    const { data, error } = await supabase
      .from("vendor_submissions")
      .update({ status: kind, review_note: note.trim() || null, reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .eq("version", seen.version)
      .select("id")
      .maybeSingle();
    setBusyId(null);
    if (error || !data) showMessage("That row changed since you loaded it. Reloading.", { type: "error" });
    else showMessage(kind === "rejected" ? "Rejected" : "Sent back for changes");
    setNoting(null);
    await load();
  };

  const saveEdit = async () => {
    const seen = rows.find((r) => r.id === editing.id);
    const { data, error } = await supabase
      .from("vendor_submissions")
      .update({ data: toPayload(editing.row) })
      .eq("id", editing.id)
      .eq("status", "pending")
      .eq("version", seen.version)
      .select("id")
      .maybeSingle();
    if (error || !data) showMessage("Could not save: the row changed. Reloading.", { type: "error" });
    else showMessage("Saved your edit");
    setEditing(null);
    await load();
  };

  const saveInternal = async (r, value) => {
    await supabase.from("vendor_submissions").update({ internal_note: value || null }).eq("id", r.id);
    showMessage("Internal note saved");
  };


  // ------------------------------------------------------------ render

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center justify-between mb-4 gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Vendor submissions</h1>
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-lg border ${tab === t.key ? "bg-chabot-gold text-white border-chabot-gold" : "bg-white"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing here.</p>
      ) : (
        [...grouped.entries()].map(([vendorId, batches]) => (
          <section key={vendorId} className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">{vendorName(vendorId)}</h2>
            {[...batches.entries()].map(([batchId, batchRows]) => (
              <div key={batchId} className="mb-5">
                <div className="flex items-center gap-3 mb-2 text-sm text-gray-500">
                  <span>
                    Batch from {fmt(batchRows[batchRows.length - 1].created_at)} · {batchRows.length} item{batchRows.length === 1 ? "" : "s"}
                  </span>
                  {tab === "pending" && (
                    <button className="text-chabot-gold" disabled={busyId !== null} onClick={() => approveBatch(batchRows)}>
                      Approve all in batch
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {batchRows.map((r) => {
                    const d = r.data || {};
                    const isDupe = dupes.has(String(d.style_number).toLowerCase());
                    const edited = r.version > 1 && r.edited_by === "vendor";
                    const locked = r.status === "approving";
                    return (
                      <div key={r.id} className="bg-white border rounded-lg p-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="font-medium text-gray-900">{d.style_number}</div>
                          <div className="text-sm text-gray-500">
                            {[d.type, d.metal_type, d.karat, d.color, d.weight ? `${d.weight} g` : null, d.plating].filter(Boolean).join(" · ")}
                          </div>
                          {isDupe && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">Style number exists</span>}
                          {edited && <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-800">Edited by vendor (v{r.version})</span>}
                          {r.correction_note && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">Correction requested</span>}
                          {r.status === "approved" && r.sample_id && <span className="text-xs text-gray-400">Sample #{r.sample_id}</span>}
                        </div>
                        {(d.detail || d.description) && (
                          <div className="text-sm text-gray-600 mt-1">{[d.detail, d.description].filter(Boolean).join(" — ")}</div>
                        )}
                        {Array.isArray(d.stones) && d.stones.length > 0 && (
                          <div className="text-xs text-gray-500 mt-1">
                            Stones: {d.stones.map((s) => [s.quantity ? `${s.quantity}×` : null, s.type, s.shape, s.color, s.size].filter(Boolean).join(" ")).join("; ")}
                          </div>
                        )}
                        {r.correction_note && (
                          <p className="mt-2 text-sm bg-blue-50 border border-blue-100 rounded p-2">
                            <span className="font-medium">Vendor correction request ({fmt(r.correction_at)}): </span>
                            {r.correction_note}
                          </p>
                        )}
                        {r.review_note && <p className="mt-2 text-xs text-gray-500">Note to vendor: {r.review_note}</p>}

                        {editing?.id === r.id ? (
                          <div className="mt-3 space-y-3">
                            <ItemForm row={editing.row} info={info} onChange={(row) => setEditing({ id: r.id, row })} />
                            <div className="flex gap-2">
                              <button className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold" onClick={saveEdit}>
                                Save edit
                              </button>
                              <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : noting?.id === r.id ? (
                          <div className="mt-3 space-y-2">
                            <textarea
                              className="input text-sm h-20"
                              maxLength={1000}
                              placeholder="Note the vendor will see"
                              value={noting.note}
                              onChange={(e) => setNoting({ ...noting, note: e.target.value })}
                            />
                            <div className="flex gap-2">
                              <button className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold" onClick={sendBack}>
                                {noting.kind === "rejected" ? "Reject" : "Send back for changes"}
                              </button>
                              <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setNoting(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-3 text-sm">
                            {r.status === "pending" && (
                              <>
                                <button
                                  disabled={busyId !== null}
                                  className="text-green-700 font-medium disabled:opacity-50"
                                  onClick={() => approveOne(r, isDupe)}
                                >
                                  {isDupe ? "Approve anyway" : "Approve"}
                                </button>
                                <button className="text-orange-700" onClick={() => setNoting({ id: r.id, kind: "needs_changes", note: "" })}>
                                  Needs changes
                                </button>
                                <button className="text-red-600" onClick={() => setNoting({ id: r.id, kind: "rejected", note: "" })}>
                                  Reject
                                </button>
                                <button className="text-chabot-gold" onClick={() => setEditing({ id: r.id, row: fromData(d) })}>
                                  Edit
                                </button>
                              </>
                            )}
                            {locked && <span className="text-gray-400">Being approved…</span>}
                            <button className="text-gray-500" onClick={() => setOpenInternal((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                              Internal note
                            </button>
                          </div>
                        )}
                        {openInternal[r.id] && (
                          <InternalNote initial={r.internal_note ?? ""} onSave={(v) => saveInternal(r, v)} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function InternalNote({ initial, onSave }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="mt-2 flex gap-2 items-start">
      <textarea className="input text-sm h-16" maxLength={1000} placeholder="Internal note (vendors never see this)" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => onSave(value)}>
        Save
      </button>
    </div>
  );
}
