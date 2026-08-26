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

const PROXY_BASE = "/api/ssp";

// ── Image staging cache ─────────────────────────────────────────────────
// Staging one image is 5 real network round-trips (QA presigned-url, S3
// PUT, quality-analysis, SSP presigned-url, S3 PUT) — expensive to redo
// on every retry of a LATER step (header/save, item create...) that has
// nothing to do with the photos, e.g. while iterating on a payload bug.
// Cache the finished result per (sourceUrl, filename) in localStorage so
// a retry in the same browser reuses it instead of re-staging. Bump
// IMAGE_CACHE_VERSION any time the images[] entry shape changes (see the
// 2026-08-26 qaStatus/QADetailedResponse/imageUrl fix) so a stale,
// wrong-shaped cached entry from before that fix can never come back.
const IMAGE_CACHE_VERSION = 3;
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
    userName: String(ssp.userName || "Brian@echabot.com").trim(),
    defaults: ssp.defaults || {},
  };
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

/** Step 4 — create the item on the product. Returns data.itemId. */
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

/** Step 5 — add a material row (metal + optional nested plating block). */
export async function sspAddMaterial(settings, sspCode, itemId, materialFields) {
  const { userName } = getSspConfig(settings);
  const body = {
    sspNumber: sspCode,
    skuNumber: 0,
    itemId,
    userName,
    userType: "INTERNAL",
    ...materialFields,
  };
  return sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/${sspCode}/item/${itemId}/material${q(userName)}`,
    body
  );
}

/** Step 6b — add a stone row (materials'/findings' sibling). */
export async function sspAddStone(settings, sspCode, itemId, stoneFields) {
  const { userName } = getSspConfig(settings);
  const body = {
    sspNumber: sspCode,
    skuNumber: null,
    itemId,
    userName,
    userType: "EXTERNAL", // matches the recorded add-stone traffic
    ...stoneFields,
  };
  return sspRequest(
    settings,
    "POST",
    `/v1/ssp/product/${sspCode}/item/${itemId}/stone/add-stone`,
    body
  );
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
