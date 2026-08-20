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

/** Per-machine override, so one person can point at localhost while everyone
 * else uses the LAN address on the shared settings row. */
const QB_URL_LS_KEY = "qbApiUrlOverride";

export function getQbApiUrlOverride() {
  try {
    return localStorage.getItem(QB_URL_LS_KEY) || "";
  } catch {
    return "";
  }
}

export function setQbApiUrlOverride(url) {
  try {
    const v = String(url || "").trim();
    if (v) localStorage.setItem(QB_URL_LS_KEY, v);
    else localStorage.removeItem(QB_URL_LS_KEY);
  } catch {
    /* private mode — fall through to the shared setting */
  }
}

/**
 * Where the connector lives, in priority order:
 *   1. this machine's override (localStorage)
 *   2. the shared settings row — options.qbIntegration.apiUrl
 *   3. VITE_QB_API_URL, baked in at build time
 *   4. http://localhost:8055
 *
 * (3) is why this exists: a Netlify build hands every user the same baked-in
 * URL, so "localhost" only ever worked for the one machine running the
 * connector. The settings row makes it changeable at runtime.
 */
export function qbApiUrlFromSettings(settings) {
  const url =
    getQbApiUrlOverride() ||
    settings?.options?.qbIntegration?.apiUrl ||
    safeEnv("VITE_QB_API_URL") ||
    "http://localhost:8055";
  return String(url).trim().replace(/\/+$/, "");
}

/** Point the client at whatever the settings row says. Safe to call often. */
export function applyQbSettings(settings) {
  return configureQb({
    baseUrl: qbApiUrlFromSettings(settings),
    apiKey:
      settings?.options?.qbIntegration?.apiKey || safeEnv("VITE_QB_API_KEY") || "",
  });
}

/**
 * Sanity-check a URL before it's saved. Catches the two that actually happen:
 * a bare host with no scheme, and http:// from an https:// page — which the
 * browser blocks as mixed content and reports only as "Failed to fetch".
 */
export function checkQbApiUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { ok: true, warning: "" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, warning: 'Not a valid URL — it needs the scheme, e.g. "http://192.168.1.50:8055"' };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, warning: "Use http:// or https://" };
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const pageIsHttps =
    typeof window !== "undefined" && window.location?.protocol === "https:";
  if (pageIsHttps && u.protocol === "http:" && !isLocal) {
    return {
      ok: true,
      warning:
        "This page is served over HTTPS, so the browser will block plain http:// to " +
        u.hostname +
        ' as mixed content — requests fail with "Failed to fetch". Either open the PLM over http://, ' +
        "put a certificate on the connector, or allow insecure content for this site in Chrome " +
        "(padlock -> Site settings -> Insecure content -> Allow).",
    };
  }
  return { ok: true, warning: "" };
}

/**
 * Format a number as a 2-decimal currency string for any QB Rate/Price/Cost
 * field. QuickBooks rejects a Rate/Price with too many decimal places —
 * "QB error 3045: There was an error when converting the price ... in the
 * field Rate" — which is exactly what a raw JS float like
 * 13.344911793183279 (e.g. straight out of the rebill calculator's metal-
 * lock math, never rounded before this point) produces once it's stringified
 * and dropped into the qbXML. Every Rate/Price/Cost sent to the connector
 * should go through this instead of a bare String(x).
 *
 * Returns undefined for null/empty/non-finite input (so callers' existing
 * "omit the field if there's nothing to send" pattern keeps working).
 */
export function toQbAmount(n) {
  if (n == null || n === "") return undefined;
  const num = typeof n === "number" ? n : parseFloat(n);
  if (!Number.isFinite(num)) return undefined;
  return num.toFixed(2);
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
  /**
   * `kind` classifies the failure so callers can act on it (A4):
   *   "timeout"     — we gave up waiting. The write MAY STILL HAVE BEEN
   *                   APPLIED in QuickBooks (verified: PO 170942, 8/10).
   *                   Never record this as `failed` without re-checking.
   *   "unreachable" — no connection at all (connector down, mixed content).
   *   "http"        — the connector answered with an error status.
   */
  constructor(message, { status, detail, kind } = {}) {
    super(message);
    this.name = "QbError";
    this.status = status;
    this.detail = detail;
    this.kind = kind || (status ? "http" : undefined);
  }
}

/** True when this error means "we don't know whether QB applied it". */
export function isUnknownOutcome(e) {
  return Boolean(
    e instanceof QbError && (e.kind === "timeout" || e.status === 504)
  );
}

/**
 * C4 — single-flight for identical GETs. The batch worker and a detail modal
 * routinely ask for the same /sales-orders/{ref} within milliseconds; each
 * one costs a full Web Connector round trip. Concurrent callers of the same
 * GET share one in-flight request.
 */
