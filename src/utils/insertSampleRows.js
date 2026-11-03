// Shared "save a batch of formatted sample rows" logic -- Kevin, 2026-09-30.
//
// Extracted verbatim from ImportModal.jsx's xlsx/csv samples-import loop so
// there is exactly ONE code path for turning `formatImportRow(row, 'samples',
// dropdown, prices)` output into starting_info/samples/stones rows,
// regardless of whether those formatted rows came from a parsed spreadsheet
// (ImportModal) or typed/pasted straight into the Bulk Add grid
// (BulkAddSamplesModal). Keeping this in one place means a fix or a new
// field only has to happen once, and the two entry points can never drift
// apart on what "new sample" actually inserts.

import { getImages } from '../components/SupaBaseProvider';
import { purity } from './MetalTypeUtil';

// Mirrors the app's canonical metal list (Gold karats, 925 silver, Brass) so
// import accepts exactly what the product form allows.
export function checkIfKaratIsValid(karat) {
  const valid = Object.keys(purity).map((k) => k.toUpperCase().trim());
  return valid.includes(String(karat || '').toUpperCase().trim());
}

/**
 * Insert/upsert one batch of samples already run through formatImportRow.
 *
 *   insertFormattedSampleRows(supabase, formattedRows, { onProgress })
 *
 * Returns { successfulRows, failedRows } where failedRows carries
 * { row, error } (row = 1-based position in the batch, matching what the
 * caller showed the person for that entry).
 */
