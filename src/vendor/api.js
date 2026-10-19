// The vendor page's only network path. One function, fixed actions, cookie
// session (HttpOnly, so this code can never read it). No Supabase, no keys.

const ENDPOINT = "/.netlify/functions/vendor-portal";

export async function portal(action, payload = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json", "x-vendor-portal": "1" },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    return { ok: false, status: 0, error: "network", message: "Can't reach the server. Check your connection." };
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  return { ...data, ok: res.ok && data.ok !== false, status: res.status };
}
