// src/utils/tags/plating.js
// ---------------------------------------------------------------------------
// Plating label FALLBACK for the sample tag.
//
// The canonical mapping now lives in the database: plating.tag_label, surfaced
// on the sample_with_stones_export view as `plating_label`. The print path
// should prefer that value. This file is only a safety net for when a row was
// loaded without plating_label, or tag_label is null/missing.
//
// To change what prints on a tag, edit plating.tag_label in the DB — no deploy.
// ---------------------------------------------------------------------------

/** Fallback: raw plating.name -> short label, when plating_label is unavailable. */
const NAME_FALLBACK = [
  [/^none$/i, ''],
  [/^rhodium$|^rhd$/i, 'Rhodium Plated'],
  [/14k.*gold|vermeil/i, '14k Gold Plated .5mic'],
  [/bpt\s*\+\s*gpt/i, 'Black RHD GP'],
  [/^bpt$|^bpt$/i, 'Black Rhodium'],
  [/silver plated.*1\s*micron/i, 'Silver Plated 1mic'],
  [/ip\s*gold/i, 'IP Gold Plated'],
  [/ip\s*silver/i, 'IP Silver Plated'],
];

/**
 * Resolve a clean plating label for the tag.
 * Prefer the DB-provided plating_label; fall back to mapping the raw name.
 * @param {object} args
 * @param {string|null} [args.platingLabel] plating_label from the export view (preferred)
 * @param {string|null} [args.platingName]  raw plating.name (fallback only)
 * @returns {string} short label, or '' to omit
 */
export function resolvePlatingLabel({ platingLabel = null, platingName = null } = {}) {
  if (platingLabel != null) return String(platingLabel).trim();
  const raw = (platingName || '').trim();
  if (!raw) return '';
  for (const [re, label] of NAME_FALLBACK) {
    if (re.test(raw)) return label;
  }
  return raw; // unknown: print raw rather than silently dropping data
}
