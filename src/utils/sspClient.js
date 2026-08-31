// src/utils/sspClient.js
//
// Browser client for Signet's SSP / SKU Manager API, used by the Samples
// page's "Create in SSP" actions. Endpoints and payload shapes were mapped
// from a recorded HAR of a real item setup (see tools/ssp-item-creator/
// docs/API-NOTES.md — this module is the in-app twin of that CLI connector).
//
// ── SAFETY ──────────────────────────────────────────────────────────────
// INERT until the SSP integration is turned ON in Settings AND a token is
// pasted (settings.options.sspIntegration.{enabled,token}). Every caller
// checks isSspEnabled() first. Creating a product in SSP always mints a NEW
// SSP number — there is no overwrite — so new items simply appear in the
// hold queue as "Pending Vendor Submission" for review in SKU Manager.
//
// ── CORS / PROXY ────────────────────────────────────────────────────────
// The browser can't call api.skumanager.cloud.jewels.com cross-origin, so
// requests go through the same-origin Netlify function at /api/ssp/* (see
// netlify/functions/ssp-proxy.mjs), which forwards them verbatim — the
// Entra bearer token included — to the SSP API. The token itself lives only
// in the settings row and this request path; the proxy stores nothing.

import { useGenericStore } from "../store/VendorStore";

const PROXY_BASE = "/api/ssp";

// ── Image staging cache ─────────────────────────────────────────────────
// Staging one image is 5 real network round-trips (QA presigned-url, S3
// PUT, quality-analysis, SSP presigned-url, S3 PUT) — expensive to redo
// on every retry of a LATER step (header/save, item create...) that has
// nothing to do with the photos, e.g. while iterating on a payload bug.
// Cache the finished result per (sourceUrl, filename) in localStorage so
// a retry in the same browser reuses it instead of re-staging. Bump
// IMAGE_CACHE_VERSION any time the images[] entry shape changes (see the
// 2026-08-26 qaStatus/QADetailedResponse/imageUrl fix; the 2026-08-31
// real-key-from-signed-URL fix) so a stale, wrong-shaped or pointing-at-
// nothing cached entry from before either fix can never come back.
const IMAGE_CACHE_VERSION = 4;
const IMAGE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — about one workday

function imageCacheKey(sourceUrl, filename) {
  return `ssp-image-cache:v${IMAGE_CACHE_VERSION}:${filename}:${sourceUrl}`;
}

function readImageCache(sourceUrl, filename) {
  try {
    const raw = localStorage.getItem(imageCacheKey(sourceUrl, filename));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object") return null;
    if (Date.now() - (entry.stagedAt || 0) > IMAGE_CACHE_TTL_MS) return null;
    return entry.data || null;
  } catch {
    return null; // corrupt/unavailable — just re-stage
  }
}

function writeImageCache(sourceUrl, filename, data) {
  try {
    localStorage.setItem(
      imageCacheKey(sourceUrl, filename),
      JSON.stringify({ stagedAt: Date.now(), data })
    );
  } catch {
    /* localStorage full/unavailable — caching is best-effort, not required */
  }
}

/**
 * Clear every cached staged image — call this (e.g. from the browser
 * console: `import("/src/utils/sspClient.js").then(m => m.clearSspImageCache())`)
 * if a sample's actual photo changed and a stale staged copy needs to be
 * forced to re-upload instead of reusing the cache.
 */
export function clearSspImageCache() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("ssp-image-cache:"));
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

export function isSspEnabled(settings) {
  const ssp = settings?.options?.sspIntegration;
  return Boolean(ssp?.enabled && String(ssp?.token || "").trim());
}

export function getSspConfig(settings) {
  const ssp = settings?.options?.sspIntegration || {};
  return {
    token: String(ssp.token || "").trim(),
    refreshToken: String(ssp.refreshToken || "").trim(),
    tokenExpiresAt: Number(ssp.tokenExpiresAt) || 0,
    userName: String(ssp.userName || "Brian@echabot.com").trim(),
    defaults: ssp.defaults || {},
  };
}

