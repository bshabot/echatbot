// netlify/functions/ssp-proxy.mjs
//
// Same-origin proxy for Signet's SSP / SKU Manager API. The PLM's browser
// code can't call api.skumanager.cloud.jewels.com directly (CORS), so it
// calls /api/ssp/<path> on our own domain and this function forwards the
// request verbatim — method, body, and the caller-supplied Entra bearer
// token (x-ssp-token header) — to the SSP API.
//
// Nothing is stored here and there are no secrets in this function: the
// token comes from the caller on every request (pasted in the PLM's
// Settings page, short-lived). Only the fixed SSP API host is reachable —
// this is not a general-purpose proxy.

const SSP_API_BASE = "https://api.skumanager.cloud.jewels.com";

export default async (req) => {
  const url = new URL(req.url);
  // /api/ssp/v1/ssp/... -> /v1/ssp/...
  const upstreamPath = url.pathname.replace(/^\/api\/ssp/, "") + url.search;

  const token = req.headers.get("x-ssp-token") || "";
  if (!token) {
    return Response.json(
      { success: false, errorMessage: "Missing SSP token (x-ssp-token header)" },
      { status: 401 }
    );
  }

  // The captured HAR shows every SSP call carrying the full browser header
  // set below, not just accept/authorization — the image-QA tool (an
  // AWS-fronted endpoint in this same family) rejected a plain
  // server-to-server call with {"message":"Unauthorized"} until these were
  // added, so they're sent here too rather than risk the same gate on the
  // main SSP API.
  const headers = {
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
    "sec-fetch-site": "same-site",
    authorization: `Bearer ${token}`,
  };
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.text();
    headers["content-type"] = req.headers.get("content-type") || "application/json";
  }

  let upstream;
  try {
    upstream = await fetch(`${SSP_API_BASE}${upstreamPath}`, {
      method: req.method,
      headers,
      body,
    });
  } catch (e) {
    return Response.json(
      { success: false, errorMessage: `SSP unreachable: ${e?.message || e}` },
      { status: 502 }
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};

export const config = { path: "/api/ssp/*" };
