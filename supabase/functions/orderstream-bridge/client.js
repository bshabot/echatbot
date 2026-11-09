import * as cheerio from 'npm:cheerio@1.0.0';

export class SessionExpired extends Error {}
const BASE = 'https://dsm.commercehub.com/dsm/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';

export class Jar {
  constructor(items = []) { this.items = items; }
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

export async function httpLogin(email, password) {
  const jar = new Jar(), trace = [];
  try {
    const authUrl = BASE + 'gotoHome.do';
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
    const pre = await hop(jar, origin + '/frontegg/identity/resources/auth/v2/user/sso/prelogin', { method: 'POST', headers: jsonH, body: JSON.stringify({ email }) }, trace);
    trace.push('prelogin body: ' + (await pre.text().catch(() => '')).slice(0, 200));
    const lr = await hop(jar, origin + '/frontegg/identity/resources/auth/v1/user', { method: 'POST', headers: jsonH, body: JSON.stringify({ email, password }) }, trace);
    if (lr.status !== 200) throw new Error(`password login returned HTTP ${lr.status}`);
    const body = await lr.json().catch(() => ({}));
    trace.push('login response keys: ' + Object.keys(body).join(',') + (body.mfaRequired ? ' [mfaRequired]' : '') + (body.emailVerified === false ? ' [emailNotVerified]' : ''));
    if (body.mfaRequired || body.mfaToken) throw new Error('account now requires MFA');
    const { res, url: end } = await follow(jar, authorize, trace);
    if (res) { const snip = (await res.text().catch(() => '')).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250); trace.push('landing ' + new URL(end).host + new URL(end).pathname + ': ' + snip); }
    if (!/dsm\.commercehub\.com/.test(end)) throw new Error('did not land on dsm after login: ' + new URL(end).host);
    return { jar, trace };
  } catch (e) { e.trace = trace; throw e; }
}

const relUrl = (u) => String(u).replace(/^https?:\/\/[^/]+/, '').replace(/^\/dsm\//, '');

export function makeClient(jar) {
  const audit = { pageUrl: null, post: null };
  const check = (res, text) => {
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      if (/sso\.auth|account\/login|logout|shiro-cas/i.test(loc)) throw new SessionExpired('Session expired (redirected to login: ' + loc.slice(0, 120) + ').');
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

  // Order lists are paged (10 per page). The page's own navigateToPage(n) sets the form's `page` field,
  // appends a hidden performNewPaging=true, and submits the primary form. We replay exactly that (minus the per-order fields).
  const idsOf = (h) => new Set([...h.matchAll(/order\((\d+)\)\.id/g)].map((m) => m[1]));
  async function nextPage(firstHtml, n) {
    const $ = cheerio.load(firstHtml);
    const form = $('input[name="page"]').first().closest('form');
    if (!form.length) throw new Error('paging form not found on the order list');
    const action = relUrl(form.attr('action') || 'gotoOrderRealmForm.do');
    const method = (form.attr('method') || 'get').toLowerCase();
    const entries = [];
    form.find('input, select').each((_, el) => {
      const name = $(el).attr('name'); if (!name || /^order\(/.test(name)) return;
      const type = ($(el).attr('type') || el.tagName).toLowerCase();
      if (['button', 'submit', 'image', 'file', 'reset'].includes(type)) return;
      if ((type === 'checkbox' || type === 'radio') && !$(el).is(':checked')) return;
      entries.push([name, name === 'page' ? String(n) : String($(el).val() ?? $(el).attr('value') ?? '')]);
    });
    if (!entries.some(([k]) => k === 'page')) entries.push(['page', String(n)]);
    entries.push(['performNewPaging', 'true']);
    const note = `${method.toUpperCase()} ${action}`;
    let html;
    if (method === 'post') {
      const r = await post(action, entries);
      if (r.status >= 300 && r.status < 400 && r.location) html = await get(relUrl(new URL(r.location, BASE).toString()));
      else html = r.text;
    } else {
      html = await get(action + (action.includes('?') ? '&' : '?') + new URLSearchParams(entries).toString());
    }
    return { html, note };
  }
  async function listPages(url) {
    const first = await get(audit.pageUrl = url);
    const pages = [first];
    const m = first.match(/Displaying\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+Records/i);
    const total = m ? Number(m[1]) : null;
    if (!total) return { pages, total: idsOf(first).size || null };
    const seen = idsOf(first);
    for (let n = 2; seen.size < total && n <= 30; n++) {
      const { html, note } = await nextPage(first, n);
      const before = seen.size;
      for (const id of idsOf(html)) seen.add(id);
      if (seen.size === before) throw new Error(`paging did not return new orders on page ${n} (${note}); read ${seen.size} of ${total}`);
      pages.push(html);
    }
    return { pages, total };
  }

  const invoiceUrl = (m) => Deno.env.get('OS_QUICKINVOICE_URL') || `gotoOrderRealmForm.do?action=web_quickinvoice&tabContext=web_quickinvoice&status=shipped&substatus=needs-invoicing&merchant=${m}`;
  const shipUrl = (m) => `gotoOrderRealmForm.do?action=web_quickship&tabContext=web_quickship&status=open&substatus=no-activity&merchant=${m}`;
  return {
    get, post, getBinary, audit,
    keepAlive: () => get('refreshSession.do'),
    quickInvoiceOpen: (m = 'signetjewelers') => get(audit.pageUrl = invoiceUrl(m)),
    quickShipOpen: (m = 'signetjewelers') => get(audit.pageUrl = shipUrl(m)),
    quickShipPages: (m = 'signetjewelers') => listPages(shipUrl(m)),
    quickInvoicePages: (m = 'signetjewelers') => listPages(invoiceUrl(m)),
  };
}
