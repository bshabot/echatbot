// Shared helpers for the vendor-portal and vendor-admin Netlify functions.
// Plan: docs/vendor-portal-build-plan.md
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY lives only in Netlify environment
// variables. It is never read by the browser bundle and never logged.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

export const COOKIE_NAME = "__Host-vp";
export const IDLE_SECONDS = 30 * 60;
export const ABSOLUTE_SECONDS = 12 * 60 * 60;
export const MAX_BODY_BYTES = 256 * 1024;

const SECURITY_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  // No CORS headers on purpose: the vendor page and these functions share an origin.
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export const denied = () => json({ error: "denied" }, 401);

// ---------------------------------------------------------------- crypto

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

export function newSessionId() {
  return randomBytes(32).toString("base64url");
}

// argon2id, per-hash random salt, encoded string "$argon2id$v=19$m=...".
export async function hashPassword(password) {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456, // KiB
    hashLength: 32,
    outputType: "encoded",
  });
}

// A real argon2id hash (same parameters as hashPassword) of a throwaway
// random password. Verified against when the email is unknown, so an unknown
// email costs the same as a wrong password and no hashing happens on that path.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$kiS3RVbXCQTpa4cHhGMEpg$RuaI4h6TO4txLZSDD1Kgids8dBdq4G+HDFSKbNVl/oc";
export const dummyHash = async () => DUMMY_HASH;

export async function verifyPassword(password, encoded) {
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

// Temporary password shown to staff once. Unambiguous characters, 16 long.
export function makeTempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------- passwords policy

const COMMON = new Set(
  `password password1 password12 password123 password1234 passw0rd12345 123456789012 1234567890123
   qwertyuiopas qwertyuiop12 qwerty123456 iloveyou1234 letmein12345 welcome12345 admin1234567
   administrator abcdefghijkl abcd12345678 111111111111 000000000000 echabot12345 echabot123456
   ear-party1234 earparty1234 changeme1234 changemenow1`.split(/\s+/)
);

// At least 12 characters, not a common password, not the email. No composition rules.
export function checkPasswordPolicy(password, email = "") {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Password is too long.";
  const low = password.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(password)) return "That password is too common.";
  const name = email.split("@")[0].toLowerCase();
  if (email && (low === email.toLowerCase() || (name.length >= 5 && low.includes(name)))) {
    return "Password cannot contain your email name.";
  }
  return null;
}

// ---------------------------------------------------------------- database (server key)

export function supabaseConfig(env = process.env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key };
}

export class RpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcError";
  }
}

// Calls a public.* database function with the server key. Error text from the
// database is kept only so callers can look for our own vp_denied / vp_invalid
// prefixes; it is never forwarded to the client verbatim.
export async function rpc(fn, args = {}, env = process.env) {
  const { url, key } = supabaseConfig(env);
  if (!url || !key) throw new RpcError("server_not_configured");
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new RpcError(String(data?.message || "rpc_failed"));
  return data;
}

// ---------------------------------------------------------------- private file storage (server key)
// The vendor-uploads bucket is private and has no storage policy, so only this
// code (holding the server key) can mint upload / download URLs.

export const FILE_BUCKET = "vendor-uploads";
const encPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");

async function storageCall(method, path, body, env) {
  const { url, key } = supabaseConfig(env);
  if (!url || !key) throw new RpcError("server_not_configured");
  const res = await fetch(`${url}/storage/v1${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, base: url };
}

const absolute = (base, rel) => (/^https?:\/\//i.test(rel) ? rel : `${base}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`);

export const realStorage = {
  // One-time URL the browser PUTs the file to. Expires on its own (about 2 hours).
  async uploadUrl(path, env = process.env) {
    const r = await storageCall("POST", `/object/upload/sign/${FILE_BUCKET}/${encPath(path)}`, {}, env);
    const rel = r.data?.url;
    if (!r.ok || typeof rel !== "string") throw new RpcError("storage_failed");
    return absolute(r.base, rel);
  },
  // Real size of the stored object, or null when it is not there.
  async objectSize(path, env = process.env) {
    const r = await storageCall("GET", `/object/info/${FILE_BUCKET}/${encPath(path)}`, null, env);
    if (!r.ok) return null;
    const n = Number(r.data?.size ?? r.data?.metadata?.size);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  async remove(paths, env = process.env) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return;
    await storageCall("DELETE", `/object/${FILE_BUCKET}`, { prefixes: list }, env).catch(() => {});
  },
  // Short-lived download link for staff.
  async downloadUrl(path, filename, env = process.env) {
    const r = await storageCall("POST", `/object/sign/${FILE_BUCKET}/${encPath(path)}`, { expiresIn: 120 }, env);
    const rel = r.data?.signedURL || r.data?.signedUrl;
    if (!r.ok || typeof rel !== "string") throw new RpcError("storage_failed");
    const u = absolute(r.base, rel);
    return filename ? `${u}${u.includes("?") ? "&" : "?"}download=${encodeURIComponent(filename)}` : u;
  },
};

// Maps an RpcError to a client-safe response. Only our own, deliberately
// written messages pass through; everything else is a generic failure.
export function errorResponse(err) {
  const msg = String(err?.message || "");
  if (msg === "vp_denied") return denied();
  if (msg.startsWith("vp_invalid:")) return json({ error: "invalid", message: msg.slice("vp_invalid:".length).trim() }, 400);
  if (/duplicate key|already exists/i.test(msg)) return json({ error: "exists" }, 409);
  return json({ error: "server_error" }, 500);
}

// ---------------------------------------------------------------- request checks

export function clientIp(req) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

export function allowedOrigins(req, env = process.env) {
  const list = (env.VENDOR_PORTAL_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    list.push(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  return list;
}

// CSRF defence on top of SameSite=Strict: JSON content type, a custom header,
// and an Origin that matches this site. Returns null when fine, or a Response.
export function checkRequest(req, env = process.env) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) return json({ error: "bad_request" }, 415);
  if (req.headers.get("x-vendor-portal") !== "1") return json({ error: "denied" }, 403);
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins(req, env).includes(origin)) return json({ error: "denied" }, 403);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  return null;
}

export async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { tooLarge: true };
  try {
    const body = JSON.parse(text || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { bad: true };
  } catch {
    return { bad: true };
  }
}

export function readCookie(req, name = COOKIE_NAME) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export function sessionCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export const constantTimeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
