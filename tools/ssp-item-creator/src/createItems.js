/**
 * SSP bulk / single item creator.
 *
 * Usage:
 *   node src/createItems.js                          -> interactive menu (bulk or single)
 *   node src/createItems.js --file items.xlsx        -> interactive, custom workbook
 *   node src/createItems.js --style GVC121-AM        -> create one style, no menu
 *   node src/createItems.js --bulk                   -> create every row, no menu
 *   node src/createItems.js --dry-run [...]          -> print payloads, send nothing
 *
 * Flow per item (mirrors the recorded UI traffic):
 *   images (QA + stage) -> header/save -> costing-method -> tether -> item
 *   -> materials -> findings -> stones -> labor cost
 *
 * Images come from an optional "Images" sheet (styleNumber, imageUrl —
 * a local path or http(s) URL, e.g. an R2 link). Fewer than 2 sources for
 * a style sends the same image twice under different filenames, since SSP
 * wants at least two. No Images rows for a style -> created with no
 * photos, same as before (finish in the UI).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { SspClient, loadConfig, loadToken } from './sspClient.js';
import { readWorkbook, validate } from './workbook.js';
import {
  buildHeaderPayload,
  buildItemPayload,
  buildMaterialPayload,
  buildFindingPayload,
  buildStonePayload,
  buildLaborPayload,
} from './payloads.js';
import { stageImagesForItem } from './images.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI args -------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const dryRun = flag('dry-run');
const file = opt('file') || path.join(ROOT, 'items.xlsx');
let mode = flag('bulk') ? 'bulk' : opt('style') ? 'single' : null;
let styleArg = opt('style');

// ---- interactive menu (the "dropdown") ------------------------------------

async function choose(rl, title, options) {
  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  for (;;) {
    const ans = (await rl.question('> ')).trim();
    const n = Number(ans);
    if (n >= 1 && n <= options.length) return n - 1;
    const hit = options.findIndex((o) => o.toLowerCase() === ans.toLowerCase());
    if (hit >= 0) return hit;
    console.log(`Pick 1-${options.length} (or type the value).`);
  }
}

// ---- per-item creation ----------------------------------------------------

async function createOne(client, cfg, it, results) {
  const t = { ...cfg.itemDefaults };
  const tethers = {
    isTetheredToMetalLossMatrix: t.isTetheredToMetalLossMatrix,
    isTetheredToDiamondPricingMatrix: t.isTetheredToDiamondPricingMatrix,
    isTetheredToOvercostMatrix: t.isTetheredToOvercostMatrix,
  };
  const costingMethod = String(it.header.costingMethod || '').trim() || t.costingMethod;
  const delay = cfg.requestDelayMs || 0;
  const rec = { style: it.style, sspCode: null, itemId: null, status: 'started', steps: [], error: null };
  results.push(rec);
  const step = async (name, fn) => {
    const out = await fn();
    rec.steps.push(name);
    if (delay) await sleep(delay);
    return out;
  };

  try {
    console.log(`\n=== ${it.style} ===`);

    let images = [];
    if (it.images.length) {
      images = await step('images', () =>
        stageImagesForItem(client, { sspCode: null, sources: it.images, baseFilename: it.style })
      );
      console.log(`  staged ${images.length} image(s)${it.images.length < 2 ? ' (only 1 source — sent twice)' : ''}`);
    } else {
      console.log('  no Images rows — creating with no photos');
    }

    const headerRes = await step('header', () => client.saveHeader(buildHeaderPayload(it.header), images));
    rec.sspCode = headerRes?.data?.sspCode || (dryRun ? '(dry-run)' : null);
    console.log(`  header saved -> SSP ${rec.sspCode}`);
    if (!dryRun && !rec.sspCode) throw new Error('header/save returned no sspCode');
    const ssp = rec.sspCode;

    await step('costingMethod', () => client.updateCostingMethod(ssp, costingMethod));
    await step('tether', () => client.setTethers(ssp, tethers));

    const itemRes = await step('item', () =>
      client.createItem(
        ssp,
        buildItemPayload(it.header, {
          hasMaterials: it.materials.length > 0,
          hasFindings: it.findings.length > 0,
          hasStones: it.stones.length > 0,
          hasChains: false,
          costingMethod,
          tethers,
        })
      )
    );
    rec.itemId = itemRes?.data?.itemId ?? (dryRun ? 1 : null);
    console.log(`  item created -> itemId ${rec.itemId}`);

    for (const [i, m] of it.materials.entries()) {
      await step(`material[${i}]`, () => client.addMaterial(ssp, rec.itemId, buildMaterialPayload(m, { tethers })));
      console.log(`  material ${i + 1}/${it.materials.length} (${m.materialType} ${m.metalKarat || ''})`.trimEnd());
    }
    for (const [i, f] of it.findings.entries()) {
      await step(`finding[${i}]`, () => client.addFinding(ssp, rec.itemId, buildFindingPayload(f, { tethers })));
      console.log(`  finding ${i + 1}/${it.findings.length} (${f.findingType})`);
    }
    for (const [i, st] of it.stones.entries()) {
      await step(`stone[${i}]`, () => client.addStone(ssp, rec.itemId, buildStonePayload(st)));
      console.log(`  stone ${i + 1}/${it.stones.length} (${st.shape || 'round'} ${st.stoneMillimeter || st.size || ''}mm)`.trimEnd());
    }
    if (it.labor) {
      await step('laborcost', () => client.updateLaborCost(ssp, rec.itemId, buildLaborPayload(it.labor)));
      console.log('  labor cost saved');
    }

    rec.status = 'created';
    console.log(`  DONE — review ${ssp} in the SSP hold queue`);
  } catch (err) {
    rec.status = 'failed';
    rec.error = String(err.message || err);
    console.error(`  FAILED at step ${rec.steps.length + 1}: ${rec.error}`);
    if (rec.sspCode && !dryRun) {
      console.error(`  NOTE: SSP ${rec.sspCode} was partially created — finish or fix it in the UI.`);
    }
  }
}

// ---- main -----------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  if (!fs.existsSync(file)) {
    console.error(`Workbook not found: ${file}\nCopy template/ssp-items-template.xlsx, fill it in, save as items.xlsx (or pass --file).`);
    process.exit(1);
  }
  const items = readWorkbook(file);
  console.log(`Loaded ${items.length} item(s) from ${path.basename(file)}.`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!mode) {
      const pick = await choose(rl, 'What do you want to do?', [
        'Bulk create (every row in the workbook)',
        'Create single (pick one style)',
      ]);
      mode = pick === 0 ? 'bulk' : 'single';
    }

    let selected = items;
    if (mode === 'single') {
      if (!styleArg) {
        const idx = await choose(rl, 'Which style?', items.map((i) => `${i.style} — ${String(i.header.itemDescription || '').slice(0, 50)}`));
        selected = [items[idx]];
      } else {
        selected = items.filter((i) => i.style.toLowerCase() === styleArg.toLowerCase());
        if (!selected.length) {
          console.error(`Style "${styleArg}" not found on the Items sheet.`);
          process.exit(1);
        }
      }
    }

    const problems = validate(selected);
    if (problems.length) {
      console.error('\nValidation problems:');
      problems.forEach((p) => console.error('  - ' + p));
      console.error('\nFix the workbook and re-run. Nothing was sent.');
      process.exit(1);
    }

    const token = dryRun ? null : loadToken();
    const client = new SspClient({ config: cfg, token, dryRun });

    if (!dryRun) {
      const names = selected.map((s) => s.style).join(', ');
      const ok = (await rl.question(`\nAbout to create ${selected.length} item(s) in SSP PRODUCTION: ${names}\nType "yes" to continue: `)).trim().toLowerCase();
      if (ok !== 'yes') {
        console.log('Aborted. Nothing was sent.');
        process.exit(0);
      }
    }

    const results = [];
    for (const it of selected) await createOne(client, cfg, it, results);

    // results log
    const dir = path.join(ROOT, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(dir, `run-${stamp}${dryRun ? '-dryrun' : ''}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ file, mode, dryRun, results }, null, 2));
    const created = results.filter((r) => r.status === 'created').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    console.log(`\nSummary: ${created} created, ${failed} failed. Log: ${path.relative(ROOT, outPath)}`);
    results.forEach((r) => console.log(`  ${r.style}: ${r.status}${r.sspCode ? ` (${r.sspCode})` : ''}${r.error ? ` — ${r.error}` : ''}`));
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
