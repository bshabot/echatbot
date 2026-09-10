/**
 * Fetches SSP dropdown vocabularies (get-filters) and saves them to
 * docs/vocab-header.json — useful for checking what values the
 * spreadsheet is allowed to use (buyers, countries, polybag sizes, ...).
 *
 * Needs a valid token in auth.json.
 *   node src/fetchVocab.js            -> header-level vocab
 *   node src/fetchVocab.js S180933    -> also item/material/finding vocab for that product
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SspClient, loadToken } from './sspClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'docs');

const client = new SspClient({ token: loadToken() });
const save = (name, data) => {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log('wrote', path.relative(ROOT, p));
};

const ssp = process.argv[2];
save('vocab-header.json', await client.getHeaderFilters());
if (ssp) {
  save(`vocab-item-${ssp}.json`, await client.getItemFilters(ssp));
  save(`vocab-material-${ssp}.json`, await client.getMaterialFilters(ssp, 1));
  save(`vocab-finding-${ssp}.json`, await client.getFindingFilters(ssp, 1));
}