// Refresh proactively once a token has less than this long left — cuts it
// close enough that we're not refreshing tokens that still have most of
// their ~70min life, but safe enough that a several-minute SSP create run
// won't have the token expire out from under it partway through.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Exchange the stored refresh token for a new access token, via the
 * ssp-refresh-token Netlify function (Entra ID OAuth2 v2.0 refresh grant,
 * public client — see that function's header comment for the tenant/
 * client/scope values). Does not persist anything itself — see
 * ensureFreshSspToken, which is what callers should actually use.
 */
export async function sspRefreshToken(settings) {
  const { refreshToken } = getSspConfig(settings);
  if (!refreshToken) {
    throw new Error(
      "No SSP refresh token saved in Settings yet — paste one to turn on auto-refresh."
    );
  }
  const res = await fetch("/api/ssp-refresh-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !json?.success) {
    throw new Error(json?.errorMessage || `SSP token refresh failed: HTTP ${res.status}`);
  }
  return json.data; // { accessToken, refreshToken, expiresAt }
}

/**
 * Call this before an SSP create run. If a refresh token is on file and the
 * current access token is missing an expiry or expiring soon, refreshes it
 * and persists the new token pair to the settings row (Supabase, when a
 * client is passed) and to the in-app store/localStorage cache, so Brian
 * never has to paste a fresh token by hand. Always returns a settings
 * object — callers should use the RETURNED value from here on, since it
 * may be a new object with the refreshed token.
 */
export async function ensureFreshSspToken(settings, supabase) {
  const { refreshToken, tokenExpiresAt } = getSspConfig(settings);
  if (!refreshToken) return settings; // nothing to refresh with — use the pasted token as-is

  const stillFresh = tokenExpiresAt && tokenExpiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
  if (stillFresh) return settings;

  const refreshed = await sspRefreshToken(settings);
  const updatedSsp = {
    ...(settings?.options?.sspIntegration || {}),
    token: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    tokenExpiresAt: refreshed.expiresAt,
  };
  let updatedOptions = { ...(settings?.options || {}), sspIntegration: updatedSsp };

  if (supabase) {
    try {
      // Merge onto the row's current options rather than whatever this
      // caller happened to load, so an unrelated Settings field someone
      // else saved in the meantime isn't clobbered.
      const { data: row } = await supabase
        .from("settings")
        .select("options")
        .eq("id", 1)
        .single();
      updatedOptions = { ...(row?.options || settings?.options || {}), sspIntegration: updatedSsp };
      const { error } = await supabase.from("settings").update({ options: updatedOptions }).eq("id", 1);
      if (error) throw error;
    } catch (e) {
      console.error("Failed to persist refreshed SSP token to Settings:", e);
      // Still proceed with the in-memory refreshed token for this run.
    }
  }

  const updatedSettings = { ...settings, options: updatedOptions };
  try {
    useGenericStore.getState().updateEntity("settings", updatedSettings);
  } catch {
    /* store unavailable in this call context — not fatal */
  }
  return updatedSettings;
}

