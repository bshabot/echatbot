import React, { useState, useEffect, useMemo, useRef } from "react";
import { CornerDownLeft, Copy, Download, Landmark, RefreshCw, UploadCloud, Link2 } from "lucide-react";
import { exportData } from "../../utils/exportUtils";
import SampleCard from "../Samples/SampleCard";
import SampleSetCard from "../Samples/SampleSetCard";
import { fetchSetsForSamples, linkSamplesAsSet, addSamplesToSet, renameSet, unlinkSet, reorderSet, suggestSetStyle, MAX_SET_ITEMS } from "../../utils/sampleSets";
import { useSupabase } from "../SupaBaseProvider";
import ViewableListActionButtons from "../MiscComponenets/ViewableListActionButtons";
import { useMessage } from "../Messages/MessageContext";
import { useAlert } from "../Alerts/AlertContext";
import { useGenericStore } from "../../store/VendorStore";
import { useQbSyncJobStore } from "../../store/QbSyncJobStore";
import { isQbEnabled } from "../../utils/qbClient";
import { createItemsForSamples, updateItemsForSamples, syncItemForSample } from "../../utils/qbItems";
import { isSspEnabled } from "../../utils/sspClient";
import { prepareSspCreatesForSamples, prepareSspSetCreate, sspStepsForPrepared, sendPreparedSspCreates } from "../../utils/sspCreate";
import { duplicateSample } from "../../utils/duplicateSample";
import { useSearchParams, useNavigate } from "react-router-dom"; // Import React Router hooks
import Loading from "../Loading";
import { Printer } from "lucide-react";
import { printTags, printResultMessage } from "../../utils/tags/browserPrint";
import { DEFAULT_PRINT_OPTIONS } from "../../utils/tags/printConfig";

