// netlify/functions/ssp-fill.mjs
//
// Feeds the "E. Chabot SSP Filler" Chrome extension (tools/ssp-extension).
// The extension types values into the SKU Manager form on the user's own
// screen; it never calls the SSP API and never holds an SSP token. All it
// needs from us is WHAT to type, which this function builds with the same
// payload code as Create in SSP (src/utils/sspPayloads.js).
//
// POST /api/ssp-fill   (JSON body, one of:)
//   { action: "login",   email, password }        -> { access_token, refresh_token, expires_at }
//   { action: "refresh", refresh_token }          -> same
//   { action: "plan",    style: "N2459P" }        -> { plans: [...] }   (needs Authorization: Bearer <access_token>)
//
// "style" can be a sample style number, a comma-separated list of them, or a
// set card's style number (sample_sets.style_number) -- a set comes back as
// ONE plan with one entry per member, in set order.
//
// Reads go through the caller's own Supabase session, so row-level security
// applies exactly as it does in the PLM. Nothing is written. SSP tokens and
// any other secrets in the settings row are never returned.

import { createClient } from "@supabase/supabase-js";
import { buildSspPayloadsForSample, fetchMetalPrices } from "../../src/utils/sspPayloads.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

const sessionOut = (s) => ({
  access_token: s.access_token,
  refresh_token: s.refresh_token,
  expires_at: s.expires_at,
});

const s = (v) => (v == null ? "" : String(v).trim());

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON) return json({ ok: false, error: "Server is missing Supabase env vars" }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // ---- auth passthrough (the extension holds no Supabase keys) -----------
  if (body.action === "login" || body.action === "refresh") {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } });
    const { data, error } =
      body.action === "login"
        ? await anon.auth.signInWithPassword({ email: s(body.email), password: String(body.password || "") })
        : await anon.auth.refreshSession({ refresh_token: s(body.refresh_token) });
    if (error || !data?.session) return json({ ok: false, error: error?.message || "Sign-in failed" }, 401);
    return json({ ok: true, session: sessionOut(data.session), email: data.user?.email || s(body.email) });
  }

  if (body.action !== "plan") return json({ ok: false, error: "Unknown action" }, 400);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not signed in" }, 401);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: who, error: whoErr } = await supabase.auth.getUser(token);
  if (whoErr || !who?.user) return json({ ok: false, error: "Session expired — sign in again" }, 401);

  const wanted = s(body.style)
    .split(/[,\n;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!wanted.length) return json({ ok: false, error: "Enter a style number" }, 400);
  if (wanted.length > 20) return json({ ok: false, error: "Max 20 styles at a time" }, 400);

  // Only the non-secret defaults are passed on to the builder.
  const { data: settingsRow } = await supabase.from("settings").select("options").limit(1).maybeSingle();
  const safeSettings = {
    options: { sspIntegration: { defaults: settingsRow?.options?.sspIntegration?.defaults || {} } },
  };
  const metalPrices = await fetchMetalPrices(supabase);

  const plans = [];
  for (const style of wanted) {
    try {
      plans.push(await planFor(supabase, style, safeSettings, metalPrices));
    } catch (e) {
      plans.push({ style, ok: false, error: e?.message || String(e) });
    }
  }
  return json({ ok: true, user: who.user.email, plans });
};

async function fetchRowsByStyle(supabase, style) {
  const { data, error } = await supabase
    .from("sample_with_stones_export")
    .select("*")
    .eq("styleNumber", style);
  if (error) throw new Error(error.message);
  return data || [];
}

async function planFor(supabase, style, settings, metalPrices) {
  // 1. A set card?
  const { data: setCard } = await supabase
    .from("sample_sets")
    .select("id, style_number, name")
    .ilike("style_number", style)
    .maybeSingle();

  let rows;
  let set = null;
  if (setCard) {
    const { data: members, error } = await supabase
      .from("sample_set_members")
      .select("sample_id, position")
      .eq("set_id", setCard.id)
      .order("position");
    if (error) throw new Error(error.message);
    const ids = (members || []).map((m) => m.sample_id);
    if (!ids.length) throw new Error(`set ${setCard.style_number} has no members`);
    const { data: sampleRows, error: e2 } = await supabase
      .from("sample_with_stones_export")
      .select("*")
      .in("sample_id", ids);
    if (e2) throw new Error(e2.message);
    const byId = new Map((sampleRows || []).map((r) => [r.sample_id, r]));
    rows = ids.map((id) => byId.get(id)).filter(Boolean);
    set = { style: setCard.style_number, name: setCard.name || "" };
  } else {
    rows = await fetchRowsByStyle(supabase, style);
    if (!rows.length) throw new Error(`no sample with style number "${style}"`);
    if (rows.length > 1) throw new Error(`style number "${style}" matches ${rows.length} samples`);
  }

  const items = rows.map((sample) => {
    const label = s(sample.styleNumber);
    try {
      const { payloads, warnings } = buildSspPayloadsForSample(sample, { settings, metalPrices });
      return {
        label,
        ok: true,
        warnings,
        // What the extension may type. Costing/tether are product-level; the
        // rest maps one-to-one onto SKU Manager's tabs.
        header: payloads.header,
        item: payloads.item,
        material: payloads.material,
        finding: payloads.finding,
        stones: payloads.stones,
        labor: payloads.labor,
        vendorCost: payloads.vendorCost,
        imageUrls: payloads.imageSourceUrls || [],
        salesPrice: sample.salesPrice == null ? null : Number(sample.salesPrice),
      };
    } catch (e) {
      return { label, ok: false, error: e?.message || String(e), warnings: [] };
    }
  });

  if (set) {
    // A set is ONE SSP: header carries the set's own style number, and the
    // photos of every member (first photo of each, then second photos... max 4).
    const per = items.map((it) => [...new Set(it.imageUrls || [])]);
    const imageUrls = [];
    for (let k = 0; imageUrls.length < 4 && per.some((l) => k < l.length); k++) {
      for (const l of per) if (k < l.length && imageUrls.length < 4) imageUrls.push(l[k]);
    }
    if (items[0]?.header) items[0].header = { ...items[0].header, vendorStyleNumber: set.style };
    return { style, ok: items.every((i) => i.ok), set, imageUrls, items };
  }
  return { style, ok: items[0].ok, set: null, imageUrls: items[0].imageUrls || [], items };
}

export const config = { path: "/api/ssp-fill" };