async function sspRequest(settings, method, path, body) {
  const { token, userName } = getSspConfig(settings);
  const res = await fetch(`${PROXY_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Forwarded by the proxy as the Authorization bearer token.
      "x-ssp-token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "SSP rejected the token (" + res.status + ") — paste a fresh one in Settings (they expire after about an hour)."
    );
  }
  if (!res.ok) {
    throw new Error(`SSP ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (json && json.success === false) {
    throw new Error(`SSP ${method} ${path}: ${json.errorMessage || "success=false"}`);
  }
  return { json, userName };
}

const q = (userName) => `?userName=${encodeURIComponent(userName)}`;

/**
 * Step 1 — create the product header. `headerFields` must already be the
 * full payload minus user/vendor boilerplate (see sspCreate.js). Returns
 * the new SSP number from data.sspCode. Pass `images` (from
 * sspStageImagesForSample) or omit for an empty image list.
 */
export async function sspSaveHeader(settings, headerFields, images = [], existingSspCode = "") {
  const { userName } = getSspConfig(settings);
  const body = {
    userName,
    userType: "EXTERNAL",
    sspCode: existingSspCode || "",
    ...headerFields,
    images,
    pendingDeletionImages: [],
    logTimestamp: new Date().toISOString(),
  };
  const { json } = await sspRequest(settings, "POST", "/v1/ssp/product/header/save", body);
  const sspCode = json?.data?.sspCode;
  if (!sspCode) throw new Error("SSP header/save returned no sspCode");
  return { sspCode, data: json.data };
}

/** Step 2 — set the product costing method (e.g. "fixed with metal lock"). */
export async function sspSetCostingMethod(settings, sspCode, costingMethod) {
  const enc = encodeURIComponent(costingMethod);
  return sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/costing-method/update-costing-method/${sspCode}/${enc}`,
    {}
  );
}

/** Step 3 — tether toggles. All off by default for our fixed-with-lock items. */
export async function sspSetTethers(settings, sspCode, tethers = {}) {
  const { userName } = getSspConfig(settings);
  const body = {
    sspNumber: sspCode,
    isTetheredToMetalLossMatrix: !!tethers.isTetheredToMetalLossMatrix,
    isTetheredToDiamondPricingMatrix: !!tethers.isTetheredToDiamondPricingMatrix,
    isTetheredToOvercostMatrix: !!tethers.isTetheredToOvercostMatrix,
    userName,
    userType: "EXTERNAL",
  };
  return sspRequest(settings, "PUT", `/v1/ssp/product/${sspCode}/items/tether${q(userName)}`, body);
}

/**
 * Step 4 — create the item on the product. Returns data.itemId. Always
 * mints a NEW item — confirmed 2026-08-31 that passing an existing itemId
 * in the body here does NOT update it, it just creates item #2 alongside
 * it. Use sspUpdateItem (below) to edit an existing item.
 */
export async function sspCreateItem(settings, sspCode, itemFields) {
  const { userName } = getSspConfig(settings);
  const body = {
    userName,
    userType: "INTERNAL", // matches the recorded UI traffic
    sspNumber: sspCode,
    skuNumber: null,
    itemId: 0,
    ...itemFields,
  };
  const { json } = await sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/${sspCode}/item${q(userName)}`,
    body
  );
  const itemId = json?.data?.itemId;
  if (itemId == null) throw new Error("SSP item create returned no itemId");
  return { itemId, data: json.data };
}

/**
 * Update an existing item in place. CONFIRMED 2026-08-31 via a real HAR
 * (product S189443, item 1, itemDescription edited + saved in the live
 * SKU Manager UI): unlike create, this targets the item by id IN THE URL
 * (`PUT /item/{itemId}`, not POST with itemId in the body — that just
 * creates a second item, see sspCreateItem's git history) and the request
 * body is otherwise the exact same shape as create's (full item payload,
 * itemId included in the body too, matching what SKU Manager itself sends).
 */
export async function sspUpdateItem(settings, sspCode, itemId, itemFields) {
  const { userName } = getSspConfig(settings);
  const body = {
    userName,
    userType: "INTERNAL",
    sspNumber: sspCode,
    skuNumber: null,
    itemId,
    ...itemFields,
  };
  const { json } = await sspRequest(
    settings,
    "PUT",
    `/v1/ssp/product/${sspCode}/item/${itemId}${q(userName)}`,
    body
  );
  return { itemId: json?.data?.itemId ?? itemId, data: json?.data };
}

