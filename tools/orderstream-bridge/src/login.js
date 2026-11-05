// Automated OrderStream login (Frontegg SSO) with Playwright.
// Credentials come from the environment (.env on the machine that runs the job):
//   ORDERSTREAM_EMAIL, ORDERSTREAM_PASSWORD
// On success it writes the two session cookies to auth.json. Values are never printed.
//   node --env-file=.env src/login.js            headless
//   HEADED=1 node --env-file=.env src/login.js   watch it (use this for the first run)
// UNTESTED against the live login page: selectors below are generic guesses for the
// two-step Frontegg form (email -> Continue -> password -> Sign in).
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_URL = 'https://dsm.commercehub.com/dsm/gotoHome.do';
const WANT = ['JSESSIONID', 'BIGipServer~prod-orderstream~pool_orderstream'];

export async function login({ headed = !!process.env.HEADED } = {}) {
  const email = process.env.ORDERSTREAM_EMAIL, password = process.env.ORDERSTREAM_PASSWORD;
  if (!email || !password) throw new Error('Set ORDERSTREAM_EMAIL and ORDERSTREAM_PASSWORD in .env');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !headed });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

    // Already inside? (should not happen with a fresh context)
    if (!/dsm\.commercehub\.com\/dsm\//.test(page.url())) {
      const emailBox = page.locator('input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="username"]').first();
      await emailBox.waitFor({ timeout: 30000 });
      await emailBox.fill(email);
      await page.getByRole('button', { name: /continue|next|sign in|log in/i }).first().click();

      const pw = page.locator('input[type="password"]').first();
      await pw.waitFor({ timeout: 30000 });
      await pw.fill(password);
      await page.getByRole('button', { name: /sign in|log in|continue|submit/i }).first().click();
      await page.waitForURL(/dsm\.commercehub\.com\/dsm\//, { timeout: 60000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const cookies = await ctx.cookies('https://dsm.commercehub.com');
    const out = {};
    for (const n of WANT) {
      const c = cookies.find(x => x.name === n);
      if (!c) throw new Error(`Login finished but cookie ${n} was not set. Run with HEADED=1 to see what happened.`);
      out[n] = c.value;
    }
    await writeFile(path.join(ROOT, 'auth.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
    return Object.keys(out);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  login().then(n => console.log('Logged in. Saved cookies:', n.join(', ')))
    .catch(e => { console.error('LOGIN FAILED:', e.message); process.exit(1); });
}
