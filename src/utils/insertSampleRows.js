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
        throw new Error(`Sample update error: ${updatedSampleError.message || updatedSampleError.details}`);
      }

      const savedRow = { ...updatedSample[0], starting_info: updatedStartingInfo, images, cad };

      if (stones && stones.length > 0) {
        await supabase
          .from('stones')
          .upsert(stones.map((stone) => ({ ...stone, starting_info_id: updatedStartingInfo.id })), {
            onConflict: ['id'],
          });
      }

      successfulRows.push(savedRow);
    } catch (err) {
      console.error(`Error processing row ${i + 1}:`, err);
      failedRows.push({ row: i + 1, error: err.message });
    }
    onProgress?.(Math.round(((i + 1) / formattedRows.length) * 100));
  }

  return { successfulRows, failedRows };
}
