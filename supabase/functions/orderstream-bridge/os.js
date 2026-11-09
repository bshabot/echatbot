import * as cheerio from 'npm:cheerio@1.0.0';

const POST_URL = 'handleOrderRealmFormSubmission.do';
export const SHIP_CODE = { '03': 'UG', '13': 'UPSN_PM', '01': 'UR' };
const today = () => { const d = new Date(); return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };

function formFields(html, orderId) {
  const $ = cheerio.load(html);
  const out = [];
  $('form input, form select, form textarea').each((_, el) => {
    const name = $(el).attr('name'); if (!name) return;
    const type = ($(el).attr('type') || el.tagName).toLowerCase();
    if (['button', 'submit', 'image', 'file'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && !$(el).is(':checked')) return;
    const m = name.match(/^order\((\d+)\)/);
    if (m && m[1] !== String(orderId)) return;
    out.push([name, $(el).val() ?? $(el).attr('value') ?? '']);
  });
  return { out, has: out.some(([n]) => n.startsWith(`order(${orderId})`)) };
}
// The order lists are paged (10 per page): find the order on whichever page it is.
async function findOnPages(listPages, orderId) {
  const { pages } = await listPages();
  for (const html of pages) { const r = formFields(html, orderId); if (r.has) return { ...r, html }; }
  return { out: [], has: false, html: pages[0] || '' };
}
const set = (arr, name, val) => { const i = arr.findIndex(([n]) => n === name); i >= 0 ? (arr[i][1] = val) : arr.push([name, val]); };
const errorsIn = (t) => { const $ = cheerio.load(t); return $('.error, .errors, [class*=error]').text().replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'; };
const ok = (r) => /gotoOrderRealmSuccessMessage/.test(r.location) || /successfully applied/i.test(r.text);
const bad = (r) => /Errors were found/i.test(r.text);

export async function shipOrder(client, job, { dry }) {
  const { out, has } = await findOnPages(() => client.quickShipPages(), job.order_id);
  if (!has) {
    if ((await findOnPages(() => client.quickInvoicePages(), job.order_id)).has) return { done: true, note: 'already shipped (found on Needs Invoicing)' };
    throw new Error('order is not on the Quick Ship open list and not on Needs Invoicing - check it on OrderStream before retrying');
  }
  const method = SHIP_CODE[job.ship_method] ?? (Object.values(SHIP_CODE).includes(job.ship_method) ? job.ship_method : null);
  if (!job.tracking || !method) throw new Error('missing tracking or unknown ship_method ' + job.ship_method);
  const o = `order(${job.order_id})`;
  set(out, `${o}.shipmentdate`, today());
  set(out, `${o}.box(1).trackingnumber`, job.tracking);
  set(out, `${o}.box(1).shippingmethod`, method);
  for (const it of job.items) {
    const k = `${o}.box(1).item(${it.item_id})`;
    set(out, `${k}.shipped`, String(it.qty)); set(out, `${k}.shippingLineWarehouse`, 'Edison');
  }
  set(out, 'tabContext', 'web_quickship'); set(out, 'confirmbtn', 'Confirm');
  if (dry) return { dry: true, fields: out.filter(([n]) => n.startsWith(o) || n === 'tabContext') };
  const r = await client.post(POST_URL, out);
  if (bad(r)) throw new Error('Ship rejected: ' + errorsIn(r.text));
  const still = (await findOnPages(() => client.quickShipPages(), job.order_id)).has;
  if (!ok(r) && still) throw new Error(`Ship: unrecognized response (HTTP ${r.status}) and order still on open list: ` + cheerio.load(r.text)('body').text().replace(/\s+/g,' ').trim().slice(0,300));
  if (ok(r) && still) throw new Error('Ship accepted but order still on open list');
  return { done: true };
}

export async function invoiceOrder(client, job, { dry }) {
  const { out, has, html } = await findOnPages(() => client.quickInvoicePages(), job.order_id);
  if (!has) return { skipped: true, note: 'order not on Needs Invoicing list (already invoiced?)' };
  const o = `order(${job.order_id})`;
  const $ = cheerio.load(html);
  const btn = $(`[onclick*="${job.order_id}"]`).filter((_, e) => /invoicenumber/i.test($(e).attr('onclick') || '')).first();
  const num = (btn.attr('onclick') || '').match(/['"](\d{9})['"]/)?.[1];
  if (!num) throw new Error('could not read the Auto Fill invoice number from the page');
  set(out, `${o}.invoicenumber`, num);
  let total = 0;
  for (const it of job.items) {
    const unit = Number(out.find(([n]) => n === `${o}.item(${it.item_id}).unitcost`)?.[1]);
    if (!Number.isFinite(unit)) throw new Error(`no unit cost on the invoice page for item ${it.item_id}`);
    set(out, `${o}.item(${it.item_id}).invoiced`, String(it.qty));
    total += unit * it.qty;
  }
  set(out, `${o}.invoicetotal`, (total + Number(out.find(([n]) => n === `${o}.shipping`)?.[1] || 0)).toFixed(2));
  set(out, 'tabContext', 'web_quickinvoice'); set(out, 'confirmbtn', 'Confirm');
  if (dry) return { dry: true, invoice_number: num, fields: out.filter(([n]) => n.startsWith(o)) };
  const r = await client.post(POST_URL, out);
  if (bad(r)) throw new Error('Invoice rejected: ' + errorsIn(r.text));
  const still = (await findOnPages(() => client.quickInvoicePages(), job.order_id)).has;
  if (!ok(r) && still) throw new Error(`Invoice: unrecognized response (HTTP ${r.status}, ${r.location || 'no redirect'}) and order still on list: ` + cheerio.load(r.text || '')('body').text().replace(/\s+/g,' ').trim().slice(0,300));
  if (ok(r) && still) throw new Error('Invoice accepted but order still on list');
  return { done: true, invoice_number: num };
}

const INV_URL = 'gotoUpdateInventorySearch.do?start_row=1&searchType=invQuickSearch&new=1&merchantList=signetjewelers';
const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/^\/dsm\//, '');

async function invPages(client) {
  const first = await client.get(INV_URL);
  const pages = [{ url: INV_URL, html: first }];
  const $ = cheerio.load(first);
  const seen = new Set();
  $('a[href*="pager.offset="]').each((_, a) => { const h = $(a).attr('href'); if (h && !seen.has(h)) seen.add(h); });
  for (const h of seen) { try { pages.push({ url: rel(h), html: await client.get(rel(h)) }); } catch (_) { /* ignore */ } }
  return pages;
}

const QTY_RE = /new_qty|warehouseQty/i;

function skuInputs($, sku, re = QTY_RE) {
  const rows = $('tr').filter((_, tr) => !$(tr).find('tr').length).toArray();
  const start = rows.findIndex((tr) => $(tr).find('a').filter((_, a) => $(a).text().replace(/\s+/g, '') === sku.replace(/\s+/g, '')).length);
  if (start < 0) return null;
  let end = start + 1;
  while (end < rows.length && !$(rows[end]).find('a[href*="Sku"], a[href*="sku"], td:first-child a').length) end++;
  const inputs = [];
  for (let k = start; k < end; k++) $(rows[k]).find('input[name]').each((_, el) => {
    const n = $(el).attr('name');
    if (re.test(n)) inputs.push({ name: n, value: $(el).val() ?? '' });
  });
  return inputs;
}

// Debug: every input in a SKU's grid rows (names + values) so the right fields can be identified.
export async function gridRow(client, sku) {
  for (const p of await invPages(client)) {
    const all = skuInputs(cheerio.load(p.html), sku, /./);
    if (all?.length) return { sku, inputs: all };
  }
  return { sku, inputs: null };
}

function buildPost(html, changes) {
  const $ = cheerio.load(html);
  const form = $('form[name="updateInvForm"]').first();
  if (!form.length) throw new Error('inventory form not found');
  const action = rel(form.attr('action') || 'gotoUpdateInventoryPage.do');
  const hasPayload = form.find('[name="inventoryPayload"]').length > 0;
  const plain = [], values = {};
  form.find('input, select, textarea').each((_, el) => {
    const name = $(el).attr('name'); if (!name || $(el).is(':disabled')) return;
    const type = ($(el).attr('type') || el.tagName).toLowerCase();
    if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && !$(el).is(':checked')) return;
    let val = type === 'select' ? ($(el).find('option[selected]').attr('value') ?? $(el).find('option').first().attr('value') ?? '') : ($(el).val() ?? $(el).attr('value') ?? '');
    if (name in changes) val = String(changes[name]);
    const m = name.match(/^value\((.*)\)$/);
    if (hasPayload && m) { if (!(m[1] in values)) values[m[1]] = val; }
    else if (name !== 'inventoryPayload') plain.push([name, val]);
  });
  if (hasPayload) plain.push(['inventoryPayload', JSON.stringify(values)]);
  return { action, entries: plain };
}

export async function updateStock(client, job, { dry, onPlan }) {
  const pages = await invPages(client);
  const plan = [];
  let target = null;
  for (const it of job.items) {
    let found = null;
    for (const p of pages) { const inp = skuInputs(cheerio.load(p.html), it.vendor_sku); if (inp?.length) { found = { p, inp }; break; } }
    if (!found) throw new Error(`stock: ${it.vendor_sku} not found on the Inventory Update grid`);
    if (target && target !== found.p) throw new Error('stock: items are on different grid pages; do this order by hand');
    target = found.p;
    const qtys = found.inp.map((x) => parseInt(x.value, 10));
    if (qtys.some(Number.isNaN) || new Set(qtys).size !== 1) throw new Error(`stock: ${it.vendor_sku} quantities are not a single consistent number: ${qtys.join(',')}`);
    const before = qtys[0];
    plan.push({ sku: it.vendor_sku, before, after: before - it.qty, fields: found.inp.map((x) => x.name), qty: it.qty });
  }
  if (job.stock_plan?.length) {
    const prev = job.stock_plan;
    const nowMatchesAfter = plan.every((x) => prev.find((p) => p.sku === x.sku)?.after === x.before);
    if (nowMatchesAfter) return { done: true, plan: prev, note: 'already applied (grid matches the recorded plan)' };
    const stillBefore = plan.every((x) => prev.find((p) => p.sku === x.sku)?.before === x.before);
    if (!stillBefore) throw new Error('stock: grid changed since the plan was recorded; check by hand');
  }
  if (dry) return { dry: true, plan: plan.map(({ sku, before, after, fields }) => ({ sku, before, after, fields })) };
  if (onPlan) await onPlan(plan.map(({ sku, before, after }) => ({ sku, before, after })));
  const changes = {};
  for (const x of plan) for (const f of x.fields) changes[f] = x.after;
  const { action, entries } = buildPost(target.html, changes);
  const r = await client.post(action, entries);
  if (/Errors were found/i.test(r.text || '') && !/success/i.test(r.location || '')) throw new Error('stock post rejected: ' + (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  const after = await invPages(client);
  for (const x of plan) {
    let vals = null;
    for (const p of after) { const inp = skuInputs(cheerio.load(p.html), x.sku); if (inp?.length) { vals = inp.map((i) => parseInt(i.value, 10)); break; } }
    if (!vals || vals.some((v) => v !== x.after)) throw new Error(`stock: after posting, ${x.sku} reads ${vals?.join(',') ?? 'missing'}, expected ${x.after}. Check it by hand.`);
  }
  return { done: true, plan: plan.map(({ sku, before, after }) => ({ sku, before, after })) };
}

// Receiving: goods in against a QB PO go into the NEXT AVAILABLE QTY (+ NEXT AVAILABLE DATE) on the Inventory Update grid,
// not the current quantity. items: [{ vendor_sku, qty }]; same SKU twice is summed; avail_date (MM/DD/YYYY) is required for a real post.
// Anything not on the grid is reported in `missing`, never created.
const NEXTQ_RE = /next.*qty|qty.*next/i;
const NEXTD_RE = /next.*date|date.*next|avail.*date/i;
export async function addStock(client, items, { dry, avail_date }) {
  if (avail_date && !/^\d{2}\/\d{2}\/\d{4}$/.test(String(avail_date))) throw new Error(`available date ${avail_date} must be MM/DD/YYYY`);
  if (!dry && !avail_date) throw new Error('an available date is required');
  const sums = new Map();
  const missing = [];
  for (const it of items) {
    const sku = String(it.vendor_sku || '').trim(); const qty = Number(it.qty);
    if (!sku) continue;
    if (!Number.isInteger(qty) || qty < 1) { missing.push({ sku, reason: 'quantity must be a whole number of 1 or more' }); continue; }
    sums.set(sku, (sums.get(sku) || 0) + qty);
  }
  const pages = await invPages(client);
  const plan = [];
  const groups = new Map();
  for (const [sku, qty] of sums) {
    let found = null;
    for (const p of pages) {
      const $p = cheerio.load(p.html);
      const q = skuInputs($p, sku, NEXTQ_RE);
      if (q) { found = { p, q, d: skuInputs($p, sku, NEXTD_RE) || [] }; break; }
    }
    if (!found) { missing.push({ sku, reason: 'not on the OrderStream inventory grid' }); continue; }
    if (!found.q.length) { missing.push({ sku, reason: 'no Next Available Qty fields found on its grid row' }); continue; }
    const qtys = found.q.map((x) => parseInt(x.value, 10));
    if (qtys.some(Number.isNaN) || new Set(qtys).size !== 1) { missing.push({ sku, reason: `next available quantities are not one consistent number: ${qtys.join(',')}` }); continue; }
    const row = { sku, before: qtys[0], add: qty, after: qtys[0] + qty, fields: found.q.map((x) => x.name), dateFields: found.d.map((x) => x.name) };
    plan.push(row);
    if (!groups.has(found.p)) groups.set(found.p, []);
    groups.get(found.p).push(row);
  }
  const brief = () => plan.map(({ sku, before, add, after, fields, dateFields }) => ({ sku, before, add, after, date: avail_date || null, fields, dateFields }));
  if (dry || !plan.length) return { dry: !!dry, plan: brief(), missing };
  for (const x of plan) if (!x.dateFields.length) throw new Error(`${x.sku}: no Next Available Date fields found; nothing was changed`);
  for (const [page, rows] of groups) {
    const changes = {};
    for (const x of rows) { for (const f of x.fields) changes[f] = x.after; for (const f of x.dateFields) changes[f] = avail_date; }
    const { action, entries } = buildPost(page.html, changes);
    const r = await client.post(action, entries);
    if (/Errors were found/i.test(r.text || '') && !/success/i.test(r.location || '')) throw new Error('inventory post rejected: ' + (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  }
  const after = await invPages(client);
  for (const x of plan) {
    let vals = null;
    for (const p of after) { const inp = skuInputs(cheerio.load(p.html), x.sku, NEXTQ_RE); if (inp?.length) { vals = inp.map((i) => parseInt(i.value, 10)); break; } }
    if (!vals || vals.some((v) => v !== x.after)) throw new Error(`after posting, ${x.sku} next available qty reads ${vals?.join(',') ?? 'missing'}, expected ${x.after}. Check it on OrderStream.`);
  }
  return { done: true, plan: brief(), missing };
}

const ADD_URL = 'gotoInventoryRealmNewForm.do?bp=inventory&action=web_addproductsku';

export function parseAddForm(html) {
  const $ = cheerio.load(html);
  const form = $('form').filter((_, f) => $(f).find('textarea').length).first();
  if (!form.length) throw new Error('Add Inventory form not found');
  const fields = [];
  form.find('input, select, textarea').each((_, el) => {
    const name = $(el).attr('name'); if (!name) return;
    const type = ($(el).attr('type') || el.tagName).toLowerCase();
    if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return;
    fields.push({ name, type, value: $(el).val() ?? $(el).attr('value') ?? '' });
  });
  return { action: rel(form.attr('action') || ''), fields };
}

export async function addFormInfo(client) { return parseAddForm(await client.get(ADD_URL)); }

export async function addInventorySku(client, sku, { dry }) {
  const need = (v, n) => { if (v == null || v === '') throw new Error(`add SKU: missing ${n}`); return v; };
  need(sku.vendor_sku, 'vendor SKU'); need(sku.unit_cost, 'unit cost');
  if (sku.merchant_sku && !/^\d{8}$/.test(String(sku.merchant_sku))) throw new Error(`add SKU: merchant SKU ${sku.merchant_sku} is not an 8-digit Signet item number`);
  if (!Number.isFinite(Number(sku.unit_cost))) throw new Error(`add SKU: unit cost ${sku.unit_cost} is not a number`);
  if (sku.avail_date && !/^\d{2}\/\d{2}\/\d{4}$/.test(String(sku.avail_date))) throw new Error(`add SKU: available date ${sku.avail_date} must be MM/DD/YYYY`);
  for (const p of await invPages(client)) if (skuInputs(cheerio.load(p.html), sku.vendor_sku)?.length) return { skipped: true, note: `${sku.vendor_sku} already exists` };
  const { action, fields } = parseAddForm(await client.get(ADD_URL));
  const mdy = sku.avail_date || today();
  const qty = String(sku.qty ?? 0);
  const uom = String(sku.vendor_sku).includes('/') ? String(sku.vendor_sku).split('/')[0] + '/' : String(sku.vendor_sku);
  const vals = {
    'sku(0).merchant': 'signetjewelers', 'sku(0).vendorSku': sku.vendor_sku, 'sku(0).merchantSku': String(sku.merchant_sku ?? ''),
    'sku(0).qtyAvail': qty, 'sku(0).unitOfMeasure': uom, 'sku(0).availability': '0',
    'sku(0).unitCost': Number(sku.unit_cost).toFixed(2), 'sku(0).unitRetail': '0.00',
    'sku(0).nextAvailDate': mdy, 'sku(0).availStartDate': mdy, 'sku(0).minBusinessDTS': '0', 'sku(0).maxBusinessDTS': '3',
  };
  if (sku.description) vals['sku(0).description'] = sku.description;
  const whq = fields.find((f) => /warehouseProduct\(\d+\)\.qtyAvail$/.test(f.name));
  if (whq) vals[whq.name] = qty;
  const whd = fields.find((f) => /warehouseProduct\(\d+\)\.nextAvailDate$/.test(f.name));
  if (whd) vals[whd.name] = mdy;
  const entries = fields.map((f) => [f.name, f.name in vals ? vals[f.name] : f.value]);
  if (dry) return { dry: true, action, entries: entries.filter(([, v]) => v !== '') };
  const r = await client.post(action, entries);
  if (/Errors were found|required field|already exists/i.test(r.text || '') && !/success/i.test(r.location || '')) throw new Error('add SKU rejected: ' + (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 250));
  for (const p of await invPages(client)) {
    const inp = skuInputs(cheerio.load(p.html), sku.vendor_sku);
    if (inp?.length) return { done: true, vendor_sku: sku.vendor_sku, qty: parseInt(inp[0].value, 10) };
  }
  throw new Error(`add SKU: posted ${sku.vendor_sku} but it is not on the inventory grid; check OrderStream`);
}
