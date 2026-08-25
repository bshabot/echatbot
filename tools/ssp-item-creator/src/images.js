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
 * Neither AWS endpoint in steps 1/3 needs a token (none was present in
 * the capture — cross-site, unauthenticated). Step 4 goes through the
 * same SspClient as everything else, so it carries the SSP bearer token.
 */

import fs from 'node:fs';
import path from 'node:path';

const QA_TOOL_BASE = 'https://w0ilpcdyd6.execute-api.us-east-2.amazonaws.com/prod';

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
  const contentType = contentTypeFor(filename);

  // 1) QA tool's own presigned slot
  const presignRes = await fetch(`${QA_TOOL_BASE}/presigned-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!putRes.ok) throw new Error(`QA bucket PUT failed -> HTTP ${putRes.status}`);

  // 3) quality-analysis
  const qaRes = await fetch(`${QA_TOOL_BASE}/quality-analysis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images: [{ s3Key, filename }] }),
  });
  const qaJson = await qaRes.json();
  if (!qaRes.ok || !qaJson?.success) {
    throw new Error(`quality-analysis failed: ${JSON.stringify(qaJson).slice(0, 300)}`);
  }
  const result = qaJson.data?.validatedImages?.[0]?.resultData || {};

  // 4) SSP's own presigned url — body is a bare string, not an object
  const tempKey = `tempSspImages/${sspCode || 'NEW'}_${Date.now()}${path.extname(filename) || '.jpg'}`;
  const genRes = await client.generateImageUploadUrl(tempKey);
  const sspUploadUrl = genRes?.data;
  if (!sspUploadUrl) throw new Error('SSP generateUrl returned no url');

  // 5) PUT bytes to SSP's own bucket
  const sspPutRes = await fetch(sspUploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!sspPutRes.ok) throw new Error(`SSP bucket PUT failed -> HTTP ${sspPutRes.status}`);

  // NOTE: the header/save images[] shape below is carried over from
  // earlier reverse-engineering, not re-confirmed by this capture (see
  // docs/API-NOTES.md) — flag qaStatus/QADetailedResponse as best-effort.
  return {
    imageUrl: tempKey,
    isPrimary,
    qaStatus: result.validationStatus || 'success',
    QADetailedResponse: {
      score: result.score ?? null,
      validationDescription: result.validationDescription || '',
      validationErrors: result.validationErrors || [],
    },
  };
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