const _inFlightGets = new Map();

async function qbFetch(path, { method = "GET", body, signal, headers: extraHeaders } = {}) {
  if (method === "GET" && !signal) {
    const existing = _inFlightGets.get(path);
    if (existing) return existing;
    const p = _qbFetchRaw(path, { method, body, signal, headers: extraHeaders })
      .finally(() => {
        _inFlightGets.delete(path);
      });
    _inFlightGets.set(path, p);
    return p;
  }
  return _qbFetchRaw(path, { method, body, signal, headers: extraHeaders });
}

async function _qbFetchRaw(path, { method = "GET", body, signal, headers: extraHeaders } = {}) {
  const url = config.baseUrl + path;
  const headers = { Accept: "application/json", ...(extraHeaders || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;

  // C8 — a caller-supplied signal used to REPLACE the timeout, so any request
  // with a cancel signal could hang forever. Both now apply.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let combined = controller.signal;
  if (signal) {
    combined =
      typeof AbortSignal !== "undefined" && AbortSignal.any
        ? AbortSignal.any([signal, controller.signal])
        : signal; // very old browsers: caller's signal wins, as before
  }

  let res;
  let timedOut = false;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });
  } catch (e) {
    timedOut = e.name === "AbortError" && controller.signal.aborted;
    throw new QbError(
      e.name === "AbortError"
        ? timedOut
          ? `QB API timed out after ${config.timeoutMs}ms (${method} ${path})`
          : `QB API request cancelled (${method} ${path})`
        : `QB API unreachable at ${config.baseUrl} (${e.message})`,
      {
        detail: e.message,
        kind: timedOut
          ? "timeout"
          : e.name === "AbortError"
            ? "cancelled"
            : "unreachable",
      }
    );
  } finally {
    clearTimeout(timer);
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

/**
 * How the connector reaches QuickBooks. Two modes, and which one is right
 * changes with whether QuickBooks happens to be open:
 *
 *   com  — direct COM call. Sub-second, but only works while QuickBooks is
 *          OPEN on the connector machine (the company file lives on a share,
 *          so the SDK can't start QuickBooks by itself).
 *   qbwc — Web Connector polling. 1-3s, but work simply queues when
 *          QuickBooks is closed instead of failing.
 *
 * GET /transport also reports whether each is currently usable
 * (`com_connected`, `wc_alive`), which is what the Settings panel shows.
 */
export function fetchQbTransport() {
  return qbFetch("/transport");
}

export function setQbTransport(transport) {
  return qbFetch("/transport", { method: "POST", body: { transport } });
}

/**
 * Client timeouts, matched to the transport actually in use.
 *
 * The 130s default exists for the Web Connector: the connector waits up to
 * 120s for a poll to deliver, so anything shorter would abort writes that
 * are about to succeed. On COM there is no poll — a call either reaches
 * QuickBooks in about a second or something is wrong — so waiting two
 * minutes to find that out is pure dead time on the page. Cached for a
 * minute so this costs nothing per request; the transport can be switched
 * from Settings at any time, hence the TTL rather than a one-shot read.
 */
const TIMEOUT_BY_TRANSPORT = { com: 30000, qbwc: 130000 };
const TRANSPORT_TTL_MS = 60000;
let _transportCache = { at: 0, info: null };

export async function refreshQbTransportTuning({ force = false } = {}) {
  const now = Date.now();
  if (!force && _transportCache.info && now - _transportCache.at < TRANSPORT_TTL_MS) {
    return _transportCache.info;
  }
  try {
    const info = await fetchQbTransport();
    _transportCache = { at: now, info };
    const t = TIMEOUT_BY_TRANSPORT[info?.transport];
    if (t) configureQb({ timeoutMs: t });
    return info;
  } catch {
    // Older connector without /transport, or it's unreachable — leave the
    // conservative default in place.
    return _transportCache.info;
  }
}

export function getQbTransportInfo() {
  return _transportCache.info;
}

/**
 * POST /qb/release — end the COM session so QuickBooks can be closed by
 * hand. No-op on the Web Connector transport. The next request reconnects.
 */
export function releaseQbConnection() {
  return qbFetch("/qb/release", { method: "POST", body: {} });
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

// Everything the connector's ItemUpdate schema accepts (main.py). `name` is
// deliberately excluded: on ItemUpdate it RENAMES the item, and here it's the
// lookup key rather than something to change.
//
// This list exists because the alternative — spelling the fields out inline —
// silently dropped preferred_vendor the moment it was added: the create path
// carried it, the update path didn't mention it, and the field just vanished
// on any item that already existed. A new field now only has to be added here.
const ITEM_UPDATE_FIELDS = [
  "description",
  "price",
  "cost",
  "manufacturer_part_number",
  "preferred_vendor",
  "is_active",
];

/** Pick just the ItemUpdate-valid fields out of an ItemCreate-shaped record. */
export function toItemUpdateFields(record) {
  const out = {};
  for (const f of ITEM_UPDATE_FIELDS) {
    if (record?.[f] !== undefined) out[f] = record[f];
  }
  return out;
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
    const item = await updateItem(record.name, toItemUpdateFields(record));
    return { updated: true, item };
  }

  const item = await createItem(record);
  return { created: true, item };
}

// ── Vendors ─────────────────────────────────────────────────────────────────
// An item's preferred vendor is a REFERENCE: QuickBooks matches it on exact
// name and rejects one it doesn't have — and that rejection fails the whole
// item write, not just the vendor field. The PLM's selected vendor is sent
// as-is; nothing here creates vendors in QuickBooks. findVendor is available
// to check a name before relying on it.

/** GET /vendors/{full_name} — the vendor, or null on 404 (not found). */
export async function findVendor(fullName) {
  try {
    return await qbFetch(`/vendors/${encodeURIComponent(fullName)}`);
  } catch (e) {
    if (e instanceof QbError && e.status === 404) return null;
    throw e;
  }
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

/** Connector saved view of OUR open purchase orders to the factories.
 * Num = vendor PO, Name = vendor, Memo carries "Sales Order ####" — i.e. the
 * authoritative vendor-PO -> Signet-SO link, the same data as the "All
 * Purchase orders.xlsx" export. Primary source for linking the board. */
export const QB_OPEN_PO_VIEW = "open-po";

/** Connector saved view that carries per-SO memos (Num + Memo + dates). */
export const QB_MEMOS_VIEW = "all-so-zales";

/**
 * GET /sales-orders/{ref_number} — the SO, or null when it doesn't exist.
 *
 * "Doesn't exist" comes back two ways: a clean 404, OR — because QuickBooks'
 * query-by-RefNumber THROWS instead of returning empty — a QB error 500 that
 * the connector surfaces as a 502, e.g. '...required element ("164138") that
 * could not be found in QuickBooks.'. Both mean "not there", so both return
 * null; any other error (connector down, QB busy, auth) still throws so a real
 * outage never gets mistaken for "not found".
 */
export async function findSalesOrder(refNumber) {
  try {
    return await qbFetch(`/sales-orders/${encodeURIComponent(refNumber)}`);
  } catch (e) {
    if (!(e instanceof QbError)) throw e;
    if (e.status === 404) return null;
    const text = `${e.message || ""} ${
      typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail || "")
    }`;
    if (/could not be found|not found in quickbooks/i.test(text)) return null;
    throw e;
  }
}

/**
 * GET /sales-orders — MANY sales orders, WITH their lines, in ONE call.
 *
 * This is the batch primitive the update flow needs: the per-PO
 * GET /sales-orders/{ref} pattern costs one QuickBooks round trip per PO
 * (50 POs = 50 trips), while this returns all of them at once. The lines
 * come back with their txn_line_id, which is what the diff and the PATCH
 * are keyed on — so nothing else has to change.
 *
 * Unlike the `all-so-zales` report view, this is not bounded by the view's
 * date range, which closes the "old PO looks absent, gets created twice"
 * blind spot. Returns [] rather than throwing on an empty result.
 */
export async function fetchSalesOrders({
  refs,
  customer,
  dateFrom,
  dateTo,
  limit = 1000,
} = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  // `refs` is the good path: exactly the sales orders asked for, with lines,
  // in one QuickBooks round trip. Without it this is a fetch-everything
  // query — correct, but it drags back the whole customer's order history.
  if (refs && refs.length) qs.set("refs", refs.join(","));
  if (customer) qs.set("customer", customer);
  if (dateFrom) qs.set("date_from", dateFrom);
  if (dateTo) qs.set("date_to", dateTo);
  const rows = await qbFetch(`/sales-orders?${qs.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

/**
 * POST /sales-orders — create an SO. `payload` matches the connector's
 * SalesOrderCreate schema: `customer` required; `ref_number` optional (omit to
 * let QB auto-number); optional po_number / txn_date / due_date / ship_date /
 * memo and a `lines` array of { item, quantity, rate, description, other1 }.
 */
export function createSalesOrder(payload, { idempotencyKey } = {}) {
  if (!payload || !payload.customer) {
    throw new QbError("createSalesOrder: `customer` is required");
  }
  // K3 — the connector dedupes on this key (default `so:{ref_number}`), so a
  // double-click or a client retry can never post a second SO.
  const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
  return qbFetch("/sales-orders", { method: "POST", body: payload, headers });
}

/**
 * GET /write-results/{key} — what actually happened to a write we stopped
 * waiting for. Returns null when the connector has no record (older
 * connector, or the write never reached it).
 *
 * status: done | late-done   QuickBooks applied it
 *         error | late-error QuickBooks rejected it
 *         unknown | unknown-restart | pending   still genuinely unknown
 */
export async function fetchWriteResult(key) {
  try {
    return await qbFetch(`/write-results/${encodeURIComponent(key)}`);
  } catch (e) {
    if (e instanceof QbError && (e.status === 404 || e.status === 405)) return null;
    return null;
  }
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

  const item = await createSalesOrder(payload, {
    idempotencyKey: `so:${payload.ref_number}`,
  });
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
 * Fetch OUR purchase order to a factory (e.g. 12851) with its lines, or null.
 *
 * NOTE the shape: the connector has no /purchase-orders/{ref} route — the PO
 * number is a QUERY param on the list route, and `include_lines` defaults to
 * FALSE. Without it you get the PO with an empty lines[] and every line
 * silently fails to match, which looks exactly like "nothing to update".
 */
export async function findPurchaseOrder(refNumber) {
  const qs = new URLSearchParams({
    ref_number: String(refNumber),
    include_lines: "true",
    limit: "1",
  });
  const rows = await qbFetch(`/purchase-orders?${qs.toString()}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * POST /purchase-orders — create a PO to a factory/vendor. `payload` matches
 * the connector's PurchaseOrderCreate schema: `vendor` required (must exist
 * in QB by FullName); `ref_number` optional (omit to let QB auto-number);
 * optional txn_date / due_date / expected_date / memo / template (PO
 * template FullName, e.g. "Copy of: Custom Purchase Order" — omit for QB's
 * default) and a `lines` array of
 * { item, quantity, rate, description, other1, other2 }. `quantity`/`rate`
 * must be decimal STRINGS — the connector types them `str | None` and
 * Pydantic v2 does not coerce a number.
 */
export function createPurchaseOrder(payload, { idempotencyKey } = {}) {
  if (!payload || !payload.vendor) {
    throw new QbError("createPurchaseOrder: `vendor` is required");
  }
  // K3 — the connector dedupes on this key (default `po:{ref_number}`), so a
  // double-click or a client retry can never post a second PO.
  const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
  return qbFetch("/purchase-orders", { method: "POST", body: payload, headers });
}

/**
 * PATCH /purchase-orders/{ref_number} — update existing lines by txn_line_id.
 * Send only what changes; any line not mentioned is left untouched (the
 * connector echoes every existing line back to PurchaseOrderMod, which
 * REPLACES the line list — so an omitted line is preserved, not dropped).
 * We only ever send `lines[] { txn_line_id, rate }` — never header fields,
 * never add_lines, never a delete.
 *
 * `rate` must be a STRING: the connector's OrderLineEdit types it `str | None`
 * and Pydantic v2 does not coerce a number, so a float 422s.
 */
export function updatePurchaseOrder(refNumber, payload) {
  if (!refNumber) {
    throw new QbError("updatePurchaseOrder: refNumber (vendor PO number) is required");
  }
  return qbFetch(`/purchase-orders/${encodeURIComponent(refNumber)}`, {
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
 *
 * A2 — pass `existingSo` when the caller ALREADY fetched the SO (the prepare
 * step does, for every PO, to build the diff). Without it this re-GETs the
 * same sales order, doubling every update batch's round trips for nothing.
 * With it, a PATCH that comes back "could not be found" is classified as
 * notFound instead of blowing up the row.
 */
export async function ensureSalesOrderUpdated(
  refNumber,
  payload,
  { settings, existingSo } = {}
) {
  if (!isQbEnabled(settings)) {
    return { skipped: true, reason: "qb-integration-off" };
  }
  if (!refNumber) {
    throw new QbError("ensureSalesOrderUpdated: refNumber (SO number) is required");
  }

  if (existingSo === undefined) {
    const existing = await findSalesOrder(refNumber);
    if (!existing) return { notFound: true };
  } else if (!existingSo) {
    return { notFound: true };
  }

  try {
    const item = await updateSalesOrder(refNumber, payload);
    return { updated: true, item };
  } catch (e) {
    // The SO vanished between prepare and send (deleted/renumbered in QB).
    const text = `${e?.message || ""} ${
      typeof e?.detail === "string" ? e.detail : JSON.stringify(e?.detail ?? "")
    }`;
    if (e instanceof QbError && e.status === 404) return { notFound: true };
    if (/could not be found|not found in quickbooks|sales order not found/i.test(text)) {
      return { notFound: true };
    }
    throw e;
  }
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
