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

// The QA tool (an AWS API Gateway) rejected a plain server-to-server POST
// with {"message":"Unauthorized"} even though the captured HAR shows no
// authorization header on that call — it's gating on Origin/Referer/UA
// instead (or DevTools stripped the auth header on export; either way,
// matching the real browser call fixed it). Sent on every request in this
// pipeline, including the SSP API and both S3 PUTs, since the captured HAR
// shows the browser sending the identical set everywhere.
const BROWSER_LIKE_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://skumanager.cloud.jewels.com",
  referer: "https://skumanager.cloud.jewels.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

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
      headers: {
        ...BROWSER_LIKE_HEADERS,
        "content-type": "application/json",
        // The QA tool returned AWS API Gateway's canned {"message":
        // "Unauthorized"} (a Lambda-authorizer denial, not a plain CORS
        // rejection) until this was added. Neither HAR ever shows an
        // authorization header on ANY call -- including ones (like
        // add-stone) that definitely need the SSP bearer token -- so
        // Chrome's HAR export was scrubbing it, not proving it absent;
        // the real SSP frontend most likely stamps this same token onto
        // every outgoing call via one shared interceptor, this "external"
        // AWS host included.
        authorization: `Bearer ${token}`,
      },
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
      headers: { ...BROWSER_LIKE_HEADERS, "Content-Type": contentType },
      body: bytes,
    });
    if (!putRes.ok) throw new Error(`QA bucket PUT failed -> HTTP ${putRes.status}`);

    // 4) quality-analysis
    const qaRes = await fetch(`${QA_TOOL_BASE}/quality-analysis`, {
      method: "POST",
      headers: {
        ...BROWSER_LIKE_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ images: [{ s3Key, filename }] }),
    });
    const qaJson = await qaRes.json();
    if (!qaRes.ok || !qaJson?.success) {
      throw new Error(`quality-analysis failed: ${JSON.stringify(qaJson).slice(0, 300)}`);
    }
    const result = qaJson.data?.validatedImages?.[0]?.resultData || {};

    // 5) SSP's own presigned url — body is a bare string, not an object.
    // NOTE: earlier this used a "tempSspImages/" key on the theory that
    // SSP renames it to "sspImages/" server-side on save — that was
    // wrong (confirmed by a broken/empty image at the guessed sspImages/
    // path, 2026-08-26, product S188254: header/save doesn't verify the
    // referenced key actually has content, it just stores the string).
    // Request the real, final "sspImages/" key directly and upload there
    // instead, so the path we reference is the path that actually has
    // the bytes.
    const ext = (filename.match(/\.[^.]+$/) || [".jpg"])[0];
    const imageKey = `sspImages/${sspCode || "NEW"}_${Date.now()}${ext}`;
    const genRes = await fetch(`${SSP_API_BASE}/v1/ssp/presigned-url/generateUrl`, {
      method: "POST",
      headers: {
        ...BROWSER_LIKE_HEADERS,
        "sec-fetch-site": "same-site",
        "x-data-source": "SSP",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(imageKey),
    });
    const genJson = await genRes.json();
    if (!genRes.ok || !genJson?.success || !genJson?.data) {
      throw new Error(`SSP generateUrl failed: ${JSON.stringify(genJson).slice(0, 300)}`);
    }

    // 6) PUT bytes to SSP's own bucket
    const sspPutRes = await fetch(genJson.data, {
      method: "PUT",
      headers: { ...BROWSER_LIKE_HEADERS, "Content-Type": contentType },
      body: bytes,
    });
    if (!sspPutRes.ok) throw new Error(`SSP bucket PUT failed -> HTTP ${sspPutRes.status}`);

    // The actual object key is whatever SSP signed the PUT URL for, not
    // necessarily the `imageKey` string we asked generateUrl for -- confirmed
    // 2026-08-31 (product S188529): both uploaded images came back from
    // header/save with a valid-looking presigned GET, but S3 returned
    // NoSuchKey for both -- the PUT genuinely succeeded (the QA step's
    // content-specific description proves real bytes made it to AWS), so
    // the object exists somewhere, just not at the key we guessed and then
    // told header/save to reference. Parse the REAL key out of the signed
    // PUT URL itself so imageUrl always points at bytes that actually exist.
    let realImageKey = imageKey;
    try {
      realImageKey = decodeURIComponent(new URL(genJson.data).pathname.replace(/^\/+/, ""));
    } catch {
      /* malformed URL somehow — fall back to our guessed key rather than fail the whole upload */
    }

    // qaStatus/QADetailedResponse corrected against a real header/save
    // payload (2026-08-26, product S180933): qaStatus is the plain string
    // "pass" (not the QA tool's own "success"/"score" vocabulary) and
    // QADetailedResponse is a bare string — just the QA tool's
    // validationDescription text — not an object.
    return Response.json({
      success: true,
      data: {
        imageUrl: realImageKey,
        isPrimary: !!isPrimary,
        qaStatus: result.validationStatus === "success" ? "pass" : "fail",
        QADetailedResponse: result.validationDescription || "",
      },
      // TEMP DEBUG (2026-08-31) — not sent to SSP, sspStageImage only reads
      // `data`. Remove once the NoSuchKey-after-fix report on S189443 is
      // root-caused: need to see whether generateUrl's real pathname ever
      // disagrees with our guessed `imageKey`, or whether the SSP bucket
      // PUT is succeeding against a key that 404s moments later.
      debug: {
        guessedKey: imageKey,
        presignedPutUrl: genJson.data,
        realImageKey,
        keysMatched: imageKey === realImageKey,
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
