// Runner: labeled -> ship confirm -> invoice (-> stock when enabled). One status per step.
//   node src/run.js            DRY RUN: prints what it would post, posts nothing
//   node src/run.js --live     really posts. Honors the pause switch. Stops on the first error.
//   --limit N                  process at most N orders (default 1: first live use is one order)
//   --sync                     also pull new open orders first (sync.js --write)
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY. Pause switch: dropship_settings.paused (default true = paused).
import { loadCookies, makeClient, SessionExpired } from './http.js';
import { login } from './login.js';
import { shipOrder, invoiceOrder } from './os.js';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 1;
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Need SUPABASE_URL and SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const rest = async (p, opt = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${p}`, { headers: H, ...opt });
  if (!r.ok) throw new Error(`Supabase ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const patch = (id, body) => rest(`dropship_jobs?order_id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });

const paused = (await rest('dropship_settings?key=eq.paused'))[0]?.value !== false;
if (paused && LIVE) { console.log('Automation is PAUSED (dropship_settings.paused). Nothing done.'); process.exit(0); }
if (args.includes('--sync') && !paused) { /* sync is read-only; run it separately: node src/sync.js --write */ }

async function client() {
  try { const c = makeClient(await loadCookies()); await c.keepAlive(); return c; }
  catch (e) { if (!(e instanceof SessionExpired) && !/auth\.json/.test(e.message)) throw e; await login(); return makeClient(await loadCookies()); }
}

const run = (await rest('dropship_runs', { method: 'POST', headers: { ...H, prefer: 'return=representation' }, body: JSON.stringify({ live: LIVE }) }))[0];
const log = (job, step, outcome, extra = {}) => {
  const a = c?.audit ?? {};
  return rest('dropship_events', { method: 'POST', body: JSON.stringify({
    run_id: run.run_id, order_id: job.order_id, po_number: job.po_number, step, outcome,
    page_url: a.pageUrl, request: a.post?.fields ?? null, response_status: a.post?.status, response_location: a.post?.location,
    response_excerpt: a.post?.excerpt, ...extra }) });
};
const finish = (summary) => rest(`dropship_runs?run_id=eq.${run.run_id}`, { method: 'PATCH', body: JSON.stringify({ finished_at: new Date().toISOString(), summary }) });
let c;
const jobs = await rest(`dropship_jobs?status=in.(labeled,shipped)&problems=eq.{}&order=first_seen_at.asc&limit=${LIMIT}`);
console.log(`${LIVE ? 'LIVE' : 'DRY RUN'}: ${jobs.length} job(s)`);
if (!jobs.length) { await finish('no jobs'); process.exit(0); }
c = await client();

for (const job of jobs) {
  const step = job.status === 'labeled' ? 'ship' : 'invoice';
  try {
    const fn = step === 'ship' ? shipOrder : invoiceOrder;
    const r = await fn(c, job, { dry: !LIVE });
    console.log(`order ${job.order_id} PO ${job.po_number} ${step}:`, JSON.stringify(r));
    if (!LIVE || r.dry) continue;
    await log(job, step, r.skipped ? 'skipped' : 'ok', { invoice_number: r.invoice_number });
    await patch(job.order_id, step === 'ship'
      ? { status: 'shipped', last_step: 'ship', last_step_at: new Date().toISOString(), error: null }
      : { status: 'invoiced', invoice_number: r.invoice_number ?? job.invoice_number, last_step: 'invoice', last_step_at: new Date().toISOString(), error: null });
    if (step === 'ship') job.status = 'shipped';
  } catch (e) {
    console.error(`STOP: order ${job.order_id} ${step} failed: ${e.message}`);
    if (LIVE) await log(job, step, 'error', { response_excerpt: e.message.slice(0, 600) }).catch(() => {});
    await finish(`stopped: order ${job.order_id} ${step}`).catch(() => {});
    if (LIVE) await patch(job.order_id, { prev_status: job.status, status: 'error', last_step: step, error: `${step}: ${e.message}` });
    process.exit(e instanceof SessionExpired ? 2 : 1); // stop on first error
  }
}
await finish(`${jobs.length} job(s) processed`);
console.log('Done. Stock step is not automated yet (invoiced orders wait for it).');
