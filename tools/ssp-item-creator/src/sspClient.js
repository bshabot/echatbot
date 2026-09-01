/**
 * SSP / SKU Manager API connector.
 *
 * Thin wrapper over api.skumanager.cloud.jewels.com — one function per
 * endpoint, endpoints and payload shapes taken verbatim from a recorded
 * HAR of a real item setup (2026-08-04, product S180933).
 *
 * Auth: short-lived Microsoft Entra bearer token, pasted into auth.json
 * (same convention as the ssp-scraper). No image handling here — images
 * are managed separately.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

export function loadToken() {
  const authPath = path.join(ROOT, 'auth.json');
  if (!fs.existsSync(authPath)) {
    throw new Error(
      'auth.json not found. Copy auth.json.example to auth.json and paste a fresh SSP token.'
    );
  }
  const { token } = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (!token || token === 'PASTE_TOKEN_HERE') {
    throw new Error('auth.json has no token. Paste a fresh SSP token (they expire quickly).');
  }
  return token;
}

export class SspClient {
  constructor({ config = loadConfig(), token = null, dryRun = false, logger = console } = {}) {
    this.config = config;
    this.token = token;
    this.dryRun = dryRun;
    this.log = logger;
  }

  headers() {
    // Beyond content-type/accept/auth, the captured HAR shows every SSP
    // call carrying the full browser header set below (origin, referer,
    // UA, sec-fetch-*, sec-ch-ua). Some AWS-fronted endpoint in this same
    // family (the image QA tool) rejected a plain server call with
    // {"message":"Unauthorized"} until these were added, so they're sent
    // on every request here too rather than risk the same gate elsewhere.
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      origin: 'https://skumanager.cloud.jewels.com',
      referer: 'https://skumanager.cloud.jewels.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    };
    if (this.token) {
      const scheme = this.config.authScheme ? `${this.config.authScheme} ` : '';
      h[this.config.authHeader || 'Authorization'] = `${scheme}${this.token}`;
    }
    return h;
  }

  async request(method, apiPath, body = undefined, { label = '' } = {}) {
    const url = `${this.config.apiBase}${apiPath}`;
    if (this.dryRun && method !== 'GET') {
      this.log.info(`[dry-run] ${method} ${apiPath}${label ? `  (${label})` : ''}`);
      if (body !== undefined) this.log.info(JSON.stringify(body, null, 2));
      return { __dryRun: true, success: true, data: null };
    }
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Auth rejected (${res.status}) on ${method} ${apiPath} — token expired? Paste a fresh one into auth.json.`);
    }
    if (!res.ok) {
      throw new Error(`${method} ${apiPath} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (json && json.success === false) {
      throw new Error(`${method} ${apiPath} -> success=false: ${json.errorMessage || text.slice(0, 400)}`);
    }
    return json ?? text;
  }

  q(userName) {
    return `?userName=${encodeURIComponent(userName || this.config.userName)}`;
  }

  // ---- vocabularies / lookups -------------------------------------------

  /** Header-level dropdown values (buyers, countries, polybag sizes, ...). */
  getHeaderFilters() {
    return this.request('POST', '/v1/ssp/product/header/get-filters', { userType: 'EXTERNAL' });
  }

  /** Item-level dropdown values (product types, categories, sizes, ...). */
  getItemFilters(sspCode) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/get-filters`);
  }

  getMaterialFilters(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}/material/get-filters`);
  }

  getFindingFilters(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}/finding/get-filters`);
  }

  getHeader(sspCode) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/header`);
  }

  /** List every item on a product (id/type/description only, no cost detail). */
  getItems(sspCode) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/items${this.q()}`);
  }

  /** Full detail for one item. */
  getItem(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}${this.q()}`);
  }

  /** Material rows on one item (204/empty when the item has none). */
  getItemMaterials(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}/materials${this.q()}`);
  }

  // ---- creation flow -----------------------------------------------------

  /**
   * Step 1 — create the product header. Returns the response whose
   * data.sspCode is the new SSP number. Pass `images` (built by
   * images.js — one entry per already-uploaded/QA'd photo) or omit for
   * an empty image list.
   */
  saveHeader(headerFields, images = []) {
    const body = {
      userName: this.config.userName,
      userType: 'EXTERNAL',
      sspCode: '',
      ...this.config.vendor,
      ...this.config.headerDefaults,
      ...headerFields,
      images,
      pendingDeletionImages: [],
      logTimestamp: new Date().toISOString(),
    };
    return this.request('POST', '/v1/ssp/product/header/save', body, { label: 'header/save' });
  }

  /** Step 2 — set the product costing method (e.g. "fixed with metal lock"). */
  updateCostingMethod(sspCode, costingMethod) {
    const enc = encodeURIComponent(costingMethod);
    return this.request(
      'POST',
      `/v1/ssp/product/costing-method/update-costing-method/${sspCode}/${enc}`,
      {},
      { label: 'costing method' }
    );
  }

  /** Step 3 — tether toggles (metal-loss / diamond-pricing / overcost matrices). */
  setTethers(sspCode, tethers) {
    const body = {
      sspNumber: sspCode,
      isTetheredToMetalLossMatrix: !!tethers.isTetheredToMetalLossMatrix,
      isTetheredToDiamondPricingMatrix: !!tethers.isTetheredToDiamondPricingMatrix,
      isTetheredToOvercostMatrix: !!tethers.isTetheredToOvercostMatrix,
      userName: this.config.userName,
      userType: 'EXTERNAL',
    };
    return this.request('PUT', `/v1/ssp/product/${sspCode}/items/tether${this.q()}`, body, {
      label: 'tether',
    });
  }

  /**
   * Step 4 — create an item on the product. Returns data.itemId. Always
   * mints a NEW item — passing an existing itemId here does NOT update it
   * (confirmed 2026-08-31 in the PLM: it just creates a duplicate). Use
   * updateItem below to edit an existing one.
   */
  createItem(sspCode, itemFields) {
    const body = {
      userName: this.config.userName,
      userType: 'INTERNAL', // matches the recorded UI traffic
      sspNumber: sspCode,
      skuNumber: null,
      itemId: 0,
      ...itemFields,
    };
    return this.request('POST', `/v1/ssp/product/${sspCode}/item${this.q()}`, body, {
      label: 'create item',
    });
  }

  /**
   * Update an existing item in place. CONFIRMED 2026-08-31 via a real HAR
   * (S189443/item 1, edited + saved in the live SKU Manager UI): targets
   * the item by id IN THE URL — `PUT /item/{itemId}` — body is the same
   * shape as create's, itemId included in the body too.
   */
  updateItem(sspCode, itemId, itemFields) {
    const body = {
      userName: this.config.userName,
      userType: 'INTERNAL',
      sspNumber: sspCode,
      skuNumber: null,
      itemId,
      ...itemFields,
    };
    return this.request('PUT', `/v1/ssp/product/${sspCode}/item/${itemId}${this.q()}`, body, {
      label: 'update item',
    });
  }

  /** Ceiling lookup the UI performs before saving a plated material. Informational. */
  goldPlatingCostCeiling(sspCode, itemId, params) {
    return this.request(
      'POST',
      `/v1/ssp/product/costing-method/${sspCode}/item/${itemId}/material/goldPlatingCostCeiling`,
      { sspCode, ...params },
      { label: 'plating ceiling' }
    );
  }

  /** Step 5 — add a material row (metal + optional plating block). Always creates a NEW row — see updateMaterial for editing one in place. */
  addMaterial(sspCode, itemId, materialFields) {
    const body = {
      sspNumber: sspCode,
      skuNumber: 0,
      itemId,
      userName: this.config.userName,
      userType: 'INTERNAL',
      ...materialFields,
    };
    return this.request('POST', `/v1/ssp/product/${sspCode}/item/${itemId}/material${this.q()}`, body, {
      label: 'add material',
    });
  }

  /**
   * Update an existing material row in place. CONFIRMED 2026-09-01 via a
   * real HAR (S189443/item 1/material 1): same shape as updateItem — `PUT
   * .../item/{itemId}/material/{materialId}`, id in the URL, body is the
   * create shape plus `materialId` at the end.
   */
  updateMaterial(sspCode, itemId, materialId, materialFields) {
    const body = {
      sspNumber: sspCode,
      skuNumber: 0,
      itemId,
      userName: this.config.userName,
      userType: 'INTERNAL',
      ...materialFields,
      materialId,
    };
    return this.request(
      'PUT',
      `/v1/ssp/product/${sspCode}/item/${itemId}/material/${materialId}${this.q()}`,
      body,
      { label: 'update material' }
    );
  }

  /** Step 6 — add a finding row (bail, post, clutch, ...). */
  addFinding(sspCode, itemId, findingFields) {
    const body = {
      sspNumber: sspCode,
      skuNumber: 0,
      itemId,
      userName: this.config.userName,
      userType: 'INTERNAL',
      ...findingFields,
    };
    return this.request('POST', `/v1/ssp/product/${sspCode}/item/${itemId}/finding${this.q()}`, body, {
      label: 'add finding',
    });
  }

  /** Step 6b — add a stone row (materials/findings' sibling). */
  addStone(sspCode, itemId, stoneFields) {
    const body = {
      sspNumber: sspCode,
      skuNumber: null,
      itemId,
      userName: this.config.userName,
      userType: 'EXTERNAL', // matches the recorded add-stone traffic (not INTERNAL like material/finding)
      ...stoneFields,
    };
    return this.request('POST', `/v1/ssp/product/${sspCode}/item/${itemId}/stone/add-stone`, body, {
      label: 'add stone',
    });
  }

  /** Ceiling lookups the UI performs on the labor tab. Informational. */
  castingCostCeiling(sspCode, itemId, noOfCastings) {
    return this.request(
      'POST',
      `/v1/ssp/product/costing-method/${sspCode}/item/${itemId}/laborcost/castingCostCeiling`,
      { sspCode, itemId: String(itemId), noOfCastings },
      { label: 'casting ceiling' }
    );
  }

  finishingCostCeilings(sspCode, itemId, noOfCastings, finishTypes) {
    return this.request(
      'POST',
      `/v1/ssp/product/costing-method/${sspCode}/item/${itemId}/laborcost/finishingCostCeilings`,
      { sspCode, itemId: String(itemId), noOfCastings, finishTypes },
      { label: 'finishing ceilings' }
    );
  }

  /** Step 7 — save the labor-cost tab. Response returns computed totals. */
  updateLaborCost(sspCode, itemId, model) {
    const finish = (model.finish || []).map((f) => ({ sspCode, itemId: String(itemId), ...f }));
    const body = {
      userName: this.config.userName,
      userType: 'internal', // lowercase in the recorded traffic
      model: { sspCode, itemId: String(itemId), sku: 0, ...model, finish },
    };
    return this.request('PUT', `/v1/ssp/product/${sspCode}/item/${itemId}/update-laborcost`, body, {
      label: 'labor cost',
    });
  }

  /**
   * Step 0 (optional) — stage one already-QA'd image into SSP's own
   * bucket. `tempKey` is "tempSspImages/<sspCode-or-NEW>_<ts>.jpg"; the
   * generateUrl body is a bare JSON string, not an object. Returns the
   * presigned PUT url; caller PUTs the same bytes there directly (this
   * client's own `request()` always JSON-encodes, so the raw PUT happens
   * in images.js instead).
   */
  generateImageUploadUrl(tempKey) {
    return this.request('POST', '/v1/ssp/presigned-url/generateUrl', tempKey, {
      label: 'image presigned url',
    });
  }

  /** Read back an item (verification). */
  getItem(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}`);
  }

  getLaborCost(sspCode, itemId) {
    return this.request('GET', `/v1/ssp/product/${sspCode}/item/${itemId}/get-laborcost`);
  }
}
