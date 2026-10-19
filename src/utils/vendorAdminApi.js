// Staff-side client for netlify/functions/vendor-admin.mjs. The caller's
// Supabase access token is sent so the function can verify they are logged in.

const ENDPOINT = "/.netlify/functions/vendor-admin";

export async function vendorAdmin(session, action, payload = {}) {
  const token = session?.access_token;
  if (!token) return { ok: false, message: "You are signed out." };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-vendor-portal": "1", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, ok: res.ok && data.ok !== false };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}
