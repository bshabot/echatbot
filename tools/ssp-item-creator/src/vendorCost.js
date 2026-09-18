/**
 * Fetch the vendor cost breakdown for one item and print it (highlighting
 * vendorPurchCost). Needs a valid token in auth.json.
 *
 *   node src/vendorCost.js S191762 1
 */

import { SspClient, loadToken } from './sspClient.js';

const [ssp, itemIdArg] = process.argv.slice(2);
if (!ssp || !itemIdArg) {
  console.error('Usage: node src/vendorCost.js <sspCode> <itemId>');
  process.exit(1);
}
const itemId = Number(itemIdArg);

const client = new SspClient({ token: loadToken() });

const result = await client.getVendorCost(ssp, itemId);
console.log('full response:', JSON.stringify(result, null, 2));
console.log('\nvendorPurchCost:', result?.data?.vendorPurchCost ?? '(not found in data — see full response above)');
