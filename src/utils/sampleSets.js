// Sample sets -- one product card that links 2+ samples (e.g. a stud + its
// matching necklace) so they can later go to SSP as ONE SSP with several
// items. Tables: sample_sets (the card) and sample_set_members (which samples
// are in it, `position` = SSP itemId order). A sample belongs to at most one
// set. See supabase/migrations/20261001190000_sample_sets.sql.

// A set links 2 to 3 samples (item 1, item 2, item 3). Raise this if a bigger
// set is ever needed; the table and the SSP push already handle any count.
export const MAX_SET_ITEMS = 3;

// ["GP5mmE", "GP5mmNK"] -> "GP5mmE/NK-SET"; three items -> "GP5mmE/NK/B-SET"
export function suggestSetStyle(...styles) {
  const list = (styles.length === 1 && Array.isArray(styles[0]) ? styles[0] : styles).map((x) => x || "");
  const [first = "", ...rest] = list;
  const tails = rest.map((b) => {
    let i = 0;
    while (i < first.length && i < b.length && first[i].toLowerCase() === b[i].toLowerCase()) i++;
    return i > 0 && i < b.length ? b.slice(i) : b;
  });
  return [first, ...tails].join("/") + "-SET";
}

// For a page of sample ids: which of them are in a set, plus every member of
// those sets (a set's other member may be on a different page).
// Returns { setsById: { [setId]: { id, style_number, name, memberIds: [sampleId by position] } },
//           setIdBySample: { [sampleId]: setId } }
export async function fetchSetsForSamples(supabase, sampleIds) {
  const empty = { setsById: {}, setIdBySample: {} };
  if (!sampleIds?.length) return empty;

  const { data: hits, error: e1 } = await supabase
    .from("sample_set_members")
    .select("set_id")
    .in("sample_id", sampleIds);
  if (e1) { console.error("fetchSetsForSamples (members):", e1); return empty; }
  const setIds = [...new Set((hits || []).map((h) => h.set_id))];
  if (!setIds.length) return empty;

  const [{ data: sets, error: e2 }, { data: members, error: e3 }] = await Promise.all([
    supabase.from("sample_sets").select("id, style_number, name").in("id", setIds),
    supabase.from("sample_set_members").select("set_id, sample_id, position").in("set_id", setIds).order("position"),
  ]);
  if (e2 || e3) { console.error("fetchSetsForSamples:", e2 || e3); return empty; }

  const setsById = {};
  (sets || []).forEach((s) => { setsById[s.id] = { ...s, memberIds: [] }; });
  const setIdBySample = {};
  (members || []).forEach((m) => {
    if (!setsById[m.set_id]) return;
    setsById[m.set_id].memberIds.push(m.sample_id);
    setIdBySample[m.sample_id] = m.set_id;
  });
  return { setsById, setIdBySample };
}

// Create the set card and attach the samples in the order given.
export async function linkSamplesAsSet(supabase, { styleNumber, sampleIds }) {
  const style = (styleNumber || "").trim();
  if (!style) throw new Error("A set needs a style number.");
  if (!sampleIds || sampleIds.length < 2) throw new Error("Pick at least two samples to link.");
  if (sampleIds.length > MAX_SET_ITEMS) throw new Error(`A set can hold up to ${MAX_SET_ITEMS} items.`);

  const { data: already, error: eA } = await supabase
    .from("sample_set_members").select("sample_id").in("sample_id", sampleIds);
  if (eA) throw new Error(eA.message);
  if (already?.length) throw new Error("One of these samples is already in a set. Unlink it first.");

  const { data: set, error: eS } = await supabase
    .from("sample_sets").insert({ style_number: style }).select().single();
  if (eS) {
    if (eS.code === "23505") throw new Error(`A set named "${style}" already exists.`);
    throw new Error(eS.message);
  }
  const rows = sampleIds.map((sample_id, i) => ({ set_id: set.id, sample_id, position: i + 1 }));
  const { error: eM } = await supabase.from("sample_set_members").insert(rows);
  if (eM) {
    await supabase.from("sample_sets").delete().eq("id", set.id); // don't leave an empty set behind
    throw new Error(eM.message);
  }
  return set;
}

// Add loose samples to an EXISTING set (they take the next positions). The
// set keeps its record, so anything already linked to it (e.g. an SSP number
// pushed earlier) stays; run Create set in SSP again to send the new item.
export async function addSamplesToSet(supabase, setId, sampleIds) {
  if (!sampleIds?.length) throw new Error("Pick at least one sample to add.");
  const { data: current, error: e1 } = await supabase
    .from("sample_set_members").select("sample_id, position").eq("set_id", setId);
  if (e1) throw new Error(e1.message);
  if ((current?.length || 0) + sampleIds.length > MAX_SET_ITEMS)
    throw new Error(`A set can hold up to ${MAX_SET_ITEMS} items (it has ${current?.length || 0}).`);
  const { data: taken, error: e2 } = await supabase
    .from("sample_set_members").select("sample_id").in("sample_id", sampleIds);
  if (e2) throw new Error(e2.message);
  if (taken?.length) throw new Error("One of these samples is already in a set. Unlink it first.");
  const start = Math.max(0, ...(current || []).map((m) => m.position));
  const rows = sampleIds.map((sample_id, i) => ({ set_id: setId, sample_id, position: start + i + 1 }));
  const { error } = await supabase.from("sample_set_members").insert(rows);
  if (error) throw new Error(error.message);
}

export async function renameSet(supabase, setId, styleNumber) {
  const style = (styleNumber || "").trim();
  if (!style) throw new Error("A set needs a style number.");
  const { error } = await supabase
    .from("sample_sets").update({ style_number: style, updated_at: new Date().toISOString() }).eq("id", setId);
  if (error) {
    if (error.code === "23505") throw new Error(`A set named "${style}" already exists.`);
    throw new Error(error.message);
  }
}

// Members are deleted with the set (on delete cascade); the samples are untouched.
export async function unlinkSet(supabase, setId) {
  const { error } = await supabase.from("sample_sets").delete().eq("id", setId);
  if (error) throw new Error(error.message);
}

// Put the members in a new order (first id = item 1, ...). (set_id, position)
// is unique, so park every row on a temporary position first.
export async function reorderSet(supabase, setId, orderedSampleIds) {
  const upd = (sampleId, position) =>
    supabase.from("sample_set_members").update({ position }).eq("set_id", setId).eq("sample_id", sampleId);
  for (let i = 0; i < orderedSampleIds.length; i++) {
    const r = await upd(orderedSampleIds[i], 100 + i);
    if (r.error) throw new Error(r.error.message);
  }
  for (let i = 0; i < orderedSampleIds.length; i++) {
    const r = await upd(orderedSampleIds[i], i + 1);
    if (r.error) throw new Error(r.error.message);
  }
}

// Scanning a SET tag: its QR holds the set's style number. Returns the set
// with its first member's sample_id (so the scan can open item 1), or null.
export async function findSetByStyleNumber(supabase, styleNumber) {
  const sn = String(styleNumber || "").trim();
  if (!sn) return null;
  const { data: sets, error } = await supabase
    .from("sample_sets").select("id, style_number").ilike("style_number", sn).limit(1);
  if (error || !sets?.length) return null;
  const { data: members } = await supabase
    .from("sample_set_members").select("sample_id, position").eq("set_id", sets[0].id).order("position").limit(1);
  return { ...sets[0], firstSampleId: members?.[0]?.sample_id ?? null };
}
