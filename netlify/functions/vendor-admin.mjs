// netlify/functions/vendor-admin.mjs
//
// Staff-only vendor account management. Hashing happens here (argon2id) so a
// password never reaches the database in plain text, and no role can read one
// back. The caller must be a logged-in PLM user: their Supabase access token is
// verified against Supabase Auth on every call.
//
// Actions: createAccount, resetPassword, setEnabled, revokeSessions
// createAccount / resetPassword return a temporary password ONCE; the vendor
// is forced to choose their own at first login.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional VENDOR_PORTAL_ORIGINS
// Plan: docs/vendor-portal-build-plan.md

import {
  checkRequest,
  denied,
  errorResponse,
  hashPassword,
  json,
  makeTempPassword,
  readJson,
  rpc as realRpc,
  realStorage,
  supabaseConfig,
} from "../vendor-lib/shared.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// Every PLM login is staff today (the whole app is staff-only), so a valid
// Supabase session is the bar. Verified server-side, not trusted from the page.
async function verifyStaff(req, env, fetchImpl = fetch) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length > 4000) return null;
  const { url, key } = supabaseConfig(env);
  if (!url || !key) return null;
  const res = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user?.id ? user : null;
}

export function createHandler({ rpc = realRpc, env = process.env, fetchImpl = fetch, storage = realStorage } = {}) {
  const call = (fn, args) => rpc(fn, args, env);

  return async function handler(req) {
    const bad = checkRequest(req, env);
    if (bad) return bad;

    try {
      const staff = await verifyStaff(req, env, fetchImpl);
      if (!staff) return denied();

      const parsed = await readJson(req);
      if (parsed.tooLarge) return json({ error: "too_large" }, 413);
      if (parsed.bad) return json({ error: "bad_request" }, 400);
      const { action, vendorId, email, accountId, enabled, fileId, date } = parsed.body;

      switch (action) {
        case "createAccount": {
          const vid = Number(vendorId);
          const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
          if (!Number.isSafeInteger(vid) || vid <= 0 || !EMAIL.test(mail)) {
            return json({ error: "invalid", message: "Pick a vendor and enter a valid email." }, 400);
          }
          const temp = makeTempPassword();
          const id = await call("vendor_admin_create_account", { p_vendor: vid, p_email: mail, p_hash: await hashPassword(temp) });
          return json({ ok: true, accountId: id, email: mail, tempPassword: temp });
        }
        case "resetPassword": {
          if (!UUID.test(String(accountId))) return json({ error: "bad_request" }, 400);
          const temp = makeTempPassword();
          await call("vendor_admin_reset_password", { p_account: accountId, p_hash: await hashPassword(temp) });
          return json({ ok: true, tempPassword: temp });
        }
        case "setEnabled": {
          if (!UUID.test(String(accountId)) || typeof enabled !== "boolean") return json({ error: "bad_request" }, 400);
          await call("vendor_admin_set_enabled", { p_account: accountId, p_enabled: enabled });
          return json({ ok: true });
        }
        case "revokeSessions": {
          if (!UUID.test(String(accountId))) return json({ error: "bad_request" }, 400);
          await call("vendor_admin_revoke_sessions", { p_account: accountId });
          return json({ ok: true });
        }
        case "fileUrl": {
          // Short-lived download link for a vendor's uploaded file. Staff login already verified above.
          if (!UUID.test(String(fileId))) return json({ error: "bad_request" }, 400);
          const path = await call("vendor_admin_file_path", { p_file: fileId });
          if (typeof path !== "string" || !path) return json({ error: "not_found" }, 404);
          const url = await storage.downloadUrl(path, path.split("/").pop(), env);
          return json({ ok: true, url });
        }
        case "fxRate": {
          // RMB per 1 USD on a given day (the day the vendor entered the cost). Weekends and holidays
          // get the last published rate. Source: European Central Bank daily reference rates.
          const day = typeof date === "string" ? date : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < "2000-01-01") return json({ error: "bad_request" }, 400);
          const res = await fetchImpl(`https://api.frankfurter.dev/v1/${day}?base=USD&symbols=CNY`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return json({ error: "rate_unavailable", message: "Could not look up the exchange rate." }, 502);
          const body = await res.json().catch(() => ({}));
          const rate = Number(body?.rates?.CNY);
          if (!Number.isFinite(rate) || rate < 1 || rate > 20) return json({ error: "rate_unavailable", message: "Could not look up the exchange rate." }, 502);
          return json({ ok: true, rate, rateDate: typeof body.date === "string" ? body.date : day });
        }
        default:
          return json({ error: "bad_request" }, 400);
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export default createHandler();
