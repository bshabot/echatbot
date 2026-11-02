// Minimal OrderStream client: cookie header from auth.json, GET only.
// Never logs cookie values.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://dsm.commercehub.com/dsm/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SessionExpired extends Error {}

export async function loadCookies(file = path.join(ROOT, 'auth.json')) {
  let raw;
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('auth.json missing or invalid. Copy auth.example.json to auth.json and paste the cookie values.'); }
  const need = ['JSESSIONID', 'BIGipServer~prod-orderstream~pool_orderstream'];
  const missing = need.filter(k => !raw[k] || /paste/i.test(raw[k]));
  if (missing.length) throw new Error('auth.json is missing: ' + missing.join(', '));
  return Object.entries(raw).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function makeClient(cookieHeader) {
  async function get(p) {
    const res = await fetch(BASE + p, {
      redirect: 'manual',
      headers: {
        cookie: cookieHeader,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36',
        accept: 'text/html,*/*'
      }
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (/sso\.auth|login|logout/i.test(loc)) throw new SessionExpired('Session expired (redirected to login). Paste fresh cookies into auth.json.');
      throw new Error(`Unexpected redirect ${res.status} -> ${loc.slice(0, 80)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
    if (/frontegg|sso\.auth\.commercehub/i.test(text) && !/OrderStream/i.test(text)) throw new SessionExpired('Got a login page instead of OrderStream.');
    return text;
  }
  return {
    get,
    keepAlive: () => get('refreshSession.do'),
    quickShipOpen: (merchant = 'signetjewelers') =>
      get(`gotoOrderRealmForm.do?action=web_quickship&tabContext=web_quickship&status=open&substatus=no-activity&merchant=${merchant}`)
  };
}
