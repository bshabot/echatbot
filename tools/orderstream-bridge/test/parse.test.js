// Parser test against a SYNTHETIC page built from the structure observed on 2026-11-02
// (field names and text order are real; the HTML tags around them are a guess).
// Re-check against a real saved page: open Quick Ship when an order exists, save the page
// source, and run: node src/sync.js --file saved.html
import assert from 'node:assert/strict';
import { parseQuickShip, parseShipTo } from '../src/parse.js';

const block = (o, i, po, sku, desc, ship) => `
<table><tr><td>PO Number:</td><td>${po}</td><td>placed on</td><td>10/30/2026</td></tr>
<tr><td>Bill To:</td><td>A Person, 1 Main St, Town, NC 28456-9237</td>
<td>Ship To:</td><td>${ship}</td></tr>
<tr><td>Shipment Date</td><td>Tracking Number</td><td>Shipping Method</td></tr>
<tr><td><input type=hidden name="order(${o}).id" value="${o}"><input name="order(${o}).box(1).trackingnumber">
<select name="order(${o}).box(1).shippingmethod"><option value="UG">UPS Ground</option></select></td></tr>
<tr><td>Line #</td><td>Merchant SKU</td><td>Vendor SKU</td><td>Description</td><td>Quantity Remaining</td></tr>
<tr><td>1</td><td>2063${i}</td><td>${sku}</td><td>${desc}</td><td>1</td>
<td><input name="order(${o}).box(1).item(${i}00).shipped"><select name="order(${o}).box(1).item(${i}00).shippingLineWarehouse"><option>Edison</option></select>
<input type=hidden name="order(${o}).box(1).item(${i}00).id" value="${i}00"></td></tr></table>`;

const html = `<html><body>You are here: OrderStream<form action="/dsm/handleOrderRealmFormSubmission.do">
${block('3813070904', '2751', '8422714', 'B2744R-GP/7-DS', '14K Gold Plated CZ Halo Twist Ring', 'Lena Mcmillian,\n 105 Bermuda Xing,\n Apt 210,\n Whiteville,\n NC\n 28472')}
${block('3813648460', '2683', '8427711', 'B2742R-GP/9', '14K Gold Plated Heart CZ Halo Ring', 'Sam Smith, 9 Oak Ave, Raleigh, NC 27601')}
</form></body></html>`;

// the two POs must NOT collapse into one (earlier bug)
const orders = parseQuickShip(html);
assert.equal(orders.length, 2);
assert.deepEqual(orders.map(o => o.po_number), ['8422714', '8427711']);
assert.equal(orders[0].order_date, '10/30/2026');
assert.equal(orders[0].items[0].vendor_sku, 'B2744R-GP/7-DS');
assert.equal(orders[0].items[0].qty, 1);
assert.equal(orders[0].items[0].item_id, '275100');
assert.deepEqual(orders[0].ship_to, { name: 'Lena Mcmillian', lines: ['105 Bermuda Xing', 'Apt 210'], city: 'Whiteville', state: 'NC', zip: '28472', country: 'US', raw: orders[0].ship_to.raw });
assert.equal(orders[1].ship_to.city, 'Raleigh');
assert.ok(orders.every(o => o.problems.length === 0), JSON.stringify(orders.map(o => o.problems)));

// no orders
assert.deepEqual(parseQuickShip('<html>No order(s) found that match the supplied criteria.</html>'), []);

// mismatch -> refuse to guess
assert.throws(() => parseQuickShip(html.replace('PO Number:', 'X:')), /refusing to guess/);

// layout change -> loud failure, not silence
assert.throws(() => parseQuickShip('<html><body>something else</body></html>'), /form not found/);

assert.equal(parseShipTo('Nobody').zip, undefined);
console.log('parse tests passed');
