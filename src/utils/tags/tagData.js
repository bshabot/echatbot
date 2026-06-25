// src/utils/tags/tagData.js
// ---------------------------------------------------------------------------
// Supabase reads for the tag feature. All reads go through the authenticated
// client (the whole app sits behind a session in App.jsx), satisfying the
// vendor rule: there is no public, no-login sample route.
//
// The sample cards already carry every tag field (the list loads from
// sample_with_stones_export, which now includes plating_label), so single and
// batch printing usually need NO fetch. These helpers exist for scan-to-open
// and for reprinting an import batch by sample_id.
// ---------------------------------------------------------------------------

const VIEW = 'sample_with_stones_export';

/** Fetch export rows for a set of sample_ids (for batch / import-history print). */
export async function fetchTagRowsBySampleIds(supabase, sampleIds = []) {
  const ids = Array.from(new Set(sampleIds)).filter((x) => x != null);
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(VIEW).select('*').in('sample_id', ids);
  if (error) throw new Error(`Tag data fetch failed: ${error.message}`);
  return data || [];
}

/**
 * Scan-to-open lookup: resolve a scanned style number to a sample.
 * Returns the export row, or null if not found. Behind auth by construction.
 */
export async function findSampleByStyleNumber(supabase, styleNumber) {
  const sn = String(styleNumber || '').trim();
  if (!sn) return null;
  // Exact match first (the QR encodes styleNumber verbatim).
  let { data, error } = await supabase.from(VIEW).select('*').eq('styleNumber', sn).limit(1);
  if (error) throw new Error(`Scan lookup failed: ${error.message}`);
  if (data && data.length) return data[0];
  // Tolerate scanner casing/whitespace quirks.
  ({ data, error } = await supabase.from(VIEW).select('*').ilike('styleNumber', sn).limit(1));
  if (error) throw new Error(`Scan lookup failed: ${error.message}`);
  return data && data.length ? data[0] : null;
}

/** Record an import batch (best-effort; never block the import on logging). */
export async function logImportBatch(supabase, { type, sourceFilename, sampleIds = [], createdBy = null }) {
  const ids = Array.from(new Set(sampleIds)).filter((x) => x != null);
  try {
    const { data, error } = await supabase
      .from('import_batches')
      .insert({
        type,
        source_filename: sourceFilename || null,
        sample_ids: ids,
        sample_count: ids.length,
        created_by: createdBy,
      })
      .select()
      .single();
    if (error) {
      console.warn('import batch logging failed:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('import batch logging error:', e);
    return null;
  }
}

/** List import batches, newest first, optionally filtered by type. */
export async function listImportBatches(supabase, { type = null, limit = 200 } = {}) {
  let q = supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(limit);
  if (type && type !== 'all') q = q.eq('type', type);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load import history: ${error.message}`);
  return data || [];
}
