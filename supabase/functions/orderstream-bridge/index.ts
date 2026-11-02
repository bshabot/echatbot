// orderstream-bridge Edge Function: sync new orders, ship + invoice labeled ones, all from the cloud.
// Actions (POST JSON {action}): status | check (sync, then run if automation is on) | sync | run.
// Callers: a signed-in PLM user (Check button) or pg_cron with header x-cron-secret.
// Secrets: ORDERSTREAM_EMAIL, ORDERSTREAM_PASSWORD. The cron secret lives in dropship_session id 2 (service-only).
import { createClient } from "npm:@supabase/supabase-js@2";
import { Jar, makeClient, httpLogin, SessionExpired } from "./client.js";
import { parseQuickShip } from "./parse.js";
import { shipOrder, invoiceOrder } from "./os.js";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });

async function setStatus(patch: Record<string, unknown>) {
  const { data } = await supa.from("dropship_settings").select("value").eq("key", "bridge_status").maybeSingle();
  await supa.from("dropship_settings").upsert({ key: "bridge_status", value: { ...(data?.value ?? {}), ...patch }, updated_at: new Date().toISOString() });
}
async function isPaused() {
  const { data } = await supa.from("dropship_settings").select("value").eq("key", "paused").maybeSingle();
  return data ? data.value !== false : true;
}
async function saveJar(jar: Jar, note: string) {
  await supa.from("dropship_session").upsert({ id: 1, cookies: jar.items, updated_at: new Date().toISOString(), note });
}
async function loadJar(): Promise<Jar | null> {
  const { data } = await supa.from("dropship_session").select("cookies").eq("id", 1).maybeSingle();
  const items = data?.cookies;
  // a manually seeded session may be a plain {name: value} object for dsm.commercehub.com
  if (items && !Array.isArray(items)) return new Jar(Object.entries(items).map(([name, value]) => ({ name, value: String(value), domain: "dsm.commercehub.com", path: "/" })));
  return items?.length ? new Jar(items) : null;
}

