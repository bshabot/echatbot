// OrderStream WRITE steps. Each step: build the form from the live page, POST it, then VERIFY on OrderStream.
// Built from recorded field names; untested until the first real order runs. DRY=true posts nothing.
import * as cheerio from 'cheerio';

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
  if (!has) return { skipped: true, note: 'order not on Quick Ship open list (already shipped?)' }; // idempotent
  if (!job.tracking || !SHIP_CODE[job.ship_method]) throw new Error('missing tracking or unknown ship_method ' + job.ship_method);
  const o = `order(${job.order_id})`;
  set(out, `${o}.shipmentdate`, today());
  set(out, `${o}.box(1).trackingnumber`, job.tracking);
  set(out, `${o}.box(1).shippingmethod`, SHIP_CODE[job.ship_method]);
  for (const it of job.items) {
    const k = `${o}.box(1).item(${it.item_id})`;
    set(out, `${k}.shipped`, String(it.qty)); set(out, `${k}.shippingLineWarehouse`, 'Edison');
  }
  set(out, 'tabContext', 'web_quickship'); set(out, 'confirmbtn', 'Confirm');
  if (dry) return { dry: true, fields: out.filter(([n]) => n.startsWith(o) || n === 'tabContext') };
  const r = await client.post(POST_URL, out);
  if (bad(r)) throw new Error('Ship rejected: ' + errorsIn(r.text));
  if (!ok(r)) throw new Error(`Ship: unrecognized response (HTTP ${r.status})`);
  if (formFields(await client.quickShipOpen(), job.order_id).has) throw new Error('Ship accepted but order still on open list');
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
  for (const it of job.items) set(out, `${o}.box(1).item(${it.item_id}).invoiced`, String(it.qty));
  set(out, 'tabContext', 'web_quickinvoice'); set(out, 'confirmbtn', 'Confirm');
  if (dry) return { dry: true, invoice_number: num };
  const r = await client.post(POST_URL, out);
  if (bad(r)) throw new Error('Invoice rejected: ' + errorsIn(r.text));
  if (!ok(r)) throw new Error(`Invoice: unrecognized response (HTTP ${r.status})`);
  if (formFields(await client.quickInvoiceOpen(), job.order_id).has) throw new Error('Invoice accepted but order still on list');
  return { done: true, invoice_number: num };
}

// Stock: subtract shipped qty from the EXACT vendor SKU row (sizes are separate rows), then read the grid back.
// The bulk POST needs inventoryPayload/skudates that page JS builds on submit; those have never been captured,
// so live stock posting is blocked until they are. Dry run reads the grid and reports before/after only.
export async function updateStock(client, job, { dry, gridHtml }) {
  const $ = cheerio.load(gridHtml);
  const plan = [];
  for (const it of job.items) {
    const rows = $('tr').filter((_, tr) => $(tr).find(`input[name="vendorSKU"]`).filter((_, i) => $(i).val() === it.vendor_sku).length);
    if (rows.length !== 1) throw new Error(`stock row for ${it.vendor_sku}: found ${rows.length}, need exactly 1`);
    const input = rows.find('input[name^="value(O-"][name$="new_qty"]');
    const before = parseInt(input.val(), 10);
    if (Number.isNaN(before)) throw new Error(`no quantity for ${it.vendor_sku}`);
    plan.push({ sku: it.vendor_sku, before, after: before - it.qty, field: input.attr('name') });
  }
  if (dry) return { dry: true, plan };
  throw new Error('Live stock post blocked: inventoryPayload/skudates not captured yet. Stock must be done by hand for now.');
}
