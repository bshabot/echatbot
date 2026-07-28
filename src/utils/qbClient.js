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

/**
 * PATCH /items/{full_name} — update fields on an existing item. `payload`
 * matches the connector's ItemUpdate schema (description, price, cost,
 * is_active, manufacturer_part_number — send only what changes).
 */
export function updateItem(fullName, payload) {
  if (!fullName) {
    throw new QbError("updateItem: fullName is required");
  }
  return qbFetch(`/items/${encodeURIComponent(fullName)}`, {
    method: "PATCH",
    body: payload,
  });
}

/**
 * Push changes onto an item that's already in QuickBooks — never creates
 * one (use ensureItemExists for that). GATED: no-ops unless the integration
 * is enabled in Settings.
 *
 * Returns exactly one of:
 *   { skipped: true, reason }        integration off
 *   { notFound: true }               no item with this FullName in QB yet
 *   { updated: true, item }          PATCHed successfully
 */
export async function ensureItemUpdated(fullName, payload, { settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!fullName) {
    throw new QbError("ensureItemUpdated: fullName is required");
  }

  const existing = await findItem(fullName);
  if (!existing) return { notFound: true };

  const item = await updateItem(fullName, payload);
  return { updated: true, item };
}

/**
 * Create-or-update in one call: creates the item if it's missing, or pushes
 * the given fields onto it if it already exists — for single-record buttons
 * (e.g. a sample's detail modal) where the caller shouldn't have to know
 * which state the item is already in. `record` uses the ItemCreate shape;
 * on the update path only the fields ItemUpdate actually accepts are sent.
 * GATED.
 *
 * Returns exactly one of:
 *   { skipped: true, reason }        integration off
 *   { created: true, item }          didn't exist — created it just now
 *   { updated: true, item }          already existed — PATCHed it
 */
export async function ensureItemSynced(record, { settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!record || !record.name) {
    throw new QbError("ensureItemSynced: record.name (QB item FullName) is required");
  }

  const existing = await findItem(record.name);
  if (existing) {
    const updatePayload = {
      description: record.description,
      price: record.price,
      cost: record.cost,
      manufacturer_part_number: record.manufacturer_part_number,
    };
    const item = await updateItem(record.name, updatePayload);
    return { updated: true, item };
  }

  const item = await createItem(record);
  return { created: true, item };
}

// ── Sales Orders ────────────────────────────────────────────────────────────
// Signet's POs *to us* are entered in QuickBooks as SALES ORDERS under the
// Zales customer. These mirror the item helpers above but hit /sales-orders.

/**
 * QB customer FullName that Signet/Zales sales orders post to. Matches the
 * connector's `all-so-zales` view (qb-connector/report_views.json). If QB's
 * customer name ever changes, change it here (and in that view).
 */
export const QB_SALES_ORDER_CUSTOMER = "Zales Corporation   -ZALES";

/** Connector saved view that carries per-SO memos (Num + Memo + dates). */
export const QB_MEMOS_VIEW = "all-so-zales";

/** GET /sales-orders/{ref_number} — the SO, or null on 404 (not found). */
export async function findSalesOrder(refNumber) {
  try {
    return await qbFetch(`/sales-orders/${encodeURIComponent(refNumber)}`);
  } catch (e) {
    if (e instanceof QbError && e.status === 404) return null;
    throw e;
  }
}

/**
 * POST /sales-orders — create an SO. `payload` matches the connector's
 * SalesOrderCreate schema: `customer` required; `ref_number` optional (omit to
 * let QB auto-number); optional po_number / txn_date / due_date / ship_date /
 * memo and a `lines` array of { item, quantity, rate, description, other1 }.
 */
export function createSalesOrder(payload) {
  if (!payload || !payload.customer) {
    throw new QbError("createSalesOrder: `customer` is required");
  }
  return qbFetch("/sales-orders", { method: "POST", body: payload });
}

/**
 * Create a QB Sales Order for a Signet PO — but only if it doesn't already
 * exist. GATED: no-ops unless the integration is enabled in Settings.
 * "Error out if it exists" is surfaced as { existed:true } so a batch caller
 * can skip-and-report that PO instead of aborting the whole run.
 *
 * `payload.ref_number` (the SO number = the Signet PO number) is required so
 * the existence check (GET /sales-orders/{ref}) is a clean "already there?".
 *
 * Returns exactly one of:
 *   { skipped: true, reason }        integration off
 *   { existed: true, item }          SO already in QB (treated as a per-row error)
 *   { created: true, item }          created it just now
 */
export async function ensureSalesOrderCreated(payload, { settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!payload || !payload.ref_number) {
    throw new QbError(
      "ensureSalesOrderCreated: payload.ref_number (SO number) is required for the existence check"
    );
  }

  const existing = await findSalesOrder(payload.ref_number);
  if (existing) return { existed: true, item: existing };

  const item = await createSalesOrder(payload);
  return { created: true, item };
}

/**
 * PATCH /sales-orders/{ref_number} — update header fields, existing lines
 * (by txn_line_id), and/or append new lines in one call. `payload` matches
 * the connector's SalesOrderUpdate schema — send only what changes; any
 * line not mentioned is left untouched. See qb-connector/main.py for the
 * full field list (txn_date, ref_number, po_number, due_date, ship_date,
 * is_manually_closed, memo, class_name, template, ship_method,
 * to_be_printed, other, lines[] { txn_line_id, ... }, add_lines[]).
 */
export function updateSalesOrder(refNumber, payload) {
  if (!refNumber) {
    throw new QbError("updateSalesOrder: refNumber (SO number) is required");
  }
  return qbFetch(`/sales-orders/${encodeURIComponent(refNumber)}`, {
    method: "PATCH",
    body: payload,
  });
}

/**
 * Push changes onto a Sales Order that's already in QuickBooks — never
 * creates one (use ensureSalesOrderCreated for that). GATED: no-ops unless
 * the integration is enabled in Settings.
 *
 * Returns exactly one of:
 *   { skipped: true, reason }        integration off
 *   { notFound: true }               no SO with this ref_number in QB yet
 *   { updated: true, item }          PATCHed successfully
 */
export async function ensureSalesOrderUpdated(refNumber, payload, { settings } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!refNumber) {
    throw new QbError("ensureSalesOrderUpdated: refNumber (SO number) is required");
  }

  const existing = await findSalesOrder(refNumber);
  if (!existing) return { notFound: true };

  const item = await updateSalesOrder(refNumber, payload);
  return { updated: true, item };
}

// ── Memos report ────────────────────────────────────────────────────────────
/**
 * GET /views/{name} — run a saved report view and return its rows. GATED.
 * The default `all-so-zales` view returns rows keyed by report label:
 * { "Num", "Memo", "Ship Date", "Due Date", "Amount", ... }.
 *
 * Returns { rows } (or { skipped:true, reason, rows:[] } when the toggle is off).
 */
export async function fetchMemosReport({ settings, view = QB_MEMOS_VIEW } = {}) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off", rows: [] };
  }
  const rows = await qbFetch(`/views/${encodeURIComponent(view)}`);
  return { rows: Array.isArray(rows) ? rows : [] };
}