export default function SampleList({ samples, setSamples, isLoading, setIsLoading, hasMore, setHasMore, setTotalPages, setResultCount, onSampleClick, onDuplicate, onDeleteSample }) {
  const { getEntity } = useGenericStore();
  const { options } = getEntity("settings");
  const settings = useGenericStore((state) => state.getEntity("settings"));
  // Needed to turn a sample's vendor id into the vendor NAME QuickBooks wants
  // for an item's preferred vendor (see attachVendorName in qbItems.js).
  const vendors = getEntity("vendors");
  const qbOn = isQbEnabled(settings);
  const { showAlert, showConfirm, showPrompt } = useAlert();
  // Busy/progress for every QB button below lives in the global
  // QbSyncJobStore now (createItemsForSamples/updateItemsForSamples/
  // syncItemForSample are all self-tracking) — nothing QB-related runs only
  // on this page anymore. Per-card "Sync to QB" is derived the same way,
  // matched by sample_id/styleNumber in the process's poIds.
  const qbBusy = useQbSyncJobStore((s) => s.processes.some((p) => p.status === "running" && p.type === "item-create"));
  const qbUpdateBusy = useQbSyncJobStore((s) => s.processes.some((p) => p.status === "running" && p.type === "item-update"));
  // IMPORTANT: a Zustand selector must return the SAME reference when nothing
  // relevant changed — .filter()/.flatMap() build a brand-new array on every
  // single call, which trips React 18's "getSnapshot should be cached" guard
  // and crashes with "Maximum update depth exceeded" (minified error #185).
  // Select the raw (stable) processes array instead, and derive off it with
  // useMemo so the derived array is only rebuilt when processes actually change.
  const qbProcesses = useQbSyncJobStore((s) => s.processes);
  const syncingIds = useMemo(
    () =>
      qbProcesses
        .filter((p) => p.status === "running" && p.type === "item-sync-single")
        .flatMap((p) => p.poIds || []),
    [qbProcesses]
  );
  const [qbSummary, setQbSummary] = useState(null);
  // Bulk duplicate -- Kevin, 2026-09-16: "add in a bulk option on the
  // samples page to select multiple and add items" -- clone every selected
  // sample in one go instead of the single-item "Duplicate" (which prompts
  // for one new style number at a time). Each clone gets the source's own
  // styleNumber + "-copy" (then "-copy2", "-copy3", ... on a collision,
  // same pattern Kevin already uses for hand-typed dup style numbers).
  const [dupBusy, setDupBusy] = useState(false);
  const [dupSummary, setDupSummary] = useState(null);
  // SSP "Create in SSP" — mirrors the QB pattern: gated by Settings (toggle +
  // pasted token), per-card busy set for the 3-dot action, one busy flag +
  // summary strip for the batch. SSP doesn't have a global job store like QB
  // does yet, so this stays local state for now.
  const sspOn = isSspEnabled(settings);
  const [sspBusy, setSspBusy] = useState(false);
  const [sspSummary, setSspSummary] = useState(null);
  const [sspCardCreating, setSspCardCreating] = useState(() => new Set());
  // Per-sample "Create in SSP" step progress, for the ring around the
  // card's kebab button: { [sample_id]: { steps, statusByStep } }.
  const [sspProgressBySample, setSspProgressBySample] = useState({});
  // Same idea for a linked set (one SSP, several items): busy flag + ring
  // progress keyed by set id. Step names are "<memberIndex>:<step>".
  const [sspSetCreating, setSspSetCreating] = useState(() => new Set());
  const [sspProgressBySet, setSspProgressBySet] = useState({});
  const [selectedSamples, setSelectedSamples] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  // Linked sets ("one card, two items"). setInfo maps this page's samples to
  // their set; setRows holds the full view rows for every set member (a set's
  // other half may be on a different page of results).
  const [setInfo, setSetInfo] = useState({ setsById: {}, setIdBySample: {} });
  const [setRows, setSetRows] = useState({});
  const [setsTick, setSetsTick] = useState(0); // bump to reload after link/unlink/swap
  // const [page, setPage] = useState(0);
  // const [isloading, setIsLoading] = useState(false);
  // const [hasMore, setHasMore] = useState(true);
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const PAGE_SIZE = 60;

  const [searchParams, setSearchParams] = useSearchParams(); // React Router hook for query params
  const page = parseInt(searchParams.get("page") || "0", 10);
  const collection = searchParams.getAll('collection') || "";
  const category = searchParams.getAll('category') || "";
  // Kevin, 2026-09-30: SSP's free-text sub-category (starting_info.category,
  // exposed on the view as starting_category) -- distinct from "category"
  // above, which despite its name filters starting_type (SSP product TYPE).
  const subcategory = searchParams.getAll('subcategory') || "";
  const metals = searchParams.getAll('metal') || "";
  const chains = searchParams.getAll('chain') || "";
  const q = (searchParams.get('q') || "").trim();
  const vendor = searchParams.get('vendor') || "";
  const karat = searchParams.get('karat') || "";
  const backType = searchParams.get('back') || "";
  const stoneType = searchParams.get('stone') || "";
  const stoneColor = searchParams.get('stonecolor') || "";
  const sort = searchParams.get('sort') || "newest";

  // Fetch samples from Supabase — all filters combine server-side
  const fetchSamples = async (pageNumber) => {
    setIsLoading(true);
    const from = pageNumber * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from("sample_with_stones_export")
      .select('*', { count: "exact" }) // exact count so the pager knows the last page
      .range(from, to);

    // sort
    if (sort === "style") query = query.order("styleNumber", { ascending: true });
    else if (sort === "cost_desc") query = query.order("totalCost", { ascending: false, nullsFirst: false });
    else if (sort === "cost_asc") query = query.order("totalCost", { ascending: true, nullsFirst: false });
    else if (sort === "weight_desc") query = query.order("weight", { ascending: false, nullsFirst: false });
    else query = query.order("created_at", { ascending: false });

    // text search across the fields people actually remember
    if (q) {
      const safe = q.replace(/[,()]/g, " ").trim();
      let clauses =
        `styleNumber.ilike.%${safe}%,name.ilike.%${safe}%,manufacturerCode.ilike.%${safe}%,starting_description.ilike.%${safe}%`;

      // Sets have their own SKU (sample_sets.style_number), which isn't a
      // column on any sample, so searching it needs its own lookup: find the
      // sets whose SKU/name matches, then also match every sample that is a
      // member of one. The set card then shows up (the page already builds
      // set cards from whichever member samples are on screen).
      const { data: matchedSets, error: setSearchError } = await supabase
        .from("sample_sets")
        .select("id")
        .or(`style_number.ilike.%${safe}%,name.ilike.%${safe}%`);
      if (setSearchError) {
        console.error("Set search failed (searching samples only):", setSearchError);
      } else if (matchedSets?.length) {
        const { data: memberRows, error: memberError } = await supabase
          .from("sample_set_members")
          .select("sample_id")
          .in("set_id", matchedSets.map((s) => s.id));
        if (memberError) {
          console.error("Set member lookup failed (searching samples only):", memberError);
        } else if (memberRows?.length) {
          clauses += `,sample_id.in.(${memberRows.map((m) => m.sample_id).join(",")})`;
        }
      }

      query = query.or(clauses);
    }

    if (collection.length > 0) query = query.in("sample_collection", collection);
    // Filter on starting_info's type, not samples' -- samples.type is the
    // near-dead copy (9 records) while starting_info.type carries ~4,769.
    if (category.length > 0) query = query.in("starting_type", category);
    if (subcategory.length > 0) query = query.in("starting_category", subcategory);
    if (metals.length > 0) query = query.in("metalType", metals);
    if (chains.length > 0) query = query.in("necklace", chains);
    if (vendor) query = query.eq("vendor", vendor);
    if (karat) query = query.eq("karat", karat);
    if (backType) query = query.eq("back_type", backType);
    if (stoneType) query = query.contains("stones", [{ type: stoneType }]);
    if (stoneColor) query = query.contains("stones", [{ color: stoneColor }]);

    const { data, error, count } = await query;

    if (error) {
      console.error("Error fetching samples:", error);
      setIsLoading(false);
      return;
    }

    setSamples(data); // Replace samples with the current page's data
    setHasMore(data.length === PAGE_SIZE); // Check if there are more pages
    if (setTotalPages && count != null) setTotalPages(Math.max(1, Math.ceil(count / PAGE_SIZE)));
    if (setResultCount) setResultCount(count ?? null);
    setIsLoading(false);
  };
useEffect(()=>{
  console.log(selectedSamples,selectedSamples.size)
},[selectedSamples])
  // Fetch the first page on component mount
  // useEffect(() => {
  //   fetchSamples(0);
  // }, []);
  useEffect(() => {
    fetchSamples(page); // Fetch samples whenever the page or any filter changes
  }, [page, searchParams]);

  // Load set membership for whatever samples are on screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await fetchSetsForSamples(supabase, samples.map((s) => s.sample_id));
      if (cancelled) return;
      const have = new Set(samples.map((s) => s.sample_id));
      const missing = Object.keys(info.setIdBySample).map(Number).filter((id) => !have.has(id));
      let rows = {};
      samples.forEach((s) => { rows[s.sample_id] = s; });
      if (missing.length) {
        const { data } = await supabase.from("sample_with_stones_export").select("*").in("sample_id", missing);
        (data || []).forEach((r) => { rows[r.sample_id] = r; });
      }
      if (cancelled) return;
      setSetInfo(info);
      setSetRows(rows);
    })();
    return () => { cancelled = true; };
  }, [samples, setsTick]);

  const reloadSets = () => setSetsTick((t) => t + 1);

  // Bulk action: link the 2 or 3 selected samples (first picked = item 1).
  const handleLinkSelectedAsSet = async () => {
    const ids = Array.from(selectedSamples);
    // A set is in the selection: add the loose samples to THAT set instead
    // of making a new one (no need to unlink first).
    const pickedSetIds = [...new Set(ids.map((id) => setInfo.setIdBySample[id]).filter(Boolean))];
    if (pickedSetIds.length > 1) {
      showAlert(
        `Those samples belong to ${pickedSetIds.length} different sets. A set holds up to ${MAX_SET_ITEMS} items, so unlink one of them first.`,
        { title: "Add to set" }
      );
      return;
    }
    if (pickedSetIds.length === 1) {
      const set = setInfo.setsById[pickedSetIds[0]];
      const loose = ids.filter((id) => !setInfo.setIdBySample[id]);
      if (!loose.length) {
        showAlert("Select a sample that isn't in a set yet to add it to this one.", { title: "Add to set" });
        return;
      }
      if (set.memberIds.length + loose.length > MAX_SET_ITEMS) {
        showAlert(
          `"${set.style_number}" already has ${set.memberIds.length} items and a set holds up to ${MAX_SET_ITEMS}.`,
          { title: "Add to set" }
        );
        return;
      }
      const looseNames = loose.map((id) => (samples.find((s) => s.sample_id === id) || setRows[id])?.styleNumber).join(" + ");
      const style = await showPrompt(
        `Adding ${looseNames} to set "${set.style_number}" (it will have ${set.memberIds.length + loose.length} items). Set style number (change it to rename the set; tags already printed keep the old number):`,
        { title: "Add to set", defaultValue: set.style_number, confirmText: "Add" }
      );
      if (!style) return;
      try {
        await addSamplesToSet(supabase, set.id, loose);
        if (style.trim() !== set.style_number) await renameSet(supabase, set.id, style);
        showMessage(`Added ${looseNames} to "${style.trim()}"`);
        setSelectedSamples(new Set());
        setIsSelectionMode(false);
        reloadSets();
        // The set is already in SSP: send the new items now, as extra items
        // under the same SSP number (no new header).
        if (sspOn) {
          const existing = await getDataToExport(set.memberIds);
          const sspCode = (existing || []).map((r) => r.ssp_code).find(Boolean);
          if (sspCode) {
            const newRows = await getDataToExport(loose);
            const ordered = loose.map((id) => (newRows || []).find((r) => r.sample_id === id)).filter(Boolean);
            if (ordered.length) {
              const res = await runSspCreate(ordered, {
                set: { ...set, style_number: style.trim() },
                extend: { sspCode, startPosition: set.memberIds.length },
              });
              if (res?.created?.length) setSspSummary(res);
              if (res?.failed?.length)
                showAlert(
                  res.failed.map((f) => `${f.sample}: ${f.error}`).join("; ") + ". Run Create in SSP on the set to resume.",
                  { title: "Set item not fully created", variant: "warning" }
                );
            }
          }
        }
      } catch (e) {
        showAlert(String(e?.message || e), { title: "Could not add to set", variant: "error" });
      }
      return;
    }
    if (ids.length < 2 || ids.length > MAX_SET_ITEMS) {
      showAlert(`Pick 2 to ${MAX_SET_ITEMS} samples to link as a set.`, { title: "Link as set" });
      return;
    }
    if (ids.some((id) => setInfo.setIdBySample[id])) {
      showAlert("One of these samples is already in a set. Unlink that set first.", { title: "Link as set" });
      return;
    }
    const rows = ids.map((id) => samples.find((s) => s.sample_id === id) || setRows[id]);
    const suggestion = suggestSetStyle(rows.map((r) => r?.styleNumber));
    const style = await showPrompt(
      `Style number for the set (${rows.map((r, i) => `item ${i + 1}: ${r?.styleNumber}`).join(", ")}):`,
      { title: "Link as set", defaultValue: suggestion, confirmText: "Link" }
    );
    if (!style) return;
    try {
      await linkSamplesAsSet(supabase, { styleNumber: style, sampleIds: ids });
      showMessage(`Linked ${rows.map((r) => r?.styleNumber).join(" + ")} as "${style.trim()}"`);
      setSelectedSamples(new Set());
      setIsSelectionMode(false);
      reloadSets();
    } catch (e) {
      showAlert(String(e?.message || e), { title: "Could not link", variant: "error" });
    }
  };

  const handleUnlinkSet = async (set) => {
    if (!(await showConfirm(`Unlink "${set.style_number}"? The samples stay; they just show as separate cards again.`, { confirmText: "Unlink" }))) return;
    try {
      await unlinkSet(supabase, set.id);
      reloadSets();
    } catch (e) {
      showAlert(String(e?.message || e), { title: "Could not unlink", variant: "error" });
    }
  };

  // Two items: swap them. Three: rotate (1,2,3 -> 2,3,1) -- press again to keep cycling.
  const handleSwapSet = async (set, members) => {
    try {
      const ids = members.map((m) => m.sample_id);
      await reorderSet(supabase, set.id, ids.length === 2 ? [ids[1], ids[0]] : [...ids.slice(1), ids[0]]);
      reloadSets();
    } catch (e) {
      showAlert(String(e?.message || e), { title: "Could not swap", variant: "error" });
    }
  };

  // What the selection counts as to a person: a linked set is one card, so it
  // counts once however many member samples it holds (3 sets = 3, not 7).
  const selectedUnitCount = (() => {
    const setsSeen = new Set();
    let loose = 0;
    selectedSamples.forEach((id) => {
      const sid = setInfo.setIdBySample[id];
      if (sid) setsSeen.add(sid);
      else loose += 1;
    });
    return setsSeen.size + loose;
  })();

  // Selection mode: tapping a set card selects/deselects both its samples.
  const toggleSetSelection = (set, members) => {
    const next = new Set(selectedSamples);
    const allIn = members.every((m) => next.has(m.sample_id));
    members.forEach((m) => (allIn ? next.delete(m.sample_id) : next.add(m.sample_id)));
    setSelectedSamples(next);
  };

  // ---- Set card menu: the set acts as ONE item (same controls as a normal card) ----
  // A set prints ONE tag under the set's own identity: the tag's style number
  // (and so its QR) is the set's style number, not any member's. The other tag
  // fields (weight, metal, plating, MFG#) come from item 1. Scanning the tag
  // finds the set (see ScanToOpen). To tag a single member, unlink the set.
  const handlePrintSet = async (set, members) => {
    try {
      const setRow = { ...members[0], styleNumber: set.style_number };
      const mode = await printTags([setRow], DEFAULT_PRINT_OPTIONS);
      showMessage(`${printResultMessage(mode, 1)} (${set.style_number})`);
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    }
  };

  const handleSyncSetToQb = async (set, members) => {
    if (!qbOn) return;
    try {
      let created = 0;
      let updated = 0;
      for (const m of members) {
        const res = await syncItemForSample(m, { settings, vendors, supabase });
        if (res.created) created++;
        else if (res.updated) updated++;
      }
      showMessage(`QuickBooks, set "${set.style_number}": ${created} created, ${updated} updated`);
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  };

  // Create the whole set in SSP: ONE SSP number, item 1 = first member,
  // item 2 = second. Resumable the same way a single sample is (the SSP
  // number + item ids are saved on each member's row).
  const handleCreateSetInSsp = async (set, members) => {
    if (!sspOn || sspSetCreating.has(set.id)) return;
    const id = set.id;
    setSspSetCreating((prev) => new Set(prev).add(id));
    setSspProgressBySet((prev) => ({ ...prev, [id]: { steps: [], statusByStep: {} } }));
    try {
      const rows = await getDataToExport(members.map((m) => m.sample_id));
      const ordered = members.map((m) => (rows || []).find((r) => r.sample_id === m.sample_id)).filter(Boolean);
      if (ordered.length !== members.length) throw new Error("Could not load both samples of the set.");
      const res = await runSspCreate(ordered, {
        set,
        onPlan: (plan) =>
          setSspProgressBySet((prev) => ({
            ...prev,
            [id]: { steps: plan.flatMap((st, i) => st.map((x) => `${i}:${x}`)), statusByStep: {} },
          })),
        onProgress: (p) =>
          setSspProgressBySet((prev) => ({
            ...prev,
            [id]: {
              steps: prev[id]?.steps || [],
              statusByStep: { ...(prev[id]?.statusByStep || {}), [`${p.index}:${p.step}`]: p.status },
            },
          })),
      });
      if (res) {
        setSspSummary(res);
        const hit = res.created[0];
        if (hit) {
          const warnCount = res.created.reduce((n, c) => n + (c.warnings?.length || 0), 0);
          showMessage(
            `Created set "${set.style_number}" in SSP \u2014 ${hit.sspCode} (hold queue), ${res.created.length} of ${members.length} items` +
              (warnCount ? ` \u2014 ${warnCount} warning(s), see the summary` : "")
          );
        }
        if (res.failed.length) {
          showAlert(
            `${res.failed.length} item(s) did not finish: ` + res.failed.map((f) => `${f.sample}: ${f.error}`).join("; ") +
              ". Run Create in SSP on the set again to resume where it stopped.",
            { title: "Set partly created", variant: "warning" }
          );
        }
      }
    } catch (e) {
      showAlert(String(e?.message || e), { title: "SSP error", variant: "error" });
    } finally {
      setSspSetCreating((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setTimeout(() => {
        setSspProgressBySet((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 2500);
    }
  };

  // Duplicate the whole set: each member is cloned ("<style>-copy", auto-numbered
  // if taken) and the two copies are linked as a new set.
  const handleDuplicateSet = async (set, members) => {
    const newSetStyle = await showPrompt("Style number for the duplicated set:", {
      title: "Duplicate set",
      defaultValue: `${set.style_number}-copy`,
      confirmText: "Duplicate",
    });
    if (!newSetStyle || !newSetStyle.trim()) return;
    const newIds = [];
    try {
      for (const m of members) {
        const base = m.styleNumber || `sample-${m.sample_id}`;
        let name = `${base}-copy`;
        let attempt = 2;
        for (let tries = 0; tries < 25; tries++) {
          try {
            const r = await duplicateSample(supabase, m, name);
            newIds.push(r.newSampleId);
            break;
          } catch (e) {
            if (String(e?.message || "").includes("already in use")) {
              name = `${base}-copy${attempt++}`;
              continue;
            }
            throw e;
          }
        }
      }
      if (newIds.length !== members.length) throw new Error("Could not find free style numbers for the copies.");
      await linkSamplesAsSet(supabase, { styleNumber: newSetStyle.trim(), sampleIds: newIds });
      window.location.reload();
    } catch (e) {
      showAlert(
        String(e?.message || e) + (newIds.length ? ` (${newIds.length} copy/copies were created but not linked.)` : ""),
        { title: "Duplicate set error", variant: "error" }
      );
    }
  };

  // Delete the whole set: BOTH samples (with their starting_info, stones, image
  // links) and the set record. One confirm for the set.
  const handleDeleteSet = async (set, members) => {
    const names = members.map((m) => m.styleNumber).join(" + ");
    if (!(await showConfirm(
      `Delete set "${set.style_number}" and BOTH of its samples (${names})? This removes the samples, their starting_info, stones, and image links. This cannot be undone.`,
      { confirmText: "Delete both", variant: "error" }
    ))) return;
    try {
      await unlinkSet(supabase, set.id);
      for (const m of members) {
        if (m.starting_info_id) {
          await supabase.from("image_link").delete().eq("entity", "starting_info").eq("entityId", m.starting_info_id);
          await supabase.from("stones").delete().eq("starting_info_id", m.starting_info_id);
        }
        const { error } = await supabase.from("samples").delete().eq("id", m.sample_id);
        if (error) throw new Error(error.message);
        if (m.starting_info_id) await supabase.from("starting_info").delete().eq("id", m.starting_info_id);
      }
      const gone = new Set(members.map((m) => m.sample_id));
      setSamples((prev) => prev.filter((x) => !gone.has(x.sample_id)));
      reloadSets();
    } catch (e) {
      showAlert(String(e?.message || e), { title: "Error deleting set", variant: "error" });
      reloadSets();
    }
  };

  // "Create in SSP" for a set (one SSP, several items) isn't built yet --
  // block it so a set's samples don't each become their own separate SSP.
  const setBlocksSsp = (ids) => {
    const hit = ids.find((id) => setInfo.setIdBySample[id]);
    if (hit == null) return false;
    showAlert(
      "This sample is part of a linked set. Use Create set in SSP on the set card (or select the whole set) so it goes to SSP as one SSP number with one item per sample. Unlink the set to create the samples individually.",
      { title: "Create in SSP" }
    );
    return true;
  };

  // Handle page navigation


  const getDataToExport = async (arrayOfProducts) => {
    console.log(arrayOfProducts)
    try {
      // Fetch samples and their starting_info
      const { data: samplesData, error: sampleDataError } = await supabase
        .from("sample_with_stones_export")
        .select("*")
        .in(
          "sample_id",
          arrayOfProducts
        );

      if (sampleDataError) {
        console.error("Error fetching samples:", sampleDataError);
        return [];
      }
      console.log(samplesData)
      return samplesData; // Return samples with their stones
    } catch (error) {
      console.error("Error in getDataToExport:", error);
      throw new Error(error)
      // return [];
    }
  };

  const fetchAllRows = async () => {
  let allRows = [];
  let batchSize = 1000;
  let start = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('sample_with_stones_export')
      .select('*')
      .range(start, start + batchSize - 1);

    if (error) {
      console.error('Error fetching data:', error);
      break;
    }

    allRows = allRows.concat(data);
    hasMore = data.length === batchSize;
    start += batchSize;
  }

  return allRows;
};
  const getDropDownData = async () => {
    const { data, error } = await supabase.rpc("get_dropdown_options");

    if (error) {
      showMessage("Issue with retriving dropdown options");
    }
    return data;
  };

  // SSP's free-text sub-category list (fashion/hoop/cartilage/etc, ~130 values) --
  // not part of get_dropdown_options, used to give the export's Category column a
  // dropdown too.
  const getSspCategoryOptions = async () => {
    const { data, error } = await supabase
      .from("ssp_product_categories")
      .select("category")
      .eq("is_active", true);
    if (error) {
      showMessage("Issue with retriving SSP category options");
      return [];
    }
    const names = Array.from(new Set((data || []).map((r) => r.category).filter(Boolean))).sort();
    return names.map((name) => ({ name }));
  };
  const handleExport = async (type='') => {
    // const samplesToExport = samples.filter((p) => selectedSamples.has(p.sample_id));
    const samplesToExport = Array.from(selectedSamples)

    console.log(samplesToExport,samplesToExport.length)
    // let dataToExport = await fetchAllRows()
    let dataToExport =type==='all'? await fetchAllRows() : await getDataToExport(samplesToExport);
    let dropdowns = await getDropDownData();
    const sspCategory = await getSspCategoryOptions();
    dropdowns = {
      ...dropdowns,
      color: options?.stonePropertiesForm?.color.map((option) => ({ name: option })),
      type: options?.stonePropertiesForm?.type.map((option) => ({ name: option })),
      backType: options?.formFields?.backType.map((option) => ({ name: option })),
      sspCategory,
    };

    exportData(dataToExport, dropdowns, "samples");
    setSelectedSamples(new Set());
    setIsSelectionMode(false);
  }; 
   

   const toggleSampleSelection = (sample) => {
    const newSelection = new Set(selectedSamples);
    if (newSelection.has(sample.sample_id)) {
      console.log('already selected', sample.sample_id);
      newSelection.delete(sample.sample_id);
    } else {
      console.log('not selected, adding', sample.sample_id);
      newSelection.add(sample.sample_id);
    }
    setSelectedSamples(newSelection);
  };
  
  const [isPrinting, setIsPrinting] = useState(false);

  // Single tag - the card row is already a sample_with_stones_export row.
  const handlePrintOne = async (sample) => {
    try {
      const mode = await printTags([sample], DEFAULT_PRINT_OPTIONS);
      showMessage(printResultMessage(mode, 1));
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    }
  };

  // 3-dot card menu "Sync to QB" — one sample, no need to open the modal or
  // enter selection mode first. Creates the Item if it's missing, updates it
  // if it's already there. The card row is already a sample_with_stones_export
  // row, so it matches qbItems.js's expected shape directly. GATED.
  const handleSyncOneToQb = async (sample) => {
    if (!qbOn) return;
    const id = sample.sample_id;
    if (syncingIds.includes(id)) return;
    try {
      const res = await syncItemForSample(sample, { settings, vendors, supabase });
      if (res.created) showMessage(`Created "${sample.styleNumber}" in QuickBooks`);
      else if (res.updated) showMessage(`Updated "${sample.styleNumber}" in QuickBooks`);
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  };

  // Batch - fetch full rows for the selected ids (handles selections across pages).
  const handlePrintSelected = async () => {
    const ids = Array.from(selectedSamples);
    if (ids.length === 0) return;
    setIsPrinting(true);
    try {
      const fetched = await getDataToExport(ids);
      if (!fetched || fetched.length === 0) { showMessage("Nothing to print"); return; }
      // A set prints ONE tag under the set's own style number (same as the
      // set card's Print button), not one per member sample.
      const doneSets = new Set();
      const rows = [];
      fetched.forEach((r) => {
        const sid = setInfo.setIdBySample[r.sample_id];
        if (!sid) { rows.push(r); return; }
        if (doneSets.has(sid)) return;
        doneSets.add(sid);
        const set = setInfo.setsById[sid];
        const item1 = fetched.find((x) => x.sample_id === set.memberIds[0]) || r;
        rows.push({ ...item1, styleNumber: set.style_number });
      });
      const mode = await printTags(rows, DEFAULT_PRINT_OPTIONS);
      showMessage(printResultMessage(mode, rows.length));
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    } finally {
      setIsPrinting(false);
    }
  };

  // Create a QB Item for each selected sample. Existing items are skipped
  // and reported (never overwritten). GATED — only reachable when the
  // Settings toggle is on. Fetches full rows so a selection spanning pages
  // still gets correct styleNumber/totalCost/manufacturerCode data.
  const handleCreateItemsInQb = async () => {
    if (!qbOn || qbBusy) return;
    const ids = Array.from(selectedSamples);
    if (ids.length === 0) return;
    const ok = await showConfirm(
      `Create ${ids.length} item${ids.length === 1 ? "" : "s"} in QuickBooks? Any that already exist are skipped.`,
      { title: "Create in QuickBooks", confirmText: "Create" }
    );
    if (!ok) return;
    setQbSummary(null);
    try {
      const rows = await getDataToExport(ids);
      const res = await createItemsForSamples(rows || [], { settings, vendors, supabase });
      setQbSummary({ kind: "create", ...res });
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  };

  // Push current PLM data (description, cost, manufacturer code) onto each
  // selected sample's QB Item — updates it if it's there, creates it first
  // if it isn't. GATED.
  const handleUpdateItemsInQb = async () => {
    if (!qbOn || qbUpdateBusy) return;
    const ids = Array.from(selectedSamples);
    if (ids.length === 0) return;
    const ok = await showConfirm(
      `Update ${ids.length} item${ids.length === 1 ? "" : "s"} in QuickBooks with the current PLM data? Any without an existing item are created.`,
      { title: "Update in QuickBooks", confirmText: "Update" }
    );
    if (!ok) return;
    setQbSummary(null);
    try {
      const rows = await getDataToExport(ids);
      const res = await updateItemsForSamples(rows || [], { settings, vendors, supabase });
      setQbSummary({ kind: "update", ...res });
    } catch (e) {
      showAlert(String(e?.message || e), { title: "QuickBooks error", variant: "error" });
    }
  };

  // Shared SSP create runner — prepares payloads (with per-sample warnings),
  // asks for confirmation, then sends. A sample that was never sent to SSP
  // before mints a NEW SSP number; a sample already linked (samples.ssp_code,
  // set the first time it was sent) gets UPDATED in place instead — see
  // sendPreparedSspCreates. New products land in SKU Manager's hold queue as
  // "Pending Vendor Submission".
  const runSspCreate = async (rows, { onProgress, onPlan, set = null, extend = null } = {}) => {
    const prep = set
      ? await prepareSspSetCreate(rows, set.style_number, { supabase, settings, extend })
      : await prepareSspCreatesForSamples(rows, { supabase, settings });
    if (!prep.enabled) return null;
    if (prep.prepared.length === 0) {
      showAlert(
        prep.failed.length > 0 ? (
          <div className="space-y-2">
            <p>
              Nothing was sent — {prep.failed.length} item{prep.failed.length === 1 ? "" : "s"} failed validation:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-gray-700">
              {prep.failed.map((f) => (
                <li key={f.sample}>
                  <strong>{f.sample}:</strong> {f.error}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          "Nothing to create."
        ),
        { title: "Nothing sent to SSP", variant: "error" }
      );
      return null;
    }
    const alreadyLinked = prep.prepared.filter((p) => p.sample?.ssp_code);
    const brandNew = prep.prepared.length - alreadyLinked.length;
    const withWarnings = prep.prepared.filter((p) => p.warnings.length).slice(0, 8);
    const itemWord = prep.prepared.length === 1 ? "item" : "items";
    const ok = await showConfirm(
      <div className="space-y-3">
        {set && extend ? (
          <p>
            Add <strong>{prep.prepared.map((p) => p.label).join(" + ")}</strong> to set <strong>{set.style_number}</strong>{" "}
            in Signet SSP as {prep.prepared.length === 1 ? "a new item" : "new items"} under <strong>{extend.sspCode}</strong>?
          </p>
        ) : set ? (
          <p>
            Send set <strong>{set.style_number}</strong> to Signet SSP as <strong>one SSP number</strong> with{" "}
            <strong>{prep.prepared.length}</strong> items ({prep.prepared.map((p) => p.label).join(" + ")})?
          </p>
        ) : (
          <p>
            Send <strong>{prep.prepared.length}</strong> {itemWord} to Signet SSP?
          </p>
        )}
        <p className="text-gray-600">
          {alreadyLinked.length ? (
            <>
              <strong>{brandNew}</strong> new, <strong>{alreadyLinked.length}</strong> update
              {alreadyLinked.length === 1 ? "" : "s"} to an already-linked SSP number
              {alreadyLinked.length === 1 ? "" : "s"}:{" "}
              {alreadyLinked.map((p) => `${p.label} → ${p.sample.ssp_code}`).join(", ")}
            </>
          ) : (
            <>
              All {prep.prepared.length} are new — this mints {prep.prepared.length === 1 ? "a new SSP number" : "new SSP numbers"}.
            </>
          )}
        </p>
        <p className="text-gray-600">
          Header + item + material (plus stones and photos, when the sample has them) come from the sample.
          Findings and labor are finished in SKU Manager.
        </p>
        {withWarnings.length ? (
          <div>
            <p className="font-medium text-amber-700">Heads-up</p>
            <ul className="mt-1 space-y-1 list-disc pl-5 text-gray-700">
              {withWarnings.map((p) => (
                <li key={p.label}>
                  <strong>{p.label}:</strong> {p.warnings.join("; ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {prep.failed.length ? (
          <p className="text-red-700">
            <strong>Skipped:</strong> {prep.failed.map((f) => f.sample).join(", ")}
          </p>
        ) : null}
      </div>,
      { title: "Send to SSP", confirmText: "Send" }
    );
    if (!ok) return null;
    if (onPlan) onPlan(prep.prepared.map((p) => sspStepsForPrepared(p)));
    const res = await sendPreparedSspCreates(prep.prepared, { settings, supabase, onProgress });
    return { ...res, failed: [...prep.failed, ...res.failed] };
  };

  // 3-dot card menu "Create in SSP" — one sample. GATED.
  const handleCreateOneInSsp = async (sample) => {
    if (!sspOn) return;
    const id = sample.sample_id;
    if (setBlocksSsp([id])) return;
    if (sspCardCreating.has(id)) return;
    setSspCardCreating((prev) => new Set(prev).add(id));
    setSspProgressBySample((prev) => ({ ...prev, [id]: { steps: [], statusByStep: {} } }));
    try {
      const res = await runSspCreate([sample], {
        onProgress: (p) => {
          setSspProgressBySample((prev) => ({
            ...prev,
            [id]: {
              steps: p.steps,
              statusByStep: { ...(prev[id]?.statusByStep || {}), [p.step]: p.status },
            },
          }));
        },
      });
      if (res) {
        setSspSummary(res);
        const hit = res.created[0];
        if (hit) {
          const warnNote = hit.warnings?.length ? ` — ${hit.warnings.join("; ")}` : "";
          showMessage(`Created "${hit.sample}" in SSP — ${hit.sspCode} (hold queue)${warnNote}`);
        }
      }
    } catch (e) {
      showAlert(String(e?.message || e), { title: "SSP error", variant: "error" });
    } finally {
      setSspCardCreating((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Leave the finished ring (green or red) visible briefly instead of
      // snapping it away the instant the promise resolves, then clear so
      // a later click starts from an empty ring rather than a stale one.
      setTimeout(() => {
        setSspProgressBySample((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 2500);
    }
  };

  // Batch "Create in SSP" for the selection. Fetches full rows so a
  // selection spanning pages still gets complete data. GATED.
  const handleCreateSelectedInSsp = async () => {
    if (!sspOn || sspBusy) return;
    const ids = Array.from(selectedSamples);
    if (ids.length === 0) return;
    // Whole sets in the selection go to SSP AS sets (one SSP number, one item
    // per sample); everything else is created as separate items as before.
    // A set only partly selected is refused rather than split up.
    const pickedSetIds = [...new Set(ids.map((id) => setInfo.setIdBySample[id]).filter(Boolean))];
    const partial = pickedSetIds.map((sid) => setInfo.setsById[sid]).filter(
      (st) => st && !st.memberIds.every((m) => selectedSamples.has(m))
    );
    if (partial.length) {
      showAlert(
        `Set "${partial[0].style_number}" is only partly selected. Select every item of the set (click the set card) or none of it, so it isn't split into separate SSP items.`,
        { title: "Create in SSP" }
      );
      return;
    }
    const looseIds = ids.filter((id) => !setInfo.setIdBySample[id]);
    setSspBusy(true);
    setSspSummary(null);
    try {
      for (const sid of pickedSetIds) {
        const st = setInfo.setsById[sid];
        const members = st.memberIds.map((m) => setRows[m]).filter(Boolean);
        if (members.length !== st.memberIds.length) throw new Error(`Still loading the items of set "${st.style_number}" -- try again in a moment.`);
        await handleCreateSetInSsp(st, members);
      }
      if (!looseIds.length) return;
      const rows = await getDataToExport(looseIds);
      const res = await runSspCreate(rows || []);
      if (res) setSspSummary(res);
    } catch (e) {
      showAlert(String(e?.message || e), { title: "SSP error", variant: "error" });
    } finally {
      setSspBusy(false);
    }
  };

  // Bulk-duplicate every selected sample. Auto-picks a free
  // "<styleNumber>-copy[N]" for each rather than prompting per item --
  // this is for spinning up several test/variant samples quickly, not a
  // precision rename tool (use the per-card Duplicate for that).
  const handleDuplicateSelected = async () => {
    if (dupBusy) return;
    const allIds = Array.from(selectedSamples);
    if (allIds.length === 0) return;
    // A set is duplicated as a whole set (every member cloned, copies linked
    // as a new set "<set>-copy"), not as loose samples. Anything selected that
    // isn't in a set is duplicated one by one as before.
    const setIdsPicked = [...new Set(allIds.map((id) => setInfo.setIdBySample[id]).filter(Boolean))];
    const ids = allIds.filter((id) => !setInfo.setIdBySample[id]);
    const ok = await showConfirm(
      [
        setIdsPicked.length ? `${setIdsPicked.length} set${setIdsPicked.length === 1 ? "" : "s"}` : "",
        ids.length ? `${ids.length} sample${ids.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" and ") +
        ` will be duplicated. Each copy gets its own new style number ("<original>-copy", auto-numbered if that's taken) and starts with no location set; each set's copies are linked as a new set.`,
      { title: "Duplicate", confirmText: "Duplicate" }
    );
    if (!ok) return;
    setDupBusy(true);
    setDupSummary(null);
    try {
      const rows = ids.length ? await getDataToExport(ids) : [];
      const created = [];
      const failed = [];
      for (const sid of setIdsPicked) {
        const set = setInfo.setsById[sid];
        const members = set.memberIds.map((id) => setRows[id]).filter(Boolean);
        const newIds = [];
        try {
          if (members.length !== set.memberIds.length) throw new Error("Set members are still loading.");
          for (const m of members) {
            const base = m.styleNumber || `sample-${m.sample_id}`;
            let name = `${base}-copy`;
            let attempt = 2;
            for (let tries = 0; tries < 25; tries++) {
              try {
                const r = await duplicateSample(supabase, m, name);
                newIds.push(r.newSampleId);
                break;
              } catch (e) {
                if (String(e?.message || "").includes("already in use")) { name = `${base}-copy${attempt++}`; continue; }
                throw e;
              }
            }
          }
          if (newIds.length !== members.length) throw new Error("Could not find free style numbers for the copies.");
          let setStyle = `${set.style_number}-copy`;
          let setAttempt = 2;
          for (let tries = 0; tries < 25; tries++) {
            try {
              await linkSamplesAsSet(supabase, { styleNumber: setStyle, sampleIds: newIds });
              break;
            } catch (e) {
              if (String(e?.message || "").includes("already exists")) { setStyle = `${set.style_number}-copy${setAttempt++}`; continue; }
              throw e;
            }
          }
          created.push({ sample: set.style_number, newStyleNumber: setStyle });
        } catch (e) {
          failed.push({
            sample: set.style_number,
            error: String(e?.message || e) + (newIds.length ? ` (${newIds.length} copy/copies were created but not linked.)` : ""),
          });
        }
      }
      for (const row of rows || []) {
        const base = row.styleNumber || `sample-${row.sample_id}`;
        let newStyleNumber = `${base}-copy`;
        let attempt = 2;
        let lastError = null;
        // duplicateSample itself rejects an already-used style number --
        // walk -copy2, -copy3, ... until one lands or we give up.
        for (let tries = 0; tries < 25; tries++) {
          try {
            await duplicateSample(supabase, row, newStyleNumber);
            created.push({ sample: base, newStyleNumber });
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            if (String(e?.message || "").includes("already in use")) {
              newStyleNumber = `${base}-copy${attempt++}`;
              continue;
            }
            break; // a real error, not a naming collision -- stop retrying this row
          }
        }
        if (lastError) failed.push({ sample: base, error: String(lastError?.message || lastError) });
      }
      setDupSummary({ created, failed });
      if (created.length > 0) window.location.reload();
    } catch (e) {
      showAlert(String(e?.message || e), { title: "Duplicate error", variant: "error" });
    } finally {
      setDupBusy(false);
    }
  };

  if(isLoading){
    return <Loading />

  }
  return (
    <div>
      {/* Sticky just under the page header bar so Select/Export/Print stay
          reachable while scrolling */}
      <div className="sticky sample-list-action-bar z-20 bg-gray-100">
      <ViewableListActionButtons
        isSelectionMode={isSelectionMode}
        setIsSelectionMode={setIsSelectionMode}
        handleSelections={(selected) => setSelectedSamples(selected)}
        handleExport={handleExport}
        handleExportAll={() => handleExport('all')}
        onDelete={(deletedSelectedItems) =>
          setSamples(samples.filter((s) => !deletedSelectedItems.includes(s.id)))
        }
        allItems={samples.map((s) => s.sample_id)}
        selectedItems={selectedSamples}
        selectedCount={selectedUnitCount}
        type="Samples"
        selectedActions={[
          selectedSamples.size >= 2 && {
            key: "link-set",
            label: Array.from(selectedSamples).some((id) => setInfo.setIdBySample[id])
              ? `Add to set (+${Array.from(selectedSamples).filter((id) => !setInfo.setIdBySample[id]).length})`
              : `Link as set (${selectedSamples.size})`,
            icon: Link2,
            onClick: handleLinkSelectedAsSet,
            description: "One card for the picked items, e.g. studs + necklace. Pick item 1 first.",
          },
          {
            key: "print-tags",
            label: `Print Tags (${selectedUnitCount})`,
            icon: Printer,
            onClick: handlePrintSelected,
            busy: isPrinting,
            busyLabel: "Printing\u2026",
            description: "Send a tag for each selected sample to the Zebra",
          },
          qbOn && {
            key: "qb-create",
            label: `Create in QB (${selectedUnitCount})`,
            icon: Landmark,
            onClick: handleCreateItemsInQb,
            busy: qbBusy,
            busyLabel: "Creating in QB\u2026",
            description: "New QuickBooks item per sample; existing ones are skipped",
          },
          qbOn && {
            key: "qb-update",
            label: `Update in QB (${selectedUnitCount})`,
            icon: RefreshCw,
            onClick: handleUpdateItemsInQb,
            busy: qbUpdateBusy,
            busyLabel: "Updating in QB\u2026",
            description: "Push current PLM data onto each item, creating any that are missing",
          },
          sspOn && {
            key: "ssp-create",
            label: `Create in SSP (${selectedUnitCount})`,
            icon: UploadCloud,
            onClick: handleCreateSelectedInSsp,
            busy: sspBusy,
            busyLabel: "Creating in SSP\u2026",
            description: "New item in SKU Manager's hold queue \u2014 finish the rest there",
          },
          {
            key: "duplicate",
            label: `Duplicate (${selectedUnitCount})`,
            icon: Copy,
            onClick: handleDuplicateSelected,
            busy: dupBusy,
            busyLabel: "Duplicating\u2026",
            description: "Clone each selected sample under its own new style number",
          },
        ]}
      />
      {qbSummary && (
        <div className="px-4 py-2 border-b border-gray-200 bg-[#faf6ef] text-xs text-gray-700 flex items-start gap-3 flex-wrap">
          <span className="font-medium">QuickBooks {qbSummary.kind === "update" ? "update" : "create"}:</span>
          {qbSummary.kind === "update" ? (
            <>
              <span className="text-green-700">{qbSummary.updated.length} updated</span>
              {qbSummary.created.length > 0 && (
                <span className="text-amber-700">
                  {qbSummary.created.length} created (weren't in QB yet):{" "}
                  {qbSummary.created.slice(0, 8).map((f) => f.sample).join(", ")}
                  {qbSummary.created.length > 8 ? "\u2026" : ""}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-green-700">{qbSummary.created.length} created</span>
              <span className="text-amber-700">{qbSummary.existed.length} already existed</span>
            </>
          )}
          {qbSummary.failed.length > 0 && (
            <span className="text-red-700">
              {qbSummary.failed.length} failed:{" "}
              {qbSummary.failed.slice(0, 6).map((f) => `${f.sample} (${f.error})`).join("; ")}
              {qbSummary.failed.length > 6 ? "\u2026" : ""}
            </span>
          )}
          <button
            onClick={() => setQbSummary(null)}
            className="ml-auto text-gray-400 hover:text-gray-600"
            title="Dismiss"
          >
            \u00d7
          </button>
        </div>
      )}
      {sspSummary && (
        <div className="px-4 py-3 border-b border-gray-200 bg-[#eff4ff] text-xs text-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-medium text-gray-800">SSP create results</span>
            {sspSummary.created.length > 0 && (
              <span className="text-green-700">
                {sspSummary.created.length} created
              </span>
            )}
            {sspSummary.failed.length > 0 && (
              <span className="text-red-700">
                {sspSummary.created.length > 0 ? "\u00b7 " : ""}
                {sspSummary.failed.length} failed
              </span>
            )}
            <button
              onClick={() => setSspSummary(null)}
              className="ml-auto text-gray-400 hover:text-gray-600"
              title="Dismiss"
            >
              \u00d7
            </button>
          </div>
          {(sspSummary.created.length > 0 || sspSummary.failed.length > 0) && (
            <div className="max-h-56 overflow-y-auto space-y-2 pr-1 border-t border-blue-100 pt-2">
              {sspSummary.created.map((c) => (
                <div key={`ok-${c.sample}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-green-700 font-medium">\u2713 {c.sample}</span>
                    <span className="text-gray-500">\u2192 {c.sspCode}</span>
                  </div>
                  {c.warnings?.length > 0 && (
                    <ul className="list-disc pl-6 mt-0.5 space-y-0.5 text-amber-700">
                      {c.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {sspSummary.failed.map((f) => (
                <div key={`fail-${f.sample}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-red-700 font-medium">\u2717 {f.sample}</span>
                    {f.sspCode && <span className="text-gray-500">(partial \u2014 {f.sspCode})</span>}
                  </div>
                  <p className="pl-6 text-red-700">{f.error}</p>
                </div>
              ))}
            </div>
          )}
          {sspSummary.created.length > 0 && (
            <p className="text-gray-500 mt-2">Review new or updated items in the SSP hold queue.</p>
          )}
        </div>
      )}
      {dupSummary && (
        <div className="px-4 py-2 border-b border-gray-200 bg-[#f6f0ff] text-xs text-gray-700 flex items-start gap-3 flex-wrap">
          <span className="font-medium">Duplicate:</span>
          {dupSummary.created.length > 0 && (
            <span className="text-green-700">
              {dupSummary.created.length} created:{" "}
              {dupSummary.created.slice(0, 8).map((c) => `${c.sample} \u2192 ${c.newStyleNumber}`).join(", ")}
              {dupSummary.created.length > 8 ? "\u2026" : ""}
            </span>
          )}
          {dupSummary.failed.length > 0 && (
            <span className="text-red-700">
              {dupSummary.failed.length} failed:{" "}
              {dupSummary.failed.slice(0, 6).map((f) => `${f.sample}: ${f.error}`).join("; ")}
              {dupSummary.failed.length > 6 ? "\u2026" : ""}
            </span>
          )}
          <button
            onClick={() => setDupSummary(null)}
            className="ml-auto text-gray-400 hover:text-gray-600"
            title="Dismiss"
          >
            \u00d7
          </button>
        </div>
      )}
      </div>

      <div className="flex flex-col">
        <div className="h-full grid grid-flow-row-dense grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {samples.map((sample) => 
          
          {
            // A linked set renders as ONE card, at the spot of its first
            // member on this page; the other member is skipped.
            const setId = setInfo.setIdBySample[sample.sample_id];
            const set = setId ? setInfo.setsById[setId] : null;
            if (set) {
              const firstHere = set.memberIds.find((id) => samples.some((x) => x.sample_id === id));
              if (firstHere !== sample.sample_id) return null;
              const members = set.memberIds.map((id) => setRows[id]).filter(Boolean);
              if (members.length === set.memberIds.length) {
                return <SampleSetCard
                  key={`set-${set.id}`}
                  set={set}
                  members={members}
                  selectable={isSelectionMode}
                  selected={members.every((m) => selectedSamples.has(m.sample_id))}
                  onToggleSelect={toggleSetSelection}
                  onOpenSample={onSampleClick}
                  onUnlink={handleUnlinkSet}
                  onSwap={handleSwapSet}
                  onDuplicate={handleDuplicateSet}
                  onPrintTag={handlePrintSet}
                  qbOn={qbOn}
                  qbSyncing={members.some((m) => syncingIds.includes(m.sample_id))}
                  onSyncToQb={handleSyncSetToQb}
                  sspOn={sspOn}
                  sspCreating={sspSetCreating.has(set.id)}
                  sspProgress={sspProgressBySet[set.id] || null}
                  onCreateInSsp={handleCreateSetInSsp}
                  onDelete={handleDeleteSet}
                />;
              }
              // members still loading: fall through and show the plain card
            }
            // console.log(selectedSamples,'selected samples')
            // console.log([...selectedSamples].some(s=> s.sample_id === sample.sample_id),sample.sample_id,'selected')

            return <SampleCard
            key={sample.sample_id}
            sample={sample}
            onClick={isSelectionMode ? toggleSampleSelection : onSampleClick}
            selected={selectedSamples.has(sample.sample_id)}
            selectable={isSelectionMode} onDuplicate={onDuplicate}
 onDelete={onDeleteSample}
            onPrintTag={handlePrintOne}
            qbOn={qbOn}
            qbSyncing={syncingIds.includes(sample.sample_id)}
            onSyncToQb={handleSyncOneToQb}
            sspOn={sspOn}
            sspCreating={sspCardCreating.has(sample.sample_id)}
            sspProgress={sspProgressBySample[sample.sample_id] || null}
            onCreateInSsp={handleCreateOneInSsp}
            />
          }
          )}
        </div>
        
        
      </div>
    </div>
  );
};

