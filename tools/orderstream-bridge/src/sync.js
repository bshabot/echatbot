// Step 1 (read-only on OrderStream): pull open Quick Ship orders into dropship_jobs.
//   node src/sync.js                 dry run: print what would be inserted
//   node src/sync.js --write         insert NEW orders into Supabase (existing rows untouched)
//   node src/sync.js --file page.html   parse a saved Quick Ship page instead of fetching
// Never ships, invoices or changes stock. GET requests only.
import { readFile } from 'node:fs/promises';
import { loadCookies, makeClient, SessionExpired } from './http.js';
import { parseQuickShip } from './parse.js';
import { login } from './login.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const fileIdx = args.indexOf('--file');
const FILE = fileIdx > -1 ? args[fileIdx + 1] : null;

async function fetchOnce() {
  const client = makeClient(await loadCookies());
  await client.keepAlive().catch(e => { if (e instanceof SessionExpired) throw e; }); // extends the 60 min idle timer
  return client.quickShipOpen();
}

async function getHtml() {
  if (FILE) return readFile(FILE, 'utf8');
  try {
    return await fetchOnce();
  } catch (e) {
    // Missing/expired session: log in automatically once, then retry. Any other error stops.
    const noAuth = /auth\.json/.test(e.message);
    if (!(e instanceof SessionExpired) && !noAuth) throw e;
    if (args.includes('--no-login')) throw e;
    console.log('No valid session, logging in...');
    await login();
    return fetchOnce();
  }
}

async function insertNew(orders) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('--write needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.');
  const rows = orders.map(o => ({
    order_id: o.order_id, po_number: o.po_number, merchant: o.merchant,
    order_date: o.order_date ? o.order_date.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2') : null, // MM/DD/YYYY -> ISO
    ship_to: o.ship_to, items: o.items, problems: o.problems
  }));
  // ignore-duplicates: an order already in the table keeps its status/tracking/etc.
  const res = await fetch(`${url}/rest/v1/dropship_jobs?on_conflict=order_id`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).length;
}

try {
  const orders = parseQuickShip(await getHtml());
  console.log(`${orders.length} open order(s) on Quick Ship`);
  for (const o of orders) {
    const items = o.items.map(i => `${i.vendor_sku} x${i.qty}`).join(', ');
    const st = o.ship_to.zip ? `${o.ship_to.city}, ${o.ship_to.state} ${o.ship_to.zip}` : 'ship-to NOT parsed';
    console.log(`  order ${o.order_id}  PO ${o.po_number}  ${o.order_date}  ${items}  -> ${st}${o.problems.length ? '  PROBLEMS: ' + o.problems.join('; ') : ''}`);
  }
  if (!WRITE) console.log('\nDry run. Nothing written. Use --write to insert new orders into dropship_jobs.');
  else if (orders.length) console.log(`\nInserted ${await insertNew(orders)} new row(s) of ${orders.length} seen (existing orders are left as they are).`);
} catch (e) {
  console.error((e instanceof SessionExpired ? 'SESSION EXPIRED: ' : 'ERROR: ') + e.message);
  process.exit(e instanceof SessionExpired ? 2 : 1);
}