// Runs fn with a live client. On an expired/missing session, logs in over HTTP once and retries.
async function withClient<T>(fn: (c: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
  let jar = await loadJar();
  if (jar) {
    try { const c = makeClient(jar); await c.keepAlive(); const out = await fn(c); await saveJar(jar, "ok"); return out; }
    catch (e) { if (!(e instanceof SessionExpired)) throw e; }
  }
  const email = Deno.env.get("ORDERSTREAM_EMAIL"), pw = Deno.env.get("ORDERSTREAM_PASSWORD");
  if (!email || !pw) throw new Error("NEEDS_LOGIN: session expired and ORDERSTREAM_EMAIL / ORDERSTREAM_PASSWORD secrets are not set");
  try {
    const r = await httpLogin(email, pw);
    jar = r.jar;
    const c = makeClient(jar); await c.keepAlive();
    const out = await fn(c); await saveJar(jar, "logged in " + new Date().toISOString()); return out;
  } catch (e) {
    const t = (e as any).trace ? " | steps: " + (e as any).trace.join("; ") : "";
    throw new Error("NEEDS_LOGIN: automatic login failed: " + (e as Error).message + t);
  }
}

async function doSync() {
  const orders = await withClient(async (c) => parseQuickShip(await c.quickShipOpen()));
  const rows = orders.map((o: any) => ({
    order_id: o.order_id, po_number: o.po_number, merchant: o.merchant,
    order_date: o.order_date ? o.order_date.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2") : null,
    ship_to: o.ship_to, items: o.items, problems: o.problems,
  }));
  let inserted = 0;
  if (rows.length) {
    const { data, error } = await supa.from("dropship_jobs").upsert(rows, { onConflict: "order_id", ignoreDuplicates: true }).select("order_id");
    if (error) throw new Error("insert: " + error.message);
    inserted = data?.length ?? 0;
  }
  await setStatus({ last_sync: new Date().toISOString(), session_ok: true, message: `${orders.length} open on OrderStream, ${inserted} new`, needs_login: false });
  return { seen: orders.length, inserted };
}

async function doRun(limit = 5) {
  if (await isPaused()) return { skipped: "automation is off" };
  const { data: jobs } = await supa.from("dropship_jobs").select("*").in("status", ["labeled", "shipped"]).eq("problems", "{}").order("first_seen_at").limit(limit);
  if (!jobs?.length) return { processed: 0 };
  const { data: run } = await supa.from("dropship_runs").insert({ live: true }).select().single();
  let processed = 0;
  const finish = (s: string) => supa.from("dropship_runs").update({ finished_at: new Date().toISOString(), summary: s }).eq("run_id", run.run_id);
  const patch = (id: string, b: Record<string, unknown>) => supa.from("dropship_jobs").update({ ...b, updated_at: new Date().toISOString() }).eq("order_id", id);
  try {
    await withClient(async (c) => {
      for (const job of jobs) {
        const step = job.status === "labeled" ? "ship" : "invoice";
        const log = (outcome: string, extra: Record<string, unknown> = {}) => supa.from("dropship_events").insert({
          run_id: run.run_id, order_id: job.order_id, po_number: job.po_number, step, outcome,
          page_url: c.audit.pageUrl, request: c.audit.post?.fields ?? null, response_status: c.audit.post?.status,
          response_location: c.audit.post?.location, response_excerpt: c.audit.post?.excerpt, ...extra });
        c.audit.post = null;
        try {
          const r = await (step === "ship" ? shipOrder : invoiceOrder)(c, job, { dry: false });
          await log(r.skipped ? "skipped" : "ok", { invoice_number: r.invoice_number });
          const now = new Date().toISOString();
          await patch(job.order_id, step === "ship"
            ? { status: "shipped", last_step: "ship", last_step_at: now, error: null }
            : { status: "invoiced", invoice_number: r.invoice_number ?? job.invoice_number, last_step: "invoice", last_step_at: now, error: null });
          processed++;
        } catch (e) {
          if (e instanceof SessionExpired) throw e;
          await log("error", { response_excerpt: (e as Error).message.slice(0, 600) });
          await patch(job.order_id, { prev_status: job.status, status: "error", last_step: step, error: `${step}: ${(e as Error).message}` });
          throw new Error(`stopped at order ${job.order_id} ${step}: ${(e as Error).message}`); // stop on first error
        }
      }
    });
    await finish(`${processed} step(s) done`);
    return { processed };
  } catch (e) { await finish("stopped: " + (e as Error).message.slice(0, 200)); throw e; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sent = req.headers.get("x-cron-secret");
    let isCron = false;
    if (sent) {
      const { data: row } = await supa.from("dropship_session").select("cookies").eq("id", 2).maybeSingle();
      isCron = typeof row?.cookies === "string" && row.cookies === sent;
    }
    if (!isCron) {
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const { data, error } = await supa.auth.getUser(tok);
      if (error || !data?.user) return json({ error: "sign in required" }, 401);
    }
    const { action = "status", limit } = await req.json().catch(() => ({}));
    if (action === "status") {
      const { data } = await supa.from("dropship_settings").select("*").in("key", ["paused", "bridge_status"]);
      return json({ settings: data });
    }
    try {
      if (action === "sync") return json(await doSync());
      if (action === "run") return json(await doRun(limit));
      if (action === "check") { const s = await doSync(); const r = await doRun(limit); return json({ ...s, run: r }); }
      return json({ error: "unknown action" }, 400);
    } catch (e) {
      const m = (e as Error).message;
      await setStatus({ at: new Date().toISOString(), message: m.slice(0, 500), needs_login: m.startsWith("NEEDS_LOGIN"), session_ok: !m.startsWith("NEEDS_LOGIN") });
      return json({ error: m }, 500);
    }
  } catch (e) { return json({ error: (e as Error).message }, 500); }
});
