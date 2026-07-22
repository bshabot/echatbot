// src/utils/qbClient.js
//
// Client for the Echabot QB API — the FastAPI bridge to QuickBooks Desktop
// (see the qb-connector project: main.py / qb_connector.py). Endpoints used
// here: GET /health, GET /items/{full_name}, POST /items.
//
// ── SAFETY ──────────────────────────────────────────────────────────────
// This module is INERT until the QuickBooks integration is turned ON in
// Settings (settings.options.qbIntegration.enabled === true). Every write
// path (ensureItemExists) checks that flag FIRST and no-ops when it's off,
// returning { skipped: true }. Nothing here runs against QuickBooks until the
// toggle is flipped. Read the flag from the `settings` row and pass it in —
// the module never assumes it's on. This is the "integration until approval"
// guarantee: wiring can be added now; it stays dormant until enabled.
//
// ── CONFIG (Vite env, VITE_-prefixed so it reaches the browser bundle) ────
//   VITE_QB_API_URL   base URL of the connector (default http://localhost:8055)
//   VITE_QB_API_KEY   optional; sent as X-API-Key when the server requires it
// Override at runtime (e.g. reusing this from a Node scraper) via configureQb().

function safeEnv(key) {
  try {
    return typeof process !== "undefined" && process.env
      ? process.env[key]
      : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULTS = {
  baseUrl: (safeEnv("VITE_QB_API_URL") || "http://localhost:8055").replace(/\/+$/, ""),
  apiKey: safeEnv("VITE_QB_API_KEY") || "",
  // README: set client timeouts >= 130s to outlive the connector's 120s
  // server-side wait (Web Connector poll, or first COM boot of headless QB).
  timeoutMs: 130000,
};

let config = { ...DEFAULTS };

/** Override baseUrl / apiKey / timeoutMs at runtime. Returns the new config. */
export function configureQb(overrides = {}) {
  config = { ...config, ...overrides };
  if (config.baseUrl) config.baseUrl = config.baseUrl.replace(/\/+$/, "");
  return { ...config };
}

export function getQbConfig() {
  return { ...config };
}

/**
 * The single source of truth for "is the integration live?". Pass the
 * `settings` row (from the store or Supabase). Defaults to OFF for any
 * missing/odd shape — fail safe.
 */
export function isQbEnabled(settings) {
  return Boolean(settings?.options?.qbIntegration?.enabled);
}

export class QbError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = "QbError";
    this.status = status;
    this.detail = detail;
  }
}

async function qbFetch(path, { method = "GET", body, signal } = {}) {
  const url = config.baseUrl + path;
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;

  // Own timeout unless the caller supplies its own abort signal.
  const controller = signal ? null : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), config.timeoutMs)
    : null;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal || controller.signal,
    });
  } catch (e) {
    throw new QbError(
      e.name === "AbortError"
        ? `QB API timed out after ${config.timeoutMs}ms (${method} ${path})`
        : `QB API unreachable at ${config.baseUrl} (${e.message})`,
      { detail: e.message }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.detail : data;
    throw new QbError(
      `QB API ${res.status} on ${method} ${path}: ` +
        (typeof detail === "string" ? detail : JSON.stringify(detail)),
      { status: res.status, detail }
    );
  }
  return data;
}

/** GET /health — quick liveness/transport probe (never touches QB data). */
export function qbHealth() {
  return qbFetch("/health");
}

/** GET /items/{full_name} — returns the item, or null on 404 (not found). */
export async function findItem(fullName) {
  try {
    return await qbFetch(`/items/${encodeURIComponent(fullName)}`);
  } catch (e) {
    if (e instanceof QbError && e.status === 404) return null;
    throw e;
  }
}

/**
 * POST /items — create an item. `payload` matches the connector's ItemCreate
 * schema; only `name` is required (max 31 chars in QB). See qb-connector/main.py
 * for every field (description, price, cost, account, expense_account,
 * manufacturer_part_number, item_type).
 */
export function createItem(payload) {
  if (!payload || !payload.name) {
    throw new QbError("createItem: `name` is required");
  }
  return qbFetch("/items", { method: "POST", body: payload });
}

/**
 * Main entry point for the scrape flow: given a SKU-shaped record, make sure a
 * matching item exists in QuickBooks — create it if missing. GATED: no-ops
 * unless the integration is enabled in Settings.
 *
 *   record: { name, description?, price?, cost?, expense_account?,
 *             manufacturer_part_number?, item_type? }   // name = QB FullName
 *   opts:   { settings   (required for the gate — the settings row),
 *             dryRun }   // dryRun: check only, never create
 *
 * Returns exactly one of:
 *   { skipped: true, reason }        integration off, or dryRun-would-create
 *   { existed: true, item }          already in QB, nothing created
 *   { created: true, item }          created it just now
 */
export async function ensureItemExists(record, { settings, dryRun = false } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!record || !record.name) {
    throw new QbError("ensureItemExists: record.name (QB item FullName) is required");
  }

  const existing = await findItem(record.name);
  if (existing) return { existed: true, item: existing };

  if (dryRun) {
    return { skipped: true, reason: "dry-run", would: "create", record };
  }

  const item = await createItem(record);
  return { created: true, item };
}
