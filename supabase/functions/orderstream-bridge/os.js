// OrderStream WRITE steps. Each step: build the form from the live page, POST it, then VERIFY on OrderStream.
// Built from recorded field names; untested until the first real order runs. DRY=true posts nothing.
import * as cheerio from 'npm:cheerio@1.0.0';

const POST_URL = 'handleOrderRealmFormSubmission.do';
export const SHIP_CODE = { '03': 'UG', '13': 'UPSN_PM', '01': 'UR' }; // ups-ship service -> OrderStream code
const today = () => { const d = new Date(); return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };

// All form fields on the page, in order. Only this order's fields + form-level hidden fields are kept.
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
const set = (arr, name, val) => { const i = arr.findIndex(([n]) => n === name); i >= 0 ? (arr[i][1] = val) : arr.push([name, val]); };
const errorsIn = (t) => { const $ = cheerio.load(t); return $('.error, .errors, [class*=error]').text().replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'; };
const ok = (r) => /gotoOrderRealmSuccessMessage/.test(r.location) || /successfully applied/i.test(r.text);
const bad = (r) => /Errors were found/i.test(r.text);

export async function shipOrder(client, job, { dry }) {
  const html = await client.quickShipOpen();
  const { out, has } = formFields(html, job.order_id);
  if (!has) { // not on the open list: only treat as shipped if it is on Needs Invoicing, otherwise a human must look
    if (formFields(await client.quickInvoiceOpen(), job.order_id).has) return { done: true, note: 'already shipped (found on Needs Invoicing)' };
    throw new Error('order is not on the Quick Ship open list and not on Needs Invoicing - check it on OrderStream before retrying');
  } // idempotent
  const method = SHIP_CODE[job.ship_method] ?? (Object.values(SHIP_CODE).includes(job.ship_method) ? job.ship_method : null); // PLM stores the OrderStream code (UG), accept either
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
  const still = formFields(await client.quickShipOpen(), job.order_id).has;
  if (!ok(r) && still) throw new Error(`Ship: unrecognized response (HTTP ${r.status}) and order still on open list: ` + cheerio.load(r.text)('body').text().replace(/\s+/g,' ').trim().slice(0,300));
  if (ok(r) && still) throw new Error('Ship accepted but order still on open list');
  return { done: true };
}

export async function invoiceOrder(client, job, { dry }) {
  const html = await client.quickInvoiceOpen();
  const { out, has } = formFields(html, job.order_id);
  if (!has) return { skipped: true, note: 'order not on Needs Invoicing list (already invoiced?)' };
  const o = `order(${job.order_id})`;
  // Auto Fill button holds a server-assigned invoice number in its onclick
  const $ = cheerio.load(html);
  const btn = $(`[onclick*="${job.order_id}"]`).filter((_, e) => /invoicenumber/i.test($(e).attr('onclick') || '')).first();
  const num = (btn.attr('onclick') || '').match(/['"](\d{9})['"]/)?.[1];
  if (!num) throw new Error('could not read the Auto Fill invoice number from the page');
  set(out, `${o}.invoicenumber`, num);
  // Needs Invoicing form: order(X).item(ID).invoiced (no box), plus a total the page JS normally computes
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
  const still = formFields(await client.quickInvoiceOpen(), job.order_id).has;
  if (!ok(r) && still) throw new Error(`Invoice: unrecognized response (HTTP ${r.status}) and order still on list: ` + cheerio.load(r.text)('body').text().replace(/\s+/g,' ').trim().slice(0,300));
  if (ok(r) && still) throw new Error('Invoice accepted but order still on list');
  return { done: true, invoice_number: num };
}

// Stock: subtract shipped qty from the EXACT vendor SKU row (sizes are separate rows), then read the grid back.
// The bulk POST needs inventoryPayload/skudates that page JS builds on submit; those have never been captured,
// so live stock posting is blocked until they are. Dry run reads the grid and reports before/after only.
// ---- Stock: subtract the shipped qty from the exact vendor SKU on Inventory Update, then read it back. ----
const INV_URL = 'gotoUpdateInventorySearch.do?start_row=1&searchType=invQuickSearch&new=1&merchantList=signetjewelers';
const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/^\/dsm\//, '');

// All pages of the grid we can reach (50 per page); each is a separate form submission.
async function invPages(client) {
  const first = await client.get(INV_URL);
  const pages = [{ url: INV_URL, html: first }];
  const $ = cheerio.load(first);
  const seen = new Set();
  $('a[href*="pager.offset="]').each((_, a) => { const h = $(a).attr('href'); if (h && !seen.has(h)) seen.add(h); });
  for (const h of seen) { try { pages.push({ url: rel(h), html: await client.get(rel(h)) }); } catch (_) { /* ignore */ } }
  return pages;
}

// Finds a SKU's rows on one page: the aggregate row (has the SKU link) plus the warehouse rows after it.
function skuInputs($, sku) {
  const rows = $('tr').filter((_, tr) => !$(tr).find('tr').length).toArray(); // leaf rows only (layout tables nest)
  const start = rows.findIndex((tr) => $(tr).find('a').filter((_, a) => $(a).text().replace(/\s+/g, '') === sku.replace(/\s+/g, '')).length);
  if (start < 0) return null;
  let end = start + 1;
  while (end < rows.length && !$(rows[end]).find('a[href*="Sku"], a[href*="sku"], td:first-child a').length) end++;
  const inputs = [];
  for (let k = start; k < end; k++) $(rows[k]).find('input[name]').each((_, el) => {
    const n = $(el).attr('name');
    if (/new_qty\)$|warehouseQty/i.test(n) || /new_qty/.test(n)) inputs.push({ name: n, value: $(el).val() ?? '' });
  });
  return inputs;
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
  let target = null; // single page that holds all changes (one form submission)
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
  const applied = job.stock_plan?.[0]?.applied;
  if (job.stock_plan?.length) { // a previous attempt recorded a plan: never subtract twice
    const prev = job.stock_plan;
    const nowMatchesAfter = plan.every((x) => prev.find((p) => p.sku === x.sku)?.after === x.before);
    if (nowMatchesAfter) return { done: true, plan: prev, note: 'already applied (grid matches the recorded plan)' };
    const stillBefore = plan.every((x) => prev.find((p) => p.sku === x.sku)?.before === x.before);
    if (!stillBefore) throw new Error('stock: grid changed since the plan was recorded; check by hand');
  }
  if (dry) return { dry: true, plan: plan.map(({ sku, before, after }) => ({ sku, before, after })) };
  if (onPlan) await onPlan(plan.map(({ sku, before, after }) => ({ sku, before, after }))); // recorded BEFORE posting
  const changes = {};
  for (const x of plan) for (const f of x.fields) changes[f] = x.after;
  const { action, entries } = buildPost(target.html, changes);
  const r = await client.post(action, entries);
  if (/Errors were found|error/i.test(r.text || '') && !/success/i.test(r.location || '')) throw new Error('stock post rejected: ' + (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  const after = await invPages(client);
  for (const x of plan) {
    let vals = null;
    for (const p of after) { const inp = skuInputs(cheerio.load(p.html), x.sku); if (inp?.length) { vals = inp.map((i) => parseInt(i.value, 10)); break; } }
    if (!vals || vals.some((v) => v !== x.after)) throw new Error(`stock: after posting, ${x.sku} reads ${vals?.join(',') ?? 'missing'}, expected ${x.after}. Check it by hand.`);
  }
  return { done: true, plan: plan.map(({ sku, before, after }) => ({ sku, before, after })) };
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

// Mirrors how the existing items were set up: UoM = style prefix + '/', UPC / mfr SKU / dept / description / condition blank,
// unit cost 2 = 0.00, next available date = availability start date = chosen date (default today), ships in 0-3 business days, Edison warehouse.
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