/** Step 5 — add a material row (metal + optional nested plating block). */
// `existingMaterialId`: pass the id from a previous add's response to
// update that row in place instead of appending a new one -- same
// create-vs-update-by-id convention confirmed for header/save (sspCode).
// Item turned out NOT to follow this pattern (see sspCreateItem /
// sspUpdateItem) — it needed a separate PUT .../item/{id} call instead.
// Material's real update shape is still unconfirmed, so the caller
// should watch the returned id for a mismatch the same way item does.
export async function sspAddMaterial(settings, sspCode, itemId, materialFields, existingMaterialId = 0) {
  const { userName } = getSspConfig(settings);
  const body = {
    sspNumber: sspCode,
    skuNumber: 0,
    itemId,
    materialId: existingMaterialId || 0,
    userName,
    userType: "INTERNAL",
    ...materialFields,
  };
  const { json } = await sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/${sspCode}/item/${itemId}/material${q(userName)}`,
    body
  );
  const materialId = json?.data?.materialId ?? null;
  return { materialId, data: json?.data };
}

// `existingStoneId`: same update-by-id convention as sspAddMaterial above,
// applied to the one endpoint that literally has "add" in its own name —
// so this is the least-confirmed of the three. Watch the returned stoneId
// closely; if it always differs from what was sent, this endpoint may be
// create-only and stones will need a different fix (e.g. a captured HAR of
// SKU Manager's own "edit stone" action).
export async function sspAddStone(settings, sspCode, itemId, stoneFields, existingStoneId = 0) {
  const { userName } = getSspConfig(settings);
  const body = {
    sspNumber: sspCode,
    skuNumber: null,
    itemId,
    stoneId: existingStoneId || 0,
    userName,
    userType: "EXTERNAL", // matches the recorded add-stone traffic
    ...stoneFields,
  };
  const { json } = await sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/${sspCode}/item/${itemId}/stone/add-stone`,
    body
  );
  const stoneId = json?.data?.stoneId ?? null;
  return { stoneId, data: json?.data };
}

/**
 * Stage one image (fetch from its R2/http(s) URL, run it through the AI
 * QA scorer, land it in SSP's own bucket) via the ssp-image-proxy
 * Netlify function — this whole pipeline touches hosts the browser can't
 * reach cross-origin, so it runs server-side. Returns the header-ready
 * `images[]` entry: {imageUrl, isPrimary, qaStatus, QADetailedResponse}.
 */
export async function sspStageImage(settings, { sspCode, sourceUrl, filename, isPrimary = false }) {
  const cached = readImageCache(sourceUrl, filename);
  if (cached) return cached;

  const { token } = getSspConfig(settings);
  const res = await fetch("/api/ssp-image", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ssp-token": token },
    body: JSON.stringify({ sspCode, sourceUrl, filename, isPrimary }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || json?.success === false) {
    throw new Error(`Image staging failed for ${filename}: ${json?.errorMessage || text.slice(0, 300)}`);
  }
  writeImageCache(sourceUrl, filename, json.data);
  return json.data;
}

/**
 * Stage every image for one sample. `sourceUrls` are full https URLs
 * (e.g. `${VITE_DB_HOST_URL}${sample.images[i]}`). Fewer than 2 sources
 * sends the same one twice under a different filename — SSP wants >=2.
 */
export async function sspStageImagesForSample(settings, { sspCode, sourceUrls, baseFilename }) {
  const urls = (sourceUrls || []).filter(Boolean);
  if (!urls.length) return [];
  const effective = urls.length >= 2 ? urls : [urls[0], urls[0]];
  const out = [];
  for (let i = 0; i < effective.length; i++) {
    const filename = i === 0 ? `${baseFilename}.jpg` : `${baseFilename}-${i + 1}.jpg`;
    out.push(
      await sspStageImage(settings, {
        sspCode,
        sourceUrl: effective[i],
        filename,
        isPrimary: i === 0,
      })
    );
  }
  return out;
}

/** Read a product header back (verification / linking). */
export async function sspGetHeader(settings, sspCode) {
  return sspRequest(settings, "GET", `/v1/ssp/product/${sspCode}/header`);
}

/** Item-level dropdown vocabularies — handy when refining the mapping. */
export async function sspGetItemFilters(settings, sspCode) {
  return sspRequest(settings, "GET", `/v1/ssp/product/${sspCode}/item/get-filters`);
}
