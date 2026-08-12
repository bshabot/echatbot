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
 * the new SSP number from data.sspCode. Images are NOT sent from the app —
 * they're managed separately; the payload carries an empty image list.
 */
export async function sspSaveHeader(settings, headerFields) {
  const { userName } = getSspConfig(settings);
  const body = {
    userName,
    userType: "EXTERNAL",
    sspCode: "",
    ...headerFields,
    images: [],
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

/** Read a product header back (verification / linking). */
export async function sspGetHeader(settings, sspCode) {
  return sspRequest(settings, "GET", `/v1/ssp/product/${sspCode}/header`);
}

/** Item-level dropdown vocabularies — handy when refining the mapping. */
export async function sspGetItemFilters(settings, sspCode) {
  return sspRequest(settings, "GET", `/v1/ssp/product/${sspCode}/item/get-filters`);
}
