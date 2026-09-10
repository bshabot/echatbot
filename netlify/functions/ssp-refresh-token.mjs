// netlify/functions/ssp-refresh-token.mjs
//
// Exchanges a Signet SSP (Microsoft Entra ID) refresh_token for a new
// access_token, so the PLM can renew an expired SSP bearer token itself
// instead of Brian having to paste a fresh one every ~hour.
//
// This is Entra's standard OAuth2 v2.0 token endpoint for a public/SPA
// client — no client secret is used or needed (the SSP web app itself is
// a public client; that's why the original sign-in never asked for one).
// Values below were read out of a real decoded SSP access token (aud/tid/
// azp claims), not guessed:
//   tenant   3aa3ff7f-2e43-4ebd-b484-42e80b2efcaa
//   clientId ba312980-8c49-4cd7-817e-81df114d67fb
//   scope    api://088805e2-22c1-47de-815f-da2ccc440c65/User
//
// Nothing is stored here: the caller sends the refresh token in the
// request body and this function returns the new token pair. The PLM
// persists the result in Settings (see sspClient.js: sspRefreshToken /
// ensureFreshSspToken).

const TENANT_ID = "3aa3ff7f-2e43-4ebd-b484-42e80b2efcaa";
const CLIENT_ID = "ba312980-8c49-4cd7-817e-81df114d67fb";
const SCOPE = "api://088805e2-22c1-47de-815f-da2ccc440c65/User";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ success: false, errorMessage: "Method not allowed" }, { status: 405 });
  }

  let refreshToken = "";
  try {
    const body = await req.json();
    refreshToken = String(body?.refreshToken || "").trim();
  } catch {
    return Response.json({ success: false, errorMessage: "Invalid JSON body" }, { status: 400 });
  }

  if (!refreshToken) {
    return Response.json(
      { success: false, errorMessage: "Missing refreshToken" },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: SCOPE,
  });

  let upstream;
  try {
    upstream = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Entra rejects a SPA-registered client's token redemption with
        // AADSTS9002327 unless the request looks like a real cross-origin
        // browser call — it checks for an Origin header matching one of
        // the app registration's SPA redirect URIs. A server-to-server
        // POST with no Origin header (what this looked like before) gets
        // that error, so we send the same Origin the SSP web app itself
        // runs on.
        origin: "https://skumanager.cloud.jewels.com",
      },
      body: params.toString(),
    });
  } catch (e) {
    return Response.json(
      { success: false, errorMessage: `Entra token endpoint unreachable: ${e?.message || e}` },
      { status: 502 }
    );
  }

  const text = await upstream.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }

  if (!upstream.ok || !json?.access_token) {
    return Response.json(
      {
        success: false,
        errorMessage:
          json?.error_description || json?.error || `Refresh failed: HTTP ${upstream.status}`,
      },
      { status: upstream.status === 200 ? 502 : upstream.status }
    );
  }

  const expiresInSec = Number(json.expires_in) || 3600;
  return Response.json({
    success: true,
    data: {
      accessToken: json.access_token,
      // Entra may or may not rotate the refresh token on each use; fall
      // back to the one the caller sent so it's never dropped.
      refreshToken: json.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
    },
  });
};

export const config = { path: "/api/ssp-refresh-token" };
