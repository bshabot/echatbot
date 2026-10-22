// netlify/functions/vendor-portal.mjs
//
// The ONLY door vendors have into the PLM. The vendor page (vendor.html) calls
// this function and nothing else; it never talks to Supabase. The function
// checks origin / custom header / content type / body size, rate-limits,
// resolves the session from an HttpOnly cookie and then calls a fixed set of
// database functions with the server key. Those database functions are revoked
// from anon and from logged-in users, so the public key alone gets nothing.
//
// Fixed actions, nothing passed through:
//   login, logout, session, changePassword, info, submit, mine, update, withdraw, correction
//
// Env (Netlify only, never in the browser bundle):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional VENDOR_PORTAL_ORIGINS
//
// Plan: docs/vendor-portal-build-plan.md

import {
  ABSOLUTE_SECONDS,
  IDLE_SECONDS,
  checkPasswordPolicy,
  checkRequest,
  clientIp,
  denied,
  dummyHash,
  errorResponse,
  hashPassword,
  json,
  newSessionId,
  readCookie,
  readJson,
  rpc as realRpc,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from "../vendor-lib/shared.mjs";

const GENERIC_LOGIN_ERROR = { error: "invalid_login", message: "Invalid email or password." };

const idNum = (v) => {
  if (typeof v === "string" && !/^[1-9][0-9]{0,15}$/.test(v)) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function createHandler({ rpc = realRpc, env = process.env } = {}) {
  const call = (fn, args) => rpc(fn, args, env);

  // Returns true when the request is within the limit.
  const within = (key, max, windowSeconds) =>
    call("vendor_rate_check", { p_key: key, p_max: max, p_window_seconds: windowSeconds });

  async function login(req, body) {
    const ip = clientIp(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 300) : "";

    const okIp = await within(`login:ip:${sha256Hex(ip)}`, 20, 15 * 60);
    const okEmail = await within(`login:email:${sha256Hex(email)}`, 10, 15 * 60);
    if (!okIp || !okEmail) return json({ error: "rate_limited", message: "Too many attempts. Try again later." }, 429);

    const rows = email && password ? await call("vendor_login_lookup", { p_email: email }) : [];
    const acct = Array.isArray(rows) ? rows[0] : null;

    // One argon2 verification on every path (a dummy hash when the email is
    // unknown) so unknown email and wrong password cost the same.
    const good = await verifyPassword(password || "x", acct?.password_hash || (await dummyHash()));

    // Every failure path makes the same database call (a null account is a
    // no-op apart from an audit row) so unknown email, locked, disabled and
    // wrong password look and time alike.
    if (!acct || !acct.enabled || acct.locked || !good) {
      const countable = acct && acct.enabled && !acct.locked && !good;
      await call("vendor_login_fail", { p_account: countable ? acct.account_id : null });
      return json(GENERIC_LOGIN_ERROR, 401);
    }

    const sid = newSessionId();
    const created = await call("vendor_session_create", {
      p_account: acct.account_id,
      p_hash: sha256Hex(sid),
      p_idle_seconds: IDLE_SECONDS,
      p_abs_seconds: ABSOLUTE_SECONDS,
    });
    const mustChange = Boolean(Array.isArray(created) ? created[0]?.must_change : created?.must_change);
    return json({ ok: true, mustChange }, 200, { "set-cookie": sessionCookie(sid, ABSOLUTE_SECONDS) });
  }

  return async function handler(req) {
    const bad = checkRequest(req, env);
    if (bad) return bad;

    try {
      const parsed = await readJson(req);
      if (parsed.tooLarge) return json({ error: "too_large" }, 413);
      if (parsed.bad) return json({ error: "bad_request" }, 400);
      const body = parsed.body;
      const action = typeof body.action === "string" ? body.action : "";

      if (!(await within(`portal:ip:${sha256Hex(clientIp(req))}`, 240, 60))) {
        return json({ error: "rate_limited", message: "Too many requests. Slow down." }, 429);
      }

      if (action === "login") return await login(req, body);

      // Everything below needs a session cookie; the database resolves it.
      const sid = readCookie(req);
      if (!sid || sid.length > 100) return denied();
      const session = sha256Hex(sid);

      switch (action) {
        case "logout": {
          await call("vendor_session_end", { p_session: session });
          return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
        }
        case "changePassword": {
          const next = typeof body.newPassword === "string" ? body.newPassword : "";
          const email = typeof body.email === "string" ? body.email : "";
          const problem = checkPasswordPolicy(next, email);
          if (problem) return json({ error: "invalid", message: problem }, 400);
          await call("vendor_change_password", { p_session: session, p_new_hash: await hashPassword(next) });
          return json({ ok: true });
        }
        case "session":
          return json({ ok: true, session: await call("vendor_portal_session", { p_session: session }) });
        case "info":
          return json({ ok: true, info: await call("vendor_portal_info", { p_session: session }) });
        case "submit": {
          if (!Array.isArray(body.rows)) return json({ error: "invalid", message: "No rows." }, 400);
          const result = await call("vendor_portal_submit", { p_session: session, p_rows: body.rows });
          return json({ ok: true, result });
        }
        case "mine":
          return json({ ok: true, rows: await call("vendor_portal_my_submissions", { p_session: session }) });
        case "update": {
          const id = idNum(body.id);
          if (!id) return json({ error: "bad_request" }, 400);
          await call("vendor_portal_update", { p_session: session, p_id: id, p_data: body.data });
          return json({ ok: true });
        }
        case "withdraw": {
          const id = idNum(body.id);
          if (!id) return json({ error: "bad_request" }, 400);
          await call("vendor_portal_withdraw", { p_session: session, p_id: id });
          return json({ ok: true });
        }
        case "correction": {
          const id = idNum(body.id);
          if (!id) return json({ error: "bad_request" }, 400);
          await call("vendor_portal_correction", { p_session: session, p_id: id, p_note: String(body.note ?? "") });
          return json({ ok: true });
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
