// Cloud OrderStream client for the Supabase Edge Function: cookie jar, manual redirects, HTTP login.
// Session cookies live in dropship_session (service role only). Never logs cookie or password values.
export class SessionExpired extends Error {}
const BASE = 'https://dsm.commercehub.com/dsm/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';

export class Jar {
  constructor(items = []) { this.items = items; } // {name,value,domain,path}
  header(url) {
    const u = new URL(url);
    return this.items.filter(c => (u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) && u.pathname.startsWith(c.path))
      .map(c => `${c.name}=${c.value}`).join('; ');
  }
  absorb(res, url) {
    const u = new URL(url);
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';').map(s => s.trim());
      const i = pair.indexOf('='); if (i < 1) continue;
      let domain = u.hostname, path = '/';
      for (const a of attrs) {
        const [k, v] = a.split('='); const kk = k.toLowerCase();
        if (kk === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
        if (kk === 'path' && v) path = v;
      }
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      this.items = this.items.filter(c => !(c.name === name && c.domain === domain && c.path === path));
      if (value) this.items.push({ name, value, domain, path });
    }
  }
}

async function hop(jar, url, init = {}, trace = null) {
  const res = await fetch(url, { redirect: 'manual', ...init,
    headers: { 'user-agent': UA, cookie: jar.header(url), ...(init.headers || {}) } });
  jar.absorb(res, url);
  trace?.push(`${init.method || 'GET'} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}`);
  return res;
}
// Follow redirects until a non-redirect, or until stopAt(url) is true. Returns {res, url}.
async function follow(jar, url, trace, stopAt = () => false, max = 15) {
  for (let i = 0; i < max; i++) {
    if (stopAt(url)) return { res: null, url };
    const res = await hop(jar, url, {}, trace);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    return { res, url };
  }
  throw new Error('too many redirects');
}

// Best-effort Frontegg login over plain HTTP. Returns the jar on success; throws with a step trace on failure.
export async function httpLogin(email, password) {
  const jar = new Jar(), trace = [];
  try {
    const authUrl = BASE + 'gotoHome.do';
    // 1. walk to the Frontegg authorize/prelogin page
    let url = authUrl, ssoPrelogin = null, authorize = null;
    for (let i = 0; i < 12; i++) {
      const res = await hop(jar, url, {}, trace);
      const loc = res.headers.get('location');
      if (!(res.status >= 300 && res.status < 400 && loc)) break;
      url = new URL(loc, url).toString();
      if (/sso\.auth\.commercehub\.com\/oauth\/authorize/.test(url)) authorize = url;
      if (/sso\.auth\.commercehub\.com\/oauth\/prelogin/.test(url)) { ssoPrelogin = url; break; }
    }
    if (!authorize) throw new Error('no authorize url found');
    const origin = 'https://sso.auth.commercehub.com';
    const jsonH = { 'content-type': 'application/json', origin, referer: ssoPrelogin || authorize };
    // 2. email step, then password step (Frontegg identity API)
    await hop(jar, origin + '/frontegg/identity/resources/auth/v2/user/sso/prelogin', { method: 'POST', headers: jsonH, body: JSON.stringify({ email }) }, trace);
    const lr = await hop(jar, origin + '/frontegg/identity/resources/auth/v1/user', { method: 'POST', headers: jsonH, body: JSON.stringify({ email, password }) }, trace);
    if (lr.status !== 200) throw new Error(`password login returned HTTP ${lr.status}`);
    const body = await lr.json().catch(() => ({}));
    if (body.mfaRequired || body.mfaToken) throw new Error('account now requires MFA');
    // 3. re-run authorize now that the Frontegg session cookies exist; follow to the CAS ticket on dsm
    const { res, url: end } = await follow(jar, authorize, trace);
    if (!/dsm\.commercehub\.com/.test(end)) throw new Error('did not land on dsm after login: ' + new URL(end).host);
    return { jar, trace };
  } catch (e) { e.trace = trace; throw e; }
}

export function makeClient(jar) {
  const audit = { pageUrl: null, post: null };
  const check = (res, text) => {
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      if (/sso\.auth|account\/login|logout|shiro-cas/i.test(loc)) throw new SessionExpired('Session expired (redirected to login).');
      throw new Error(`Unexpected redirect ${res.status} -> ${loc.slice(0, 80)}`);
    }
    if (text && /frontegg|sso\.auth\.commercehub/i.test(text) && !/OrderStream/i.test(text)) throw new SessionExpired('Got a login page.');
  };
  async function get(p) {
    const url = BASE + p;
    const res = await hop(jar, url, { headers: { accept: 'text/html,*/*' } });
    const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
    check(res, text);
    if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
    return text;
  }
  async function post(p, entries) {
    const url = BASE + p;
    const res = await hop(jar, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://dsm.commercehub.com' }, body: new URLSearchParams(entries).toString() });
    const location = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && /sso\.auth|account\/login|logout/i.test(location)) throw new SessionExpired('Session expired during POST.');
    const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
    audit.post = { url, fields: entries, status: res.status, location, excerpt: text.replace(/\s+/g, ' ').slice(0, 600) };
    return { status: res.status, location, text };
  }
  async function getBinary(p) {
    const res = await hop(jar, BASE + p, { headers: { accept: '*/*' } });
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      if (/sso\.auth|account\/login|logout|shiro-cas/i.test(loc)) throw new SessionExpired('Session expired during download.');
      throw new Error(`Unexpected redirect ${res.status} -> ${loc.slice(0, 80)}`);
    }
    return { status: res.status, contentType: res.headers.get('content-type') || '', bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return {
    get, post, getBinary, audit,
    keepAlive: () => get('refreshSession.do'),
    quickInvoiceOpen: (m = 'signetjewelers') => get(audit.pageUrl = (Deno.env.get('OS_QUICKINVOICE_URL') || `gotoOrderRealmForm.do?action=web_quickinvoice&tabContext=web_quickinvoice&status=shipped&substatus=needs-invoicing&merchant=${m}`)),
    quickShipOpen: (m = 'signetjewelers') => get(audit.pageUrl = `gotoOrderRealmForm.do?action=web_quickship&tabContext=web_quickship&status=open&substatus=no-activity&merchant=${m}`),
  };
}
