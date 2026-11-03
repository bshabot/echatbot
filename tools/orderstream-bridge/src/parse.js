// Parses the Quick Ship "Open Orders (No Activity)" page into order objects.
// Order ids/item ids come from form field names; PO/date/address/lines from the page.
import * as cheerio from 'cheerio';

const NO_ORDERS = /No order\(s\) found/i;

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

export function parseShipTo(segment) {
  // "Name, 105 Bermuda Xing, Apt 210, Whiteville, NC 28472"
  const t = clean(segment);
  const m = t.match(/([A-Z]{2})[\s,]+(\d{5}(?:-\d{4})?)\s*$/);
  if (!m) return { raw: t };
  const head = t.slice(0, m.index).split(',').map(clean).filter(Boolean);
  const [name, ...rest] = head;
  const city = rest.pop() || '';
  return { name: name || '', lines: rest, city, state: m[1], zip: m[2], country: 'US', raw: t };
}

export function parseQuickShip(html) {
  if (NO_ORDERS.test(html) && !/handleOrderRealmFormSubmission/.test(html)) return [];
  const $ = cheerio.load(html);
  const form = $('form[action$="handleOrderRealmFormSubmission.do"]').first();
  if (!form.length) throw new Error('Quick Ship form not found; page layout may have changed.');

  const orderIds = [];
  form.find('input[name]').each((_, el) => {
    const m = ($(el).attr('name') || '').match(/^order\((\d+)\)\.id$/);
    if (m) orderIds.push(m[1]);
  });

  // PO blocks in document order: text split on "PO Number:".
  const text = form.text();
  const blocks = text.split(/PO Number:/i).slice(1);
  if (blocks.length !== orderIds.length) {
    throw new Error(`Found ${orderIds.length} order ids but ${blocks.length} PO blocks; refusing to guess.`);
  }

  return orderIds.map((orderId, i) => {
    const b = blocks[i];
    const po = (clean(b).match(/^(\d+)/) || [])[1] || null;
    const placed = (clean(b).match(/placed on\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null;
    const shipSeg = (b.match(/Ship To:([\s\S]*?)Shipment Date/i) || [])[1] || '';
    const billSeg = (b.match(/Bill To:([\s\S]*?)Ship To:/i) || [])[1] || '';

    const items = [];
    form.find(`input[name^="order(${orderId}).box(1).item("][name$=".id"]`).each((_, el) => {
      const itemId = $(el).attr('value');
      const shipped = form.find(`input[name="order(${orderId}).box(1).item(${itemId}).shipped"]`).first();
      const row = shipped.closest('tr');
      const cells = row.children('td').map((_, td) => clean($(td).text())).get();
      // Expected columns: Line #, Merchant SKU, Vendor SKU, Description, Qty Remaining, ...
      const rowText = clean(row.text());
      const m = rowText.match(/^(\d+)\s+(\d{8})\s+(\S+)\s+(.+?)\s+(\d+)\s/);
      items.push({
        item_id: itemId,
        line: Number(cells[0] || (m && m[1]) || 0) || null,
        merchant_sku: /^\d{8}$/.test(cells[1] || '') ? cells[1] : (m && m[2]) || null,
        vendor_sku: cells[2] || (m && m[3]) || null,
        description: cells[3] || (m && m[4]) || null,
        qty: Number(cells[4] || (m && m[5]) || 0) || null
      });
    });

    const problems = [];
    if (!po) problems.push('no PO');
    if (!items.length) problems.push('no items');
    items.forEach(it => { if (!it.vendor_sku || !it.qty) problems.push(`item ${it.item_id} missing sku/qty`); });
    const shipTo = parseShipTo(shipSeg);
    if (!shipTo.zip) problems.push('ship-to not parsed');

    return {
      order_id: orderId,
      po_number: po,
      order_date: placed,
      merchant: 'signetjewelers',
      ship_to: shipTo,
      bill_to: clean(billSeg),
      items,
      problems
    };
  });
}
