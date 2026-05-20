// Clone a sample (and its starting_info, stones, image_link rows) under a new styleNumber.
// Images themselves are NOT copied; the new sample shares image references with the source.
//
// Accepts either shape for sourceSample:
//   - { formData: {id, ...}, starting_info: {id, ...} }  (from SampleInfoModal)
//   - flat row from sample_with_stones_export view       (from Samples list)
export async function duplicateSample(supabase, sourceSample, newStyleNumber) {
  if (!sourceSample) throw new Error("Source sample is missing");
  if (!newStyleNumber || newStyleNumber.trim() === "")
    throw new Error("New style number is required");

  // Resolve both IDs from whichever shape we got
  const sampleId = sourceSample.formData?.id || sourceSample.sample_id || sourceSample.id;
  const startingInfoId =
    sourceSample.starting_info?.id ||
    sourceSample.starting_info_id ||
    sourceSample.startingInfoId;

  if (!sampleId) throw new Error("Source sample is missing (no sample id)");
  if (!startingInfoId) throw new Error("Source sample is missing starting_info");

  // 1. Check that styleNumber is not already taken
  const { data: existing, error: checkErr } = await supabase
    .from("samples")
    .select("id")
    .eq("styleNumber", newStyleNumber)
    .limit(1);
  if (checkErr) throw checkErr;
  if (existing && existing.length > 0)
    throw new Error('Style number "' + newStyleNumber + '" is already in use');

  // 2. Fetch the source sample + starting_info fresh so we have ALL columns
  // (the view doesn't necessarily expose every column we need to clone).
  const { data: sourceSampleRow, error: sErrFetch } = await supabase
    .from("samples")
    .select("*")
    .eq("id", sampleId)
    .single();
  if (sErrFetch) throw sErrFetch;

  const { data: sourceStartingInfoRow, error: siErrFetch } = await supabase
    .from("starting_info")
    .select("*")
    .eq("id", startingInfoId)
    .single();
  if (siErrFetch) throw siErrFetch;

  // 3. Clone starting_info (strip id + timestamps + view-only fields)
  const {
    id: _siId,
    created_at: _siC,
    updated_at: _siU,
    ...startingInfoToClone
  } = sourceStartingInfoRow;
  const { data: newStartingInfo, error: siErr } = await supabase
    .from("starting_info")
    .insert(startingInfoToClone)
    .select()
    .single();
  if (siErr) throw siErr;

  // 4. Clone samples row with new styleNumber
  const {
    id: _sId,
    created_at: _sC,
    updated_at: _sU,
    ...sampleToClone
  } = sourceSampleRow;
  sampleToClone.styleNumber = newStyleNumber;
  sampleToClone.starting_info_id = newStartingInfo.id;
  const { data: newSample, error: sErr } = await supabase
    .from("samples")
    .insert(sampleToClone)
    .select()
    .single();
  if (sErr) throw sErr;

  // 5. Clone stones
  const { data: oldStones, error: stonesErr } = await supabase
    .from("stones")
    .select("*")
    .eq("starting_info_id", startingInfoId);
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

  // 6. Clone image_link rows
  const { data: oldLinks, error: ilErr } = await supabase
    .from("image_link")
    .select("*")
    .eq("entity", "starting_info")
    .eq("entityId", startingInfoId);
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
