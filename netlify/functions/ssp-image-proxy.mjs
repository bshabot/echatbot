// netlify/functions/ssp-image-proxy.mjs
//
// Server-side twin of tools/ssp-item-creator/src/images.js — the PLM's
// "Create in SSP" image step (see src/utils/sspClient.js's
// sspStageImage/sspStageImagesForSample). Runs the full pipeline captured
// in a real HAR (2026-08-25, S180933, two images — see
// tools/ssp-item-creator/docs/API-NOTES.md) server-side because it talks
// to hosts the browser can't reach cross-origin:
//
//   1. fetch the source image (e.g. an R2 URL)
//   2. POST the AI quality-tool's own presigned-url endpoint
//   3. PUT the bytes there
//   4. POST quality-analysis on that s3Key (scores the image)
//   5. POST SSP's presigned-url/generateUrl (needs the caller's SSP token)
//   6. PUT the bytes to SSP's own bucket -> that key is the imageUrl
//
// Nothing is stored here: the SSP token comes from the caller on every
// request (x-ssp-token, same convention as ssp-proxy.mjs), same as the
// main proxy.

const QA_TOOL_BASE = "https://w0ilpcdyd6.execute-api.us-east-2.amazonaws.com/prod";
const SSP_API_BASE = "https://api.skumanager.cloud.jewels.com";

function contentTypeFor(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ success: false, errorMessage: "POST only" }, { status: 405 });
  }
  const token = req.headers.get("x-ssp-token") || "";
  if (!token) {
    return Response.json(
      { success: false, errorMessage: "Missing SSP token (x-ssp-token header)" },
      { status: 401 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, errorMessage: "Invalid JSON body" }, { status: 400 });
  }
  const { sspCode, sourceUrl, filename, isPrimary } = body || {};
  if (!sourceUrl || !filename) {
    return Response.json(
      { success: false, errorMessage: "sourceUrl and filename are required" },
      { status: 400 }
    );
  }

  try {
    const contentType = contentTypeFor(filename);

    // 1) fetch the source bytes (e.g. from R2)
    const srcRes = await fetch(sourceUrl);
    if (!srcRes.ok) throw new Error(`Could not fetch source image (${srcRes.status}): ${sourceUrl}`);
    const bytes = await srcRes.arrayBuffer();

    // 2) QA tool's own presigned slot
    const presignRes = await fetch(`${QA_TOOL_BASE}/presigned-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, contentType }),
    });
    const presignJson = await presignRes.json();
    if (!presignRes.ok || !presignJson?.success) {
      throw new Error(`QA presigned-url failed: ${JSON.stringify(presignJson).slice(0, 300)}`);
    }
    const { uploadUrl, key: s3Key } = presignJson.data;

    // 3) PUT bytes to the QA bucket
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!putRes.ok) throw new Error(`QA bucket PUT failed -> HTTP ${putRes.status}`);

    // 4) quality-analysis
    const qaRes = await fetch(`${QA_TOOL_BASE}/quality-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: [{ s3Key, filename }] }),
    });
    const qaJson = await qaRes.json();
    if (!qaRes.ok || !qaJson?.success) {
      throw new Error(`quality-analysis failed: ${JSON.stringify(qaJson).slice(0, 300)}`);
    }
    const result = qaJson.data?.validatedImages?.[0]?.resultData || {};

    // 5) SSP's own presigned url — body is a bare string, not an object
    const ext = (filename.match(/\.[^.]+$/) || [".jpg"])[0];
    const tempKey = `tempSspImages/${sspCode || "NEW"}_${Date.now()}${ext}`;
    const genRes = await fetch(`${SSP_API_BASE}/v1/ssp/presigned-url/generateUrl`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(tempKey),
    });
    const genJson = await genRes.json();
    if (!genRes.ok || !genJson?.success || !genJson?.data) {
      throw new Error(`SSP generateUrl failed: ${JSON.stringify(genJson).slice(0, 300)}`);
    }

    // 6) PUT bytes to SSP's own bucket
    const sspPutRes = await fetch(genJson.data, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!sspPutRes.ok) throw new Error(`SSP bucket PUT failed -> HTTP ${sspPutRes.status}`);

    // NOTE: this images[] entry shape is carried over from earlier
    // reverse-engineering of the header payload, not re-confirmed by the
    // captured HAR (it ended before the header/save-with-images call) —
    // see docs/API-NOTES.md.
    return Response.json({
      success: true,
      data: {
        imageUrl: tempKey,
        isPrimary: !!isPrimary,
        qaStatus: result.validationStatus || "success",
        QADetailedResponse: {
          score: result.score ?? null,
          validationDescription: result.validationDescription || "",
          validationErrors: result.validationErrors || [],
        },
      },
    });
  } catch (e) {
    return Response.json(
      { success: false, errorMessage: e?.message || String(e) },
      { status: 502 }
    );
  }
};

export const config = { path: "/api/ssp-image" };
