/**
 * Image upload pipeline — captured from a real "add image" HAR
 * (2026-08-25, S180933, two images). See docs/API-NOTES.md for the full
 * request/response shapes. Five steps per image, all done here in Node
 * so there's no browser CORS problem:
 *
 *   1. POST the AI quality-tool's own presigned-url endpoint
 *   2. PUT the bytes there
 *   3. POST quality-analysis on that s3Key (scores the image)
 *   4. POST SSP's presigned-url/generateUrl (needs the SSP token)
 *   5. PUT the bytes to SSP's own bucket -> that key is the imageUrl
 *
 * Steps 1/3 turned out to need the SSP bearer token too, despite neither
 * HAR showing an authorization header on them — see BROWSER_LIKE_HEADERS
 * below. Step 4 goes through the same SspClient as everything else, so
 * it carries the token the same way.
 *
 * Results are cached on disk (.image-cache.json, gitignored) keyed by a
 * hash of the actual bytes + filename, since staging one image is 5 real
 * network round-trips — no reason to redo them on every retry of a LATER
 * step (header/save, item create...) that has nothing to do with photos.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const QA_TOOL_BASE = 'https://w0ilpcdyd6.execute-api.us-east-2.amazonaws.com/prod';

// The QA tool (an AWS API Gateway) returns {"message":"Unauthorized"} to a
// plain server-to-server POST, even though the captured HAR shows no
// authorization header on the call — it's gating on Origin/Referer/UA
// instead (or DevTools stripped the auth header on export). Sending the
// same header set the browser sent (per the HAR) fixed it.
const BROWSER_LIKE_HEADERS = {
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
  'sec-fetch-site': 'cross-site',
};

// ── Image staging cache ──────────────────────────────────────────────────
// Bump CACHE_VERSION any time the images[] entry shape changes (see the
// 2026-08-26 qaStatus/QADetailedResponse/imageUrl fix) so a stale,
// wrong-shaped cached entry from before that fix can never come back.
const CACHE_VERSION = 4;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — about one workday
const CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.image-cache.json'
);

function loadImageCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && obj.version === CACHE_VERSION && obj.entries ? obj.entries : {};
  } catch {
    return {}; // missing/corrupt/old-version — start fresh
  }
}

function saveImageCache(entries) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2));
  } catch {
    /* best-effort — caching is a convenience, not a requirement */
  }
}

function imageCacheKey(bytes, filename) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20);
  return `${filename}:${hash}`;
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** Load image bytes from a local file path or an http(s) URL (e.g. R2). */
export async function loadImageBytes(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not fetch image ${source} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(source);
}

/**
 * Run one image through all five steps. `filename` is what gets sent to
 * the QA tool and embedded in its S3 key — pass a distinct name for each
 * of the (at least two) images SSP wants, even when they're the same
 * bytes (e.g. "N2890E-GP.jpg" and "N2890E-GP-2.jpg").
 */
