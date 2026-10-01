// Sample sets -- one product card that links 2+ samples (e.g. a stud + its
// matching necklace) so they can later go to SSP as ONE SSP with several
// items. Tables: sample_sets (the card) and sample_set_members (which samples
// are in it, `position` = SSP itemId order). A sample belongs to at most one
// set. See supabase/migrations/20261001190000_sample_sets.sql.

// "GP5mmE" + "GP5mmNK" -> "GP5mmE/NK-SET"
export function suggestSetStyle(a = "", b = "") {
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  const tail = i > 0 && i < b.length ? b.slice(i) : b;
  return `${a}/${tail}-SET`;
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

// Members are deleted with the set (on delete cascade); the samples are untouched.
export async function unlinkSet(supabase, setId) {
  const { error } = await supabase.from("sample_sets").delete().eq("id", setId);
  if (error) throw new Error(error.message);
}

// Swap item 1 <-> item 2. (set_id, position) is unique, so park one row first.
export async function swapSetOrder(supabase, setId, [aId, bId]) {
  const upd = (sampleId, position) =>
    supabase.from("sample_set_members").update({ position }).eq("set_id", setId).eq("sample_id", sampleId);
  for (const r of [await upd(aId, 99), await upd(bId, 1), await upd(aId, 2)]) {
    if (r.error) throw new Error(r.error.message);
  }
}