// Turn a raw database error into something readable in the grid's Status
// column. A unique-constraint hit on the style number (samples_styleNumber_key)
// is by far the most common one: say "Duplicate style number".
export function friendlyDbError(message) {
  const m = String(message || '');
  if (/duplicate key|unique constraint|already exists/i.test(m)) {
    if (/styleNumber/i.test(m)) return 'Duplicate style number';
    return 'Duplicate';
  }
  return m;
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Update an already-saved item with ONLY the fields that changed.
 *
 *   updateFormattedSampleRow(supabase, { sampleId, startingInfoId, before, after })
 *
 * `before` / `after` are formatImportRow outputs for the row as last saved and
 * as it is now. Unchanged fields are never sent. Stones are replaced only if
 * the stone list itself changed (new ones are inserted first, then the old
 * ones removed, so a failure can't leave the item with no stones).
 * Returns { changedFields, savedRow } (savedRow = fresh sample + starting_info).
 */
export async function updateFormattedSampleRow(supabase, { sampleId, startingInfoId, before, after }) {
  const SKIP = new Set(['id', 'starting_info', 'cad', 'images']);
  const sampleChanges = {};
  Object.keys(after).forEach((k) => {
    if (SKIP.has(k)) return;
    if (!sameValue(before[k], after[k])) sampleChanges[k] = after[k];
  });
  const SI_SKIP = new Set(['id', 'stones', 'images', 'cad']);
  const bSi = before.starting_info || {};
  const aSi = after.starting_info || {};
  const siChanges = {};
  Object.keys(aSi).forEach((k) => {
    if (SI_SKIP.has(k)) return;
    if (!sameValue(bSi[k], aSi[k])) siChanges[k] = aSi[k];
  });
  const stonesChanged = !sameValue(bSi.stones, aSi.stones);
  const changedFields = [...Object.keys(sampleChanges), ...Object.keys(siChanges), ...(stonesChanged ? ['stones'] : [])];
  if (changedFields.length === 0) return { changedFields, savedRow: null };

  if (Object.keys(sampleChanges).length > 0) {
    const { error } = await supabase.from('samples').update(sampleChanges).eq('id', sampleId);
    if (error) throw new Error(`Sample update error: ${error.message || error.details}`);
  }
  if (Object.keys(siChanges).length > 0) {
    const { error } = await supabase.from('starting_info').update(siChanges).eq('id', startingInfoId);
    if (error) throw new Error(`Starting info error: ${error.message || error.details}`);
  }
  if (stonesChanged) {
    const { data: oldStones, error: oldErr } = await supabase.from('stones').select('id').eq('starting_info_id', startingInfoId);
    if (oldErr) throw new Error(`Stones error: ${oldErr.message || oldErr.details}`);
    const fresh = (aSi.stones || []).map((st) => {
      const copy = { ...st, starting_info_id: startingInfoId };
      delete copy.id;
      return copy;
    });
    if (fresh.length > 0) {
      const { error } = await supabase.from('stones').insert(fresh);
      if (error) throw new Error(`Stones error: ${error.message || error.details}`);
    }
    const oldIds = (oldStones || []).map((o) => o.id);
    if (oldIds.length > 0) {
      const { error } = await supabase.from('stones').delete().in('id', oldIds);
      if (error) throw new Error(`Stones error: ${error.message || error.details}`);
    }
  }

  const { data: sample } = await supabase.from('samples').select('*').eq('id', sampleId).single();
  const { data: startingInfo } = await supabase.from('starting_info').select('*').eq('id', startingInfoId).single();
  const { images, cad } = await getImages('starting_info', startingInfoId);
  return { changedFields, savedRow: { ...sample, starting_info: startingInfo, images, cad } };
}

export async function insertFormattedSampleRows(supabase, formattedRows, { onProgress } = {}) {
  const successfulRows = [];
  const failedRows = [];

  for (let i = 0; i < formattedRows.length; i++) {
    try {
      let { starting_info, cad: dontUseCadOnSample, ...formData } = formattedRows[i];
      let { id: startingInfoIdFromImport, stones, images: dontUseImages, cad: dontUseCad, ...restOfStartingInfo } =
        starting_info || {};

      if (formData.styleNumber.trim() === '') {
        throw new Error('missing styleNumber');
      }
      if (!restOfStartingInfo.weight) {
        throw new Error('missing weight');
      }
      if (!checkIfKaratIsValid(restOfStartingInfo.karat)) {
        throw new Error(`invalid karat: ${restOfStartingInfo.karat}`);
      }

      const { id, ...rest } = formData;
      const FormatedFormDataId = id && !isNaN(Number(id)) ? Number(id) : null;

      // Style numbers are global: never create or rename a sample onto one that already exists
      // (case-insensitive). Rows are saved one at a time, so a repeat inside the same batch is caught too.
      {
        const wanted = formData.styleNumber.trim().replace(/[\\%_]/g, (c) => '\\' + c);
        let q = supabase.from('samples').select('id').ilike('styleNumber', wanted).limit(1);
        if (FormatedFormDataId) q = q.neq('id', FormatedFormDataId);
        const { data: clash } = await q;
        if (clash?.length) throw new Error(`style number ${formData.styleNumber.trim()} already exists`);
      }

      if (FormatedFormDataId) {
        try {
          const { data: existing } = await supabase
            .from('samples')
            .select('*')
            .eq('id', FormatedFormDataId)
            .single();
          restOfStartingInfo.id = existing.starting_info_id;
        } catch (error) {
          console.log('possibly a new sample, no existing found', error);
        }
      }

      const { data: updatedStartingInfo, error: startingInfoError } = await supabase
        .from('starting_info')
        .upsert([{ ...restOfStartingInfo }], { onConflict: ['id'] })
        .select()
        .single();

      if (startingInfoError) {
        throw new Error(`Starting info error: ${startingInfoError.message || startingInfoError.details}`);
      }

      // If anything below fails for a brand-new item, remove the starting_info
      // row created above so a retry can't leave orphans or duplicates.
      const createdStartingInfo = !restOfStartingInfo.id;
      const undoStartingInfo = async () => {
        if (createdStartingInfo) await supabase.from('starting_info').delete().eq('id', updatedStartingInfo.id);
      };

      // Stones first (they only need starting_info). New stones carry no id:
      // sending `id: null` violates the identity column and used to fail
      // silently, leaving samples with no stones linked.
      if (stones && stones.length > 0) {
        const withId = stones.filter((st) => st.id).map((st) => ({ ...st, starting_info_id: updatedStartingInfo.id }));
        const withoutId = stones
          .filter((st) => !st.id)
          .map((st) => {
            const copy = { ...st, starting_info_id: updatedStartingInfo.id };
            delete copy.id;
            return copy;
          });
        let stonesError = null;
        if (withId.length > 0) {
          ({ error: stonesError } = await supabase.from('stones').upsert(withId, { onConflict: ['id'] }));
        }
        if (!stonesError && withoutId.length > 0) {
          ({ error: stonesError } = await supabase.from('stones').insert(withoutId));
        }
        if (stonesError) {
          await undoStartingInfo();
          throw new Error(`Stones error: ${stonesError.message || stonesError.details}`);
        }
      }

      const { images, cad } = await getImages('starting_info', updatedStartingInfo.id);

      const updatedData = {
        ...rest,
        starting_info_id: updatedStartingInfo.id,
      };
      if (FormatedFormDataId) {
        updatedData.id = FormatedFormDataId;
      }

      const { data: updatedSample, error: updatedSampleError } = await supabase
        .from('samples')
        .upsert([{ ...updatedData }], { onConflict: ['id'] })
        .select();

      if (updatedSampleError) {
        if (createdStartingInfo) {
          await supabase.from('stones').delete().eq('starting_info_id', updatedStartingInfo.id);
          await undoStartingInfo();
        }
        throw new Error(`Sample update error: ${updatedSampleError.message || updatedSampleError.details}`);
      }

      const savedRow = { ...updatedSample[0], starting_info: updatedStartingInfo, images, cad };

      successfulRows.push(savedRow);
    } catch (err) {
      console.error(`Error processing row ${i + 1}:`, err);
      failedRows.push({ row: i + 1, error: friendlyDbError(err.message) });
    }
    onProgress?.(Math.round(((i + 1) / formattedRows.length) * 100));
  }

  return { successfulRows, failedRows };
}