export async function stageImage(client, { sspCode, bytes, filename, isPrimary = false }) {
  const cache = loadImageCache();
  const key = imageCacheKey(bytes, filename);
  const cached = cache[key];
  if (cached && Date.now() - cached.stagedAt < CACHE_TTL_MS) {
    return { ...cached.data, isPrimary };
  }

  const contentType = contentTypeFor(filename);

  // 1) QA tool's own presigned slot -- needs the same SSP bearer token as
  // everything else (see BROWSER_LIKE_HEADERS comment above); the tool
  // returned AWS API Gateway's canned {"message":"Unauthorized"} without it.
  const presignRes = await fetch(`${QA_TOOL_BASE}/presigned-url`, {
    method: 'POST',
    headers: {
      ...BROWSER_LIKE_HEADERS,
      'content-type': 'application/json',
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ filename, contentType }),
  });
  const presignJson = await presignRes.json();
  if (!presignRes.ok || !presignJson?.success) {
    throw new Error(`QA presigned-url failed: ${JSON.stringify(presignJson).slice(0, 300)}`);
  }
  const { uploadUrl, key: s3Key } = presignJson.data;

  // 2) PUT bytes to the QA bucket
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { ...BROWSER_LIKE_HEADERS, 'Content-Type': contentType },
    body: bytes,
  });
  if (!putRes.ok) throw new Error(`QA bucket PUT failed -> HTTP ${putRes.status}`);

  // 3) quality-analysis
  const qaRes = await fetch(`${QA_TOOL_BASE}/quality-analysis`, {
    method: 'POST',
    headers: {
      ...BROWSER_LIKE_HEADERS,
      'content-type': 'application/json',
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ images: [{ s3Key, filename }] }),
  });
  const qaJson = await qaRes.json();
  if (!qaRes.ok || !qaJson?.success) {
    throw new Error(`quality-analysis failed: ${JSON.stringify(qaJson).slice(0, 300)}`);
  }
  const result = qaJson.data?.validatedImages?.[0]?.resultData || {};

  // 4) SSP's own presigned url — body is a bare string, not an object.
  // NOTE: earlier this used a "tempSspImages/" key on the theory that SSP
  // renames it to "sspImages/" server-side on save — that was wrong
  // (confirmed by a broken/empty image at the guessed sspImages/ path,
  // 2026-08-26, product S188254: header/save doesn't verify the
  // referenced key actually has content, it just stores the string).
  // Request the real, final "sspImages/" key directly and upload there
  // instead, so the path referenced is the path that actually has bytes.
  const imageKey = `sspImages/${sspCode || 'NEW'}_${Date.now()}${path.extname(filename) || '.jpg'}`;
  const genRes = await client.generateImageUploadUrl(imageKey);
  const sspUploadUrl = genRes?.data;
  if (!sspUploadUrl) throw new Error('SSP generateUrl returned no url');

  // 5) PUT bytes to SSP's own bucket
  const sspPutRes = await fetch(sspUploadUrl, {
    method: 'PUT',
    headers: { ...BROWSER_LIKE_HEADERS, 'Content-Type': contentType },
    body: bytes,
  });
  if (!sspPutRes.ok) throw new Error(`SSP bucket PUT failed -> HTTP ${sspPutRes.status}`);

  // The actual object key is whatever SSP signed sspUploadUrl for, not
  // necessarily the `imageKey` string we asked generateUrl for -- confirmed
  // 2026-08-31 (product S188529, via the app's twin of this code): the PUT
  // genuinely succeeds (the QA step's content-specific description proves
  // real bytes reached AWS) but S3 returns NoSuchKey for our guessed key
  // afterward. Parse the REAL key out of the signed PUT URL itself.
  let realImageKey = imageKey;
  try {
    realImageKey = decodeURIComponent(new URL(sspUploadUrl).pathname.replace(/^\/+/, ''));
  } catch {
    /* malformed URL somehow -- fall back to our guessed key rather than fail the whole upload */
  }

  // qaStatus/QADetailedResponse corrected against a real header/save
  // payload (2026-08-26, product S180933): qaStatus is the plain string
  // "pass" (not the QA tool's own "success"/"score" vocabulary) and
  // QADetailedResponse is a bare string -- just the QA tool's
  // validationDescription text -- not an object.
  const entry = {
    imageUrl: realImageKey,
    isPrimary,
    qaStatus: result.validationStatus === 'success' ? 'pass' : 'fail',
    QADetailedResponse: result.validationDescription || '',
  };
  cache[key] = { stagedAt: Date.now(), data: entry };
  saveImageCache(cache);
  return entry;
}

/**
 * Stage every image for one item. `sources` is an array of local paths
 * or http(s) URLs. When there's only one, it's sent twice under two
 * filenames (SSP wants >=2 images) — same trick the UI capture used.
 */
export async function stageImagesForItem(client, { sspCode, sources, baseFilename }) {
  const list = (sources || []).filter(Boolean);
  if (!list.length) return [];
  const effective = list.length >= 2 ? list : [list[0], list[0]];
  const out = [];
  for (let i = 0; i < effective.length; i++) {
    const bytes = await loadImageBytes(effective[i]);
    const ext = path.extname(effective[i].split('?')[0]) || '.jpg';
    const filename = i === 0 ? `${baseFilename}${ext}` : `${baseFilename}-${i + 1}${ext}`;
    out.push(await stageImage(client, { sspCode, bytes, filename, isPrimary: i === 0 }));
  }
  return out;
}
