// Shared guard for staff-only Netlify functions: the caller must send a valid
// staff Supabase session token as "Authorization: Bearer <token>". Vendor portal
// sessions are a different system and never pass this check.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

export async function requireStaff(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length > 4000 || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? u : null;
  } catch {
    return null;
  }
}

export const notSignedIn = () =>
  Response.json({ success: false, errorMessage: "Not signed in" }, { status: 401, headers: { "cache-control": "no-store" } });
