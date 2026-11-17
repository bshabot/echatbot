import { createClient } from "npm:@supabase/supabase-js@2";

// Prefer the new secret key (SUPABASE_SECRET_KEYS = {"default":"sb_secret_..."}); fall back to the legacy variable.
function serviceKey(): string {
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}")?.default;
    if (k) return k;
  } catch { /* fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const supa = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey());

// Browser calls come from db.echabot.com + Netlify previews — answer the
// preflight and stamp every response, or the browser blocks the call.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Who may call this (deploy with --no-verify-jwt; the platform check only understands legacy keys):
//   1. the scheduled job, sending the shared secret in x-cron-secret (function secret CRON_SECRET), or
//   2. a signed-in staff member from the PLM (their Supabase session token).
// The public key and vendors are refused.
async function authorized(req: Request): Promise<boolean> {
  const cron = Deno.env.get("CRON_SECRET");
  const sent = req.headers.get("x-cron-secret");
  if (cron && sent && sent === cron) return true;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length > 4000) return false;
  const { data, error } = await supa.auth.getUser(token);
  return !error && !!data?.user;
}

const UPS = "https://onlinetools.ups.com";

const BLANK = {
  status: null, description: null, delivered_at: null, signed_by: null,
  delivery_location: null, last_event: null, last_location: null,
  last_event_at: null, scheduled_delivery: null, raw: null,
};

async function getToken(): Promise<string> {
  const { data, error } = await supa.rpc("get_ups_creds");
  if (error || !data) throw new Error("vault creds: " + (error?.message ?? "empty"));
  const c = JSON.parse(data);
  const b64 = btoa(`${c.client_id}:${c.client_secret}`);
  const r = await fetch(`${UPS}/security/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${b64}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("UPS token failed: " + JSON.stringify(j));
  return j.access_token;
}

// UPS returns local date/time with no zone; assume US East (our DCs are OH/MA).
function toEastIso(d8?: string, t6?: string): string | null {
  if (!d8 || d8.length !== 8) return null;
  const base = `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}T${
    t6 && t6.length >= 6 ? `${t6.slice(0, 2)}:${t6.slice(2, 4)}:${t6.slice(4, 6)}` : "12:00:00"
  }`;
  for (const off of ["-04:00", "-05:00"]) {
    const dt = new Date(base + off);
    const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(dt);
    if (parseInt(h) % 24 === parseInt(base.slice(11, 13))) return dt.toISOString();
  }
  return new Date(base + "-05:00").toISOString();
}

function d8ToDate(d8?: string): string | null {
  return d8 && d8.length === 8 ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : null;
}

function parseTrack(tracking: string, j: any) {
  const row: any = { ...BLANK, tracking, last_checked: new Date().toISOString() };
  const shp = j?.trackResponse?.shipment?.[0];
  if (!shp || shp.warnings) {
    row.status = "Not found";
    row.description = shp?.warnings?.[0]?.message ?? "No data returned";
    return row;
  }
  const pkg = shp.package?.[0] ?? {};
  row.raw = pkg;
  row.status = pkg.currentStatus?.description?.trim() ?? "Unknown";
  const act = pkg.activity?.[0];
  if (act) {
    const a = act.location?.address ?? {};
    row.last_event = act.status?.description?.trim() ?? null;
    row.last_location = [a.city, a.stateProvince].filter(Boolean).join(", ") || null;
    row.last_event_at = toEastIso(act.date, act.time);
  }
  for (const d of pkg.deliveryDate ?? []) {
    if (d.type === "DEL") {
      row.status = "Delivered";
      row.delivered_at = toEastIso(d.date, pkg.deliveryTime?.type === "DEL" ? pkg.deliveryTime?.endTime : undefined);
    } else {
      row.scheduled_delivery = d8ToDate(d.date);
    }
  }
  const di = pkg.deliveryInformation;
  if (di) {
    row.signed_by = di.receivedBy || null;
    row.delivery_location = di.location || null;
  }
  return row;
}

async function trackOne(token: string, num: string) {
  const r = await fetch(
    `${UPS}/api/track/v1/details/${num}?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false`,
    { headers: { Authorization: `Bearer ${token}`, transId: crypto.randomUUID(), transactionSrc: "EchabotPLM" } },
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ...BLANK, tracking: num, status: "Error",
      description: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`,
      last_checked: new Date().toISOString(),
    };
  }
  return parseTrack(num, j);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (!(await authorized(req))) {
    return new Response(JSON.stringify({ error: "sign in required" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json().catch(() => ({}));
    let nums: string[] = Array.isArray(body.trackingNumbers) ? body.trackingNumbers : [];
    if (nums.length === 0) {
      const { data, error } = await supa.rpc("get_pending_trackings");
      if (error) throw new Error("get_pending_trackings: " + error.message);
      nums = (data ?? []).map((r: any) => r.tracking);
    }
    nums = [...new Set(nums.map((n) => String(n).trim().toUpperCase()))]
      .filter((n) => /^1Z[A-Z0-9]{16}$/.test(n))
      .slice(0, 200);
    const rows: any[] = [];
    if (nums.length > 0) {
      const token = await getToken();
      for (let i = 0; i < nums.length; i += 5) {
        const res = await Promise.all(nums.slice(i, i + 5).map((n) => trackOne(token, n)));
        rows.push(...res);
      }
      const { error: upErr } = await supa.from("ups_tracking_status").upsert(rows, { onConflict: "tracking" });
      if (upErr) throw new Error("upsert: " + upErr.message);
    }
    const { data: podFilled } = await supa.rpc("fill_pod_from_ups");
    return new Response(
      JSON.stringify({
        checked: rows.length,
        delivered: rows.filter((r) => r.status === "Delivered").length,
        pod_filled: podFilled ?? 0,
        statuses: rows.map(({ tracking, status, delivered_at, signed_by, scheduled_delivery }) =>
          ({ tracking, status, delivered_at, signed_by, scheduled_delivery })),
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
