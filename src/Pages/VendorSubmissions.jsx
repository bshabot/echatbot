import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, FileImage } from "lucide-react";
import { useSupabase } from "../components/SupaBaseProvider";
import { uploadImageToR2 } from "../utils/r2Upload";
import { vendorAdmin } from "../utils/vendorAdminApi";
import { useMessage } from "../components/Messages/MessageContext";
import { useMetalPriceStore } from "../store/MetalPrices";
import { formatImportRow } from "../utils/formatImportRow";
import { insertFormattedSampleRows } from "../utils/insertSampleRows";
import { STAFF_ITEM_INFO_STATIC, submissionToImportRow, factoryCostUsd } from "../utils/vendorSubmissionToImportRow";
import ItemForm from "../vendor/ItemForm.jsx";
import { fromData, toPayload } from "../vendor/fields.js";
import { maxNumberFor, styleParts } from "../utils/suggestStyleNumber";

// Staff review of what vendors entered through the portal. Vendor-entered text
// is only ever rendered as React text nodes (escaped), never as HTML.

const TABS = [
  { key: "pending", label: "Pending", statuses: ["pending", "approving"] },
  { key: "waiting", label: "With vendor", statuses: ["rejected", "needs_changes"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
];

const fmt = (d) => (d ? new Date(d).toLocaleString() : "");

export default function VendorSubmissions() {
  const { supabase, session } = useSupabase();
  const { showMessage } = useMessage();
  const { prices } = useMetalPriceStore();

  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [dropdown, setDropdown] = useState(null);
  const [styles, setStyles] = useState({}); // submission id -> style number staff typed
  const [dupeIds, setDupeIds] = useState(new Set()); // ids whose style number already exists
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // { id, row }
  const [noting, setNoting] = useState(null); // { id, kind: 'rejected'|'needs_changes', note }
  const [openInternal, setOpenInternal] = useState({});
  const [filesBySub, setFilesBySub] = useState({}); // submission id -> uploaded CAD files
  // RMB per 1 USD, used to turn vendor costs entered in RMB into USD at approval. Kept in this browser.
  const [rmbRate, setRmbRate] = useState(() => {
    try { return localStorage.getItem("vp_rmb_per_usd") || ""; } catch { return ""; }
  });
  const setRate = (v) => {
    const clean = v.replace(/[^0-9.]/g, "");
    setRmbRate(clean);
    try { localStorage.setItem("vp_rmb_per_usd", clean); } catch { /* not available */ }
  };
  const rateOk = Number(rmbRate) > 0;
  const needsRate = (r) => String(r.data?.cost_currency || "USD").toUpperCase() === "RMB" && Number(r.data?.factory_cost) > 0;
  const [selected, setSelected] = useState(new Set()); // submission ids ticked for bulk actions

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
    const ids = (subs ?? []).map((s) => s.id);
    if (ids.length) {
      const { data: fl } = await supabase
        .from("vendor_files")
        .select("id,submission_id,original_name,ext,size_bytes,copied_at")
        .in("submission_id", ids.slice(0, 1000))
        .eq("status", "uploaded");
      const map = {};
      (fl ?? []).forEach((f) => (map[f.submission_id] = [...(map[f.submission_id] ?? []), f]));
      setFilesBySub(map);
    } else setFilesBySub({});
    setDupeIds(new Set());
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, tab]);

  useEffect(() => {
    load();
  }, [load]);

  // Pre-fill each pending row with the next style number by the house rules (staff can edit it).
  const nextNum = useRef({}); // prefix -> last number handed out
  const suggested = useRef(new Set()); // submission ids already given a suggestion
  useEffect(() => {
    if (tab !== "pending") return;
    let live = true;
    (async () => {
      const fill = {};
      for (const r of rows) {
        if (r.status !== "pending" || suggested.current.has(r.id)) continue;
        const parts = styleParts(r.data);
        if (!parts) continue;
        try {
          if (nextNum.current[parts.prefix] == null) nextNum.current[parts.prefix] = await maxNumberFor(supabase, parts.prefix);
        } catch (e) {
          console.error("style suggestion failed", e);
          return;
        }
        nextNum.current[parts.prefix] += 1;
        suggested.current.add(r.id);
        fill[r.id] = `${parts.prefix}${nextNum.current[parts.prefix]}${parts.letters}${parts.suffix}`;
      }
      if (live && Object.keys(fill).length) setStyles((st) => ({ ...fill, ...st }));
    })();
    return () => { live = false; };
  }, [rows, tab, supabase]);

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

  // ------------------------------------------------------------ CAD files

  // Pictures already show as previews while pending; list only other files (all files once approved, for copy status).
  const chipFiles = (r) => (filesBySub[r.id] ?? []).filter((f) => r.status === "approved" || !IMG_EXT.includes(String(f.ext).toLowerCase()));

  const download = async (f) => {
    const res = await vendorAdmin(session, "fileUrl", { fileId: f.id });
    if (!res.ok || !res.url) return showMessage("Could not get the download link", { type: "error" });
    const a = document.createElement("a");
    a.href = res.url;
    a.rel = "noopener";
    a.target = "_blank";
    a.click();
  };

  // Copies a submission's uploaded files into the PLM CAD section of the sample's starting_info.
  // Returns { copied, failed }. Each file is stamped copied_at only after it is fully linked.
  const copyFilesToPlm = async (sub, saved) => {
    const { data: files } = await supabase
      .from("vendor_files")
      .select("id,original_name,ext")
      .eq("submission_id", sub.id)
      .eq("status", "uploaded")
      .is("copied_at", null);
    const style = String(saved.styleNumber ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    let copied = 0;
    let failed = 0;
    for (const f of files ?? []) {
      try {
        const res = await vendorAdmin(session, "fileUrl", { fileId: f.id });
        if (!res.ok || !res.url) throw new Error("no link");
        const resp = await fetch(res.url);
        if (!resp.ok) throw new Error("download failed");
        const blob = await resp.blob();
        if (!blob.size) throw new Error("empty file");
        const safe = f.original_name.replace(/ /g, "_").replace(/[^a-zA-Z0-9_\-.]/g, "");
        const dest = `public/cad_${style}_${f.id.slice(0, 8)}_${safe}`;
        await uploadImageToR2(supabase, dest, new File([blob], safe, { type: blob.type || "application/octet-stream" }));
        const { data: img, error: imgErr } = await supabase
          .from("images")
          .insert([{ imageUrl: dest, originalUrl: dest, name: f.original_name }])
          .select("id")
          .single();
        if (imgErr) throw imgErr;
        const { error: linkErr } = await supabase.from("image_link").insert([
          { imageId: img.id, styleNumber: saved.styleNumber, entity: "starting_info", entityId: saved.starting_info.id, type: "cad", is_primary: false },
        ]);
        if (linkErr) throw linkErr;
        await supabase.from("vendor_files").update({ copied_at: new Date().toISOString() }).eq("id", f.id);
        copied++;
      } catch (e) {
        console.error("CAD copy failed", f.id, e);
        failed++;
      }
    }
    return { copied, failed };
  };

  // Retry for an approved item whose files did not all make it across.
  const retryCopy = async (r) => {
    setBusyId(r.id);
    try {
      const { data: smp, error } = await supabase.from("samples").select("styleNumber,starting_info_id").eq("id", r.sample_id).single();
      if (error || !smp) return showMessage("Could not find the sample for this item", { type: "error" });
      const out = await copyFilesToPlm(r, { styleNumber: smp.styleNumber, starting_info: { id: smp.starting_info_id } });
      showMessage(out.failed ? `Copied ${out.copied}, ${out.failed} still failing` : `Copied ${out.copied} CAD file${out.copied === 1 ? "" : "s"} to the sample`, { type: out.failed ? "error" : "info" });
    } finally {
      setBusyId(null);
      await load();
    }
  };

  // ------------------------------------------------------------ actions

  const approve = async (seen, { force = false } = {}) => {
    if (!dropdown) return showMessage("Still loading options, try again", { type: "info" });
    const style = String(styles[seen.id] ?? "").trim();
    if (!style) return { skipped: "nostyle" };
    if (needsRate(seen) && !rateOk) return { skipped: "norate" };
    // Style numbers are global: block one that already exists (any case).
    {
      const safe = style.replace(/[\\%_]/g, (c) => "\\" + c);
      const { data: hit } = await supabase.from("samples").select("id").ilike("styleNumber", safe).limit(1);
      if (hit?.length) {
        setDupeIds((s) => new Set(s).add(seen.id));
        return { skipped: "duplicate" };
      }
    }
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

      const importRow = submissionToImportRow(claimed.data, vendorName(seen.vendor_id), style, rmbRate);
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
      // CAD files go into the PLM CAD section; a failure here never undoes the approval.
      const cad = await copyFilesToPlm(claimed, successfulRows[0]);
      if (cad.failed) showMessage(`Approved, but ${cad.failed} CAD file${cad.failed === 1 ? "" : "s"} could not be copied. Use "Copy CAD files" on the Approved tab.`, { type: "error" });
      return { ok: true };
    } finally {
      setBusyId(null);
    }
  };

  const approveOne = async (r, force) => {
    const res = await approve(r, { force });
    if (res?.skipped === "nostyle") return showMessage("Enter a style number first.", { type: "error" });
    if (res?.skipped === "norate") return showMessage("This cost is in RMB. Enter the RMB per USD rate at the top first.", { type: "error" });
    if (res?.skipped === "duplicate") return showMessage("That style number already exists. Change it to approve.", { type: "error" });
    if (res?.ok) showMessage("Approved. Sample created.");
    await load();
  };

  const approveSelected = async () => {
    const todo = rows.filter((r) => r.status === "pending" && selected.has(r.id) && String(styles[r.id] ?? "").trim());
    let ok = 0;
    const skipped = [];
    for (const r of todo) {
      const res = await approve(r);
      if (res?.ok) ok++;
      else skipped.push(r.id);
    }
    showMessage(`Approved ${ok}${skipped.length ? `, skipped ${skipped.length} (duplicate style number or changed row)` : ""}`, { type: skipped.length ? "error" : "info" });
    setSelected(new Set(skipped));
    await load();
  };

  const sendBack = async () => {
    const { ids, kind, note } = noting;
    let done = 0;
    for (const id of ids) {
      const seen = rows.find((r) => r.id === id);
      if (!seen) continue;
      setBusyId(id);
      const { data, error } = await supabase
        .from("vendor_submissions")
        .update({ status: kind, review_note: note.trim() || null, reviewed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .eq("version", seen.version)
        .select("id")
        .maybeSingle();
      if (!error && data) done++;
    }
    setBusyId(null);
    if (done < ids.length) showMessage(`${done} of ${ids.length} updated; the rest changed since you loaded them. Reloading.`, { type: "error" });
    else showMessage(kind === "rejected" ? `Rejected ${done}` : `Sent ${done} back for changes`);
    setNoting(null);
    setSelected(new Set());
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

  const pendingRows = rows.filter((r) => r.status === "pending");
  const selRows = pendingRows.filter((r) => selected.has(r.id));
  const readyRows = selRows.filter((r) => String(styles[r.id] ?? "").trim() && !dupeIds.has(r.id) && (!needsRate(r) || rateOk));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = pendingRows.length > 0 && selRows.length === pendingRows.length;
  const styleOf = (r) => String(styles[r.id] ?? "").trim();

  return (
    <div className="p-6 pb-28">
      <div className="flex flex-wrap items-center justify-between mb-4 gap-2">
        <h1 className="text-2xl font-bold text-gray-900">
          Vendor submissions
          {tab === "pending" && rows.length ? <span className="ml-2 text-base font-normal text-gray-500">{rows.length} to review</span> : null}
        </h1>
        <div className="flex items-center gap-2">
          {tab === "pending" && pendingRows.some(needsRate) && (
            <label className="flex items-center gap-1.5 text-sm text-gray-700">
              RMB per $1
              <input className="input !p-1.5 w-20 text-sm" inputMode="decimal" placeholder="e.g. 7.2" value={rmbRate} onChange={(e) => setRate(e.target.value)} />
            </label>
          )}
          {tab === "pending" && pendingRows.length > 0 && (
            <button
              className="px-3 py-1.5 text-sm rounded-lg border bg-white"
              onClick={() => setSelected(allSelected ? new Set() : new Set(pendingRows.map((r) => r.id)))}
            >
              {allSelected ? "Clear selection" : "Select all"}
            </button>
          )}
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setSelected(new Set()); }}
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
        [...grouped.entries()].map(([vendorId, batches]) => {
          const vendorRows = [...batches.values()].flat();
          return (
            <section key={vendorId} className="mb-8">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                {vendorName(vendorId)} <span className="text-sm font-normal text-gray-500">{vendorRows.length} item{vendorRows.length === 1 ? "" : "s"}</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                {vendorRows.map((r) => {
                  const d = r.data || {};
                  const isDupe = dupeIds.has(r.id);
                  const edited = r.version > 1 && r.edited_by === "vendor";
                  const locked = r.status === "approving";
                  const pending = r.status === "pending";
                  const isSel = selected.has(r.id);
                  const isEditing = editing?.id === r.id;
                  const dims = [d.length, d.width, d.height].some((v) => v !== "" && v != null)
                    ? [d.length, d.width, d.height].map((v) => (v === "" || v == null ? "–" : v)).join(" × ") + " mm"
                    : "";
                  const extras = [d.ring_size ? `Ring size ${d.ring_size}` : null, d.extension ? `Extension ${d.extension} mm` : null, d.sales_weight ? `Total ${d.sales_weight} g` : null].filter(Boolean);
                  const isRmb = d.factory_cost && String(d.cost_currency || "USD").toUpperCase() === "RMB";
                  const costUsd = factoryCostUsd(d, rmbRate);
                  const material = [d.metal_type, d.karat, d.color, d.plating].filter(Boolean).join(" · ");
                  const stonesLine = d.stones_text || (Array.isArray(d.stones) ? d.stones.map((st) => st.notes || [st.quantity ? `${st.quantity}×` : null, st.type, st.shape, st.color, st.size].filter(Boolean).join(" ")).join(", ") : "");
                  const note = [d.detail, d.description].filter(Boolean).join(" — ");
                  return (
                    <div
                      key={r.id}
                      className={`flex flex-col bg-white rounded-lg shadow-sm border overflow-hidden ${isEditing ? "col-span-full" : ""} ${isSel ? "border-chabot-gold ring-1 ring-chabot-gold" : "border-gray-200"}`}
                    >
                      <div className="relative">
                        <Thumb files={filesBySub[r.id] ?? []} session={session} />
                        {pending && (
                          <button
                            type="button"
                            aria-label={isSel ? "Deselect" : "Select"}
                            onClick={() => toggle(r.id)}
                            className="absolute top-2 right-2"
                          >
                            <CheckCircle className={`w-6 h-6 drop-shadow-sm ${isSel ? "text-chabot-gold" : "text-gray-300 hover:text-gray-400"}`} />
                          </button>
                        )}
                      </div>

                      <div className="flex flex-col flex-1 p-4 gap-1.5">
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-sm font-semibold text-gray-900 truncate" title={d.manufacturer_code || d.style_number}>
                            {d.manufacturer_code || d.style_number}
                          </span>
                          <span className="shrink-0 text-xs text-gray-400">{fmt(r.created_at).split(",")[0]}</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {edited && <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-800">Edited by vendor (v{r.version})</span>}
                          {r.correction_note && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">Correction requested</span>}
                          {r.status === "approved" && r.sample_id && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800">Sample #{r.sample_id}</span>}
                          {r.status === "needs_changes" && <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-800">Needs changes</span>}
                          {r.status === "rejected" && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">Rejected</span>}
                          {locked && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Being approved…</span>}
                        </div>

                        {isEditing ? (
                          <div className="mt-2 space-y-3">
                            <ItemForm row={editing.row} info={info} hideFiles onChange={(row) => setEditing({ id: r.id, row: typeof row === "function" ? row(editing.row) : row })} />
                            <div className="flex gap-2">
                              <button className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold" onClick={saveEdit}>Save edit</button>
                              <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="text-sm text-gray-700">
                              {[d.type, d.weight ? `${d.weight} g` : null, dims, ...extras].filter(Boolean).join(" · ")}
                            </p>
                            {material && <p className="text-xs text-gray-500">{material}</p>}
                            {stonesLine && (
                              <p className="text-xs text-gray-600" title="As the vendor wrote it">
                                <span className="text-gray-400">Stones </span>
                                {stonesLine}
                              </p>
                            )}
                            {d.factory_cost && (
                              <p className="text-xs text-gray-700">
                                <span className="text-gray-400">Factory cost </span>
                                {isRmb ? `¥${d.factory_cost} RMB` : `$${d.factory_cost}`}
                                {isRmb && (costUsd !== "" ? ` ≈ $${costUsd}` : <span className="text-orange-700"> · set the RMB rate to convert</span>)}
                              </p>
                            )}
                            {note && <p className="text-xs text-gray-600 line-clamp-3" title={note}>{note}</p>}
                            {chipFiles(r).length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {chipFiles(r).map((f) => (
                                  <button key={f.id} className="inline-flex items-center gap-1 rounded border bg-gray-50 px-1.5 py-0.5 text-xs hover:bg-gray-100" onClick={() => download(f)}>
                                    <span className="uppercase text-gray-500">{f.ext}</span>
                                    <span className="max-w-[8rem] truncate">{f.original_name}</span>
                                    {r.status === "approved" && <span className={f.copied_at ? "text-green-700" : "text-orange-700"}>{f.copied_at ? "in PLM" : "not copied"}</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                            {r.status === "approved" && r.sample_id && (filesBySub[r.id] ?? []).some((f) => !f.copied_at) && (
                              <button disabled={busyId !== null} className="text-chabot-gold text-xs text-left disabled:opacity-50" onClick={() => retryCopy(r)}>
                                Copy CAD files to the sample
                              </button>
                            )}
                            {r.correction_note && (
                              <p className="text-xs bg-blue-50 border border-blue-100 rounded p-2">
                                <span className="font-medium">Vendor correction request ({fmt(r.correction_at)}): </span>
                                {r.correction_note}
                              </p>
                            )}
                            {r.review_note && <p className="text-xs text-gray-500">Note to vendor: {r.review_note}</p>}
                          </>
                        )}

                        {pending && !isEditing && (
                          <div className="mt-auto pt-2 space-y-2">
                            <div className="flex items-center gap-2">
                              <input
                                className="input !p-1.5 flex-1 min-w-0 text-sm"
                                maxLength={40}
                                placeholder="Style number"
                                value={styles[r.id] ?? ""}
                                onChange={(e) => {
                                  setStyles((s) => ({ ...s, [r.id]: e.target.value }));
                                  setDupeIds((s) => { const n = new Set(s); n.delete(r.id); return n; });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !busyId && !isDupe && styleOf(r)) approveOne(r);
                                }}
                              />
                              <button
                                disabled={busyId !== null || isDupe || !styleOf(r)}
                                className="px-3 py-1.5 text-sm font-medium text-white rounded-lg disabled:opacity-40 bg-green-600"
                                onClick={() => approveOne(r)}
                              >
                                {busyId === r.id ? "…" : "Approve"}
                              </button>
                            </div>
                            {isDupe && <p className="text-xs text-red-700">That style number already exists. Change it to approve.</p>}
                            <div className="flex flex-wrap gap-1.5 text-xs">
                              <button className={`${BTN} border-orange-300 text-orange-800 bg-orange-50 hover:bg-orange-100`} onClick={() => setNoting({ ids: [r.id], kind: "needs_changes", note: "" })}>Needs changes</button>
                              <button className={`${BTN} border-red-300 text-red-700 bg-red-50 hover:bg-red-100`} onClick={() => setNoting({ ids: [r.id], kind: "rejected", note: "" })}>Reject</button>
                              <button className={`${BTN} border-gray-300 text-gray-800 bg-white hover:bg-gray-50`} onClick={() => setEditing({ id: r.id, row: fromData(d) })}>Edit</button>
                              <button className={`${BTN} border-gray-300 text-gray-700 bg-white hover:bg-gray-50`} onClick={() => setOpenInternal((o) => ({ ...o, [r.id]: !o[r.id] }))}>Note</button>
                            </div>
                          </div>
                        )}
                        {!pending && (
                          <div className="mt-auto pt-1">
                            <button className={`${BTN} border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs`} onClick={() => setOpenInternal((o) => ({ ...o, [r.id]: !o[r.id] }))}>Internal note</button>
                          </div>
                        )}
                        {openInternal[r.id] && <InternalNote initial={r.internal_note ?? ""} onSave={(v) => saveInternal(r, v)} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {/* Bulk bar: appears when cards are selected, or when sending notes back. */}
      {tab === "pending" && (selRows.length > 0 || noting) && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t bg-white shadow-lg px-6 py-3">
          {noting ? (
            <div className="flex flex-wrap items-start gap-2">
              <textarea
                className="input text-sm h-16 flex-1 min-w-[16rem]"
                maxLength={1000}
                placeholder={`Note the vendor will see (${noting.ids.length} item${noting.ids.length === 1 ? "" : "s"})`}
                value={noting.note}
                onChange={(e) => setNoting({ ...noting, note: e.target.value })}
              />
              <button className="px-3 py-1.5 text-sm text-white rounded-lg bg-chabot-gold" onClick={sendBack}>
                {noting.kind === "rejected" ? "Reject" : "Send back for changes"}
              </button>
              <button className="px-3 py-1.5 text-sm rounded-lg border" onClick={() => setNoting(null)}>Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-700">
                {selRows.length} selected · {readyRows.length} with a style number
              </span>
              <button
                disabled={busyId !== null || readyRows.length === 0}
                className="px-3 py-1.5 text-sm font-medium text-white rounded-lg bg-green-600 disabled:opacity-40"
                onClick={approveSelected}
              >
                Approve {readyRows.length || ""}
              </button>
              <button className={`${BTN} text-sm border-orange-300 text-orange-800 bg-orange-50`} onClick={() => setNoting({ ids: selRows.map((r) => r.id), kind: "needs_changes", note: "" })}>
                Needs changes
              </button>
              <button className={`${BTN} text-sm border-red-300 text-red-700 bg-red-50`} onClick={() => setNoting({ ids: selRows.map((r) => r.id), kind: "rejected", note: "" })}>
                Reject
              </button>
              <button className="px-3 py-1.5 text-sm rounded-lg border bg-white" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BTN = "px-2.5 py-1 font-medium rounded-lg border";
const IMG_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

// First picture the vendor attached (signed link), in the same white image box the samples page uses.
function Thumb({ files, session }) {
  const pics = files.filter((f) => IMG_EXT.includes(String(f.ext).toLowerCase()));
  const first = pics[0];
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (first) {
      vendorAdmin(session, "fileUrl", { fileId: first.id }).then((res) => {
        if (live && res.ok && res.url) setUrl(res.url);
      });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first?.id]);
  return (
    <div className="relative h-44 bg-white border-b border-gray-100">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={first.original_name}>
          <img src={url} alt={first.original_name} className="w-full h-full object-contain p-3" />
        </a>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50">
          <FileImage className="w-10 h-10 text-gray-300" />
          <span className="mt-1 text-xs text-gray-400">{first ? "Loading…" : "No image"}</span>
        </div>
      )}
      {pics.length > 1 && (
        <span className="absolute bottom-2 right-2 text-[11px] font-medium text-gray-600 bg-white/90 border border-gray-200 rounded-full px-2 py-0.5 shadow-sm">
          +{pics.length - 1}
        </span>
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
