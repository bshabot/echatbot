// Clone a sample (and its starting_info, stones, image_link rows) under a new styleNumber.
// Images themselves are NOT copied; the new sample shares image references with the source.
export async function duplicateSample(supabase, sourceSample, newStyleNumber) {
  if (!sourceSample?.formData?.id) throw new Error("Source sample is missing");
  if (!newStyleNumber || newStyleNumber.trim() === "")
    throw new Error("New style number is required");

  // 1. Check that styleNumber is not already taken
  const { data: existing, error: checkErr } = await supabase
    .from("samples")
    .select("id")
    .eq("styleNumber", newStyleNumber)
    .limit(1);
  if (checkErr) throw checkErr;
  if (existing && existing.length > 0)
    throw new Error('Style number "' + newStyleNumber + '" is already in use');

  const sourceStartingInfo = sourceSample.starting_info;
  if (!sourceStartingInfo?.id)
    throw new Error("Source sample missing starting_info");

  // 2. Clone starting_info (strip id and timestamps)
  const { id: oldStartingInfoId, created_at: _siC, updated_at: _siU, images, cad, stones: _ignoredStones, ...startingInfoToClone } = sourceStartingInfo;
  const { data: newStartingInfo, error: siErr } = await supabase
    .from("starting_info")
    .insert(startingInfoToClone)
    .select()
    .single();
  if (siErr) throw siErr;

  // 3. Clone the samples row with the new styleNumber
  const { id: oldSampleId, created_at: _sC, updated_at: _sU, ...sampleToClone } = sourceSample.formData;
  sampleToClone.styleNumber = newStyleNumber;
  if ("starting_info" in sampleToClone) sampleToClone.starting_info = newStartingInfo.id;
  const { data: newSample, error: sErr } = await supabase
    .from("samples")
    .insert(sampleToClone)
    .select()
    .single();
  if (sErr) throw sErr;

  // 4. Clone stones
  const { data: oldStones, error: stonesErr } = await supabase
    .from("stones")
    .select("*")
    .eq("starting_info_id", oldStartingInfoId);
  if (stonesErr) throw stonesErr;
  if (oldStones && oldStones.length > 0) {
    const stonesToClone = oldStones.map(({ id, created_at, updated_at, ...stone }) => ({
      ...stone,
      starting_info_id: newStartingInfo.id,
    }));
    const { error: stoneInsertErr } = await supabase
      .from("stones")
      .insert(stonesToClone);
    if (stoneInsertErr) throw stoneInsertErr;
  }

  // 5. Clone image_link rows
  const { data: oldLinks, error: ilErr } = await supabase
    .from("image_link")
    .select("*")
    .eq("entity", "starting_info")
    .eq("entityId", oldStartingInfoId);
  if (ilErr) throw ilErr;
  if (oldLinks && oldLinks.length > 0) {
    const linksToClone = oldLinks.map(({ id, created_at, updated_at, ...link }) => ({
      ...link,
      entityId: newStartingInfo.id,
    }));
    const { error: linkInsertErr } = await supabase
      .from("image_link")
      .insert(linksToClone);
    if (linkInsertErr) throw linkInsertErr;
  }

  return {
    newSampleId: newSample.id,
    newStartingInfoId: newStartingInfo.id,
    newStyleNumber,
  };
}
