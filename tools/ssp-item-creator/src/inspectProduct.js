/**
 * Inspect a product's items/materials in live SKU Manager, and optionally
 * push an update to one of them — the "get items, then update the request
 * payload" workflow used to debug/confirm update-in-place fixes for item
 * and material (see sspClient.js's updateItem/updateMaterial).
 *
 * Needs a valid token in auth.json (same as fetchVocab.js/createItems.js).
 *
 *   node src/inspectProduct.js S189427
 *     -> prints every item on the product, and every material row on
 *        each item (204/empty is printed as "(no materials)")
 *
 *   node src/inspectProduct.js S189427 --update-item 1 ./item-patch.json
 *     -> PUTs item 1 with fields merged over what get-item currently
 *        returns, so you only need to put the fields you're changing in
 *        item-patch.json — not the whole payload
 *
 *   node src/inspectProduct.js S189427 --update-material 1 1 ./material-patch.json
 *     -> same, for item 1 / material 1
 */

import fs from 'node:fs';
import { SspClient, loadToken } from './sspClient.js';

const args = process.argv.slice(2);
const ssp = args[0];
if (!ssp) {
  console.error('Usage: node src/inspectProduct.js <sspCode> [--update-item <itemId> <patch.json>] [--update-material <itemId> <materialId> <patch.json>]');
  process.exit(1);
}

const client = new SspClient({ token: loadToken() });

function loadPatch(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function showItemsAndMaterials() {
  const items = await client.getItems(ssp);
  const list = items?.data || [];
  if (!list.length) {
    console.log(`${ssp}: no items`);
    return;
  }
  for (const it of list) {
    console.log(`\nitem ${it.itemId} — ${it.productType} — ${it.itemDescription}`);
    const mats = await client.getItemMaterials(ssp, it.itemId);
    const matList = mats?.data;
    if (!matList || !matList.length) {
      console.log('  (no materials)');
    } else {
      for (const m of matList) {
        console.log(`  material ${m.materialId}:`, JSON.stringify(m));
      }
    }
  }
}

const updateItemIdx = args.indexOf('--update-item');
const updateMaterialIdx = args.indexOf('--update-material');

if (updateItemIdx !== -1) {
  const itemId = Number(args[updateItemIdx + 1]);
  const patchFile = args[updateItemIdx + 2];
  const current = await client.getItem(ssp, itemId);
  const merged = { ...(current?.data || {}), ...loadPatch(patchFile) };
  console.log('PUT item', itemId, 'with:', JSON.stringify(merged, null, 2));
  const result = await client.updateItem(ssp, itemId, merged);
  console.log('result:', JSON.stringify(result, null, 2));
} else if (updateMaterialIdx !== -1) {
  const itemId = Number(args[updateMaterialIdx + 1]);
  const materialId = Number(args[updateMaterialIdx + 2]);
  const patchFile = args[updateMaterialIdx + 3];
  const mats = await client.getItemMaterials(ssp, itemId);
  const currentMat = (mats?.data || []).find((m) => m.materialId === materialId) || {};
  const merged = { ...currentMat, ...loadPatch(patchFile) };
  console.log('PUT material', materialId, 'on item', itemId, 'with:', JSON.stringify(merged, null, 2));
  const result = await client.updateMaterial(ssp, itemId, materialId, merged);
  console.log('result:', JSON.stringify(result, null, 2));
} else {
  await showItemsAndMaterials();
}
