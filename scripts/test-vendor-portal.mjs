// HTTP-level checks of the deployed vendor portal. Run against STAGING first,
// then once against production with a throwaway vendor account that staff
// delete afterwards.
//
//   BASE_URL=https://staging.example.com \
//   VP_EMAIL=throwaway@example.com VP_PASSWORD='the-real-password-after-first-login' \
//   node scripts/test-vendor-portal.mjs
//
// The throwaway account must already have chosen its own password (first
// login forces a change). Prints PASS/FAIL per check; exit 1 on any FAIL.
// Plan: docs/vendor-portal-build-plan.md

const BASE = (process.env.BASE_URL || "").replace(/\/+$/, "");
const EMAIL = process.env.VP_EMAIL || "";
const PASSWORD = process.env.VP_PASSWORD || "";
if (!BASE || !EMAIL || !PASSWORD) {
  console.error("Set BASE_URL, VP_EMAIL and VP_PASSWORD.");
  process.exit(2);
}

const FN = `${BASE}/.netlify/functions/vendor-portal`;
const results = [];
const check = (name, ok, extra = "") => results.push({ name, ok: Boolean(ok), extra });

async function post(body, { cookie, origin = BASE, header = "1", contentType = "application/json" } = {}) {
  const t = performance.now();
  const res = await fetch(FN, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(origin ? { origin } : {}),
      ...(header ? { "x-vendor-portal": header } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  return { res, text, ms: performance.now() - t };
}

// Headers on the page and the function
const page = await fetch(`${BASE}/vendor`, { redirect: "manual" });
const ph = (n) => page.headers.get(n) || "";
check("page: no-store", /no-store/.test(ph("cache-control")));
check("page: Content-Security-Policy present", /default-src/.test(ph("content-security-policy")));
check("page: Referrer-Policy no-referrer", ph("referrer-policy") === "no-referrer");
check("page: noindex", /noindex/.test(ph("x-robots-tag")));

// Cross-site / malformed requests
check("cross-site origin rejected", (await post({ action: "info" }, { origin: "https://evil.example" })).res.status === 403);
check("no origin rejected", (await post({ action: "info" }, { origin: "" })).res.status === 403);
check("missing custom header rejected", (await post({ action: "info" }, { header: "" })).res.status === 403);
check("wrong content type rejected", (await post({ action: "info" }, { contentType: "text/plain" })).res.status === 415);

// Unknown email vs wrong password: same text, same status, similar timing
const u = await post({ action: "login", email: `nobody-${Date.now()}@example.com`, password: "not-the-password-1" });
const w = await post({ action: "login", email: EMAIL, password: "not-the-password-1" });
check("unknown email vs wrong password: same body", u.text === w.text, u.text);
check("unknown email vs wrong password: same status", u.res.status === w.res.status && w.res.status === 401);
check("login timing is similar", Math.abs(u.ms - w.ms) < Math.max(250, Math.min(u.ms, w.ms) * 0.75), `${u.ms.toFixed(0)}ms vs ${w.ms.toFixed(0)}ms`);

// Good login: cookie flags
const ok = await post({ action: "login", email: EMAIL, password: PASSWORD });
const cookieHeader = ok.res.headers.get("set-cookie") || "";
check("login succeeds", ok.res.status === 200, `status ${ok.res.status}`);
check("cookie is HttpOnly, Secure, SameSite=Strict", /HttpOnly/i.test(cookieHeader) && /Secure/i.test(cookieHeader) && /SameSite=Strict/i.test(cookieHeader));
check("function responses are no-store", /no-store/.test(ok.res.headers.get("cache-control") || ""));
const cookie = cookieHeader.split(";")[0];

if (ok.res.status === 200) {
  const info = await post({ action: "info" }, { cookie });
  check("info returns vendor name", /"vendor"/.test(info.text));
  check("info exposes no secrets", !/hash|password|service_role|apikey/i.test(info.text));

  const extra = await post(
    { action: "submit", rows: [{ style_number: "ZZTEST", factory_cost: 1, cost_currency: "USD", weight: 1, metal_type: "Silver", karat: "925", salesPrice: 99, status: "approved", sample_id: 1 }] },
    { cookie }
  );
  const mine = await post({ action: "mine" }, { cookie });
  check("submit works", extra.res.status === 200, extra.text.slice(0, 120));
  check("forbidden fields are not stored", !/salesPrice|sample_id/.test(mine.text) && !/"status":"approved"/.test(mine.text));

  const oversize = await post({ action: "submit", rows: Array.from({ length: 101 }, () => ({ style_number: "X", factory_cost: 1, cost_currency: "USD", weight: 1, metal_type: "Silver", karat: "925" })) }, { cookie });
  check("too many rows rejected", oversize.res.status === 400);
  const longField = await post({ action: "submit", rows: [{ style_number: "A".repeat(500), weight: 1, metal_type: "Silver", karat: "925" }] }, { cookie });
  check("long field rejected", longField.res.status === 400);
  const xss = await post({ action: "submit", rows: [{ style_number: "<img src=x onerror=alert(1)>", factory_cost: 1, cost_currency: "USD", weight: 1, metal_type: "Silver", karat: "925" }] }, { cookie });
  check("script text accepted only as inert text (stored, never rendered as HTML)", xss.res.status === 200 || xss.res.status === 400);

  // CAD files: refused types and sizes, then a real upload round trip to private storage
  const badExt = await post({ action: "fileBegin", name: "virus.exe", size: 100 }, { cookie });
  check("file: .exe refused", badExt.res.status === 400);
  const bigSize = await post({ action: "fileBegin", name: "a.stl", size: 200 * 1024 * 1024 }, { cookie });
  check("file: over 100 MB refused", bigSize.res.status === 400);
  const begin = await post({ action: "fileBegin", name: "zz test.stl", size: 20 }, { cookie });
  let beginData = {};
  try { beginData = JSON.parse(begin.text); } catch { /* ignore */ }
  check("file: begin returns an upload URL and no storage path", begin.res.status === 200 && /^https:\/\//.test(beginData.uploadUrl || "") && !/vendor\//.test(begin.text.replace(beginData.uploadUrl || "", "")));
  if (begin.res.status === 200 && beginData.uploadUrl) {
    const early = await post({ action: "fileDone", id: beginData.id }, { cookie });
    check("file: done before the upload arrives is refused", early.res.status === 400);
    const fd = new FormData();
    fd.append("cacheControl", "3600");
    fd.append("", new Blob(["solid test\nendsolid test\n"], { type: "application/octet-stream" }), "zz test.stl");
    const put = await fetch(beginData.uploadUrl, { method: "PUT", body: fd });
    check("file: the signed URL accepts the upload", put.ok, `status ${put.status}`);
    const fin = await post({ action: "fileDone", id: beginData.id }, { cookie });
    check("file: done confirms the stored size", fin.res.status === 200 && /"size":\d+/.test(fin.text), fin.text.slice(0, 100));
    const reuse = await fetch(beginData.uploadUrl, { method: "PUT", body: fd });
    check("file: the upload URL cannot overwrite the finished file", !reuse.ok, `status ${reuse.status}`);
    const rm = await post({ action: "fileRemove", id: beginData.id }, { cookie });
    check("file: remove works", rm.res.status === 200);
  }
  const out = await post({ action: "logout" }, { cookie });
  check("logout clears the cookie", /Max-Age=0/i.test(out.res.headers.get("set-cookie") || ""));
  check("session unusable right after logout", (await post({ action: "mine" }, { cookie })).res.status === 401);
}

check("no cookie is denied", (await post({ action: "mine" })).res.status === 401);
check("forged cookie is denied", (await post({ action: "mine" }, { cookie: "__Host-vp=forged" })).res.status === 401);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.name}${r.extra ? ` | ${r.extra}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed.`);
console.log("Remember: delete the throwaway account and its ZZTEST rows afterwards.");
process.exit(failed ? 1 : 0);
