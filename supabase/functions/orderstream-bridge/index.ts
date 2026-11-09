import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { Jar, makeClient, httpLogin, SessionExpired } from "./client.js";
import { parseQuickShip } from "./parse.js";
import { shipOrder, invoiceOrder, updateStock, addInventorySku, addFormInfo, addStock, gridRow } from "./os.js";

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
  if (items && !Array.isArray(items)) return new Jar(Object.entries(items).map(([name, value]) => ({ name, value: String(value), domain: "dsm.commercehub.com", path: "/" })));
  return items?.length ? new Jar(items) : null;
}

async function withClient<T>(fn: (c: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
  let jar = await loadJar();
  if (jar) {
    try { const c = makeClient(jar); await c.keepAlive(); const out = await fn(c); await saveJar(jar, "ok"); return out; }
    catch (e) { if (!(e instanceof SessionExpired)) throw e; }
  }
  const email = Deno.env.get("ORDERSTREAM_EMAIL"), pw = Deno.env.get("ORDERSTREAM_PASSWORD");
  if (!email || !pw) throw new Error("NEEDS_LOGIN: session expired and ORDERSTREAM_EMAIL / ORDERSTREAM_PASSWORD secrets are not set");
  let trace: string[] = [];
  try {
    const r = await httpLogin(email, pw);
    jar = r.jar; trace = r.trace;
    const c = makeClient(jar);
    const out = await fn(c); await saveJar(jar, "logged in " + new Date().toISOString()); return out;
  } catch (e) {
    const tr = (e as any).trace ?? trace;
    const t = tr?.length ? " | steps: " + tr.join("; ") : "";
    throw new Error("NEEDS_LOGIN: automatic login failed: " + (e as Error).message + t);
  }
}

async function doIntake(c: ReturnType<typeof makeClient>) {
  const sum = (await c.post("loadFileSummary.async", [])).text ?? "";
  const waiting = Number((sum.match(/gotoViewPackslips\.do[^>]*>\s*(\d+)/) || [])[1] ?? 0);
  if (!waiting) return { waiting: 0, downloaded: [] as string[] };
  const page = await c.get("gotoViewPackslips.do");
  const ids = [...new Set([...page.matchAll(/(\d{8,14})\.pdf/g)].map((m) => m[1]))];
  const downloaded: string[] = [];
  for (const id of ids) {
    const { data: seen } = await supa.from("dropship_files").select("file_id").eq("file_id", id).maybeSingle();
    if (seen) continue;
    const type = (await c.get(`getFileType.do?fileId=${id}`)).match(/"type"\s*:\s*"([^"]+)"/)?.[1] ?? "";
    if (type !== "PL_FILE") { await supa.from("dropship_files").insert({ file_id: id, file_name: `${id}.pdf`, file_type: type, note: "skipped: not a packing slip file" }); continue; }
    const r = await c.getBinary(`downloadFile.do?fileId=${id}&isLive=true`);
    const isPdf = r.bytes.length > 4 && String.fromCharCode(...r.bytes.slice(0, 4)) === "%PDF";
    await supa.from("dropship_files").insert({
      file_id: id, file_name: `${id}.pdf`, file_type: type, bytes: r.bytes.length, content_type: r.contentType,
      pdf_b64: isPdf ? encodeBase64(r.bytes) : null, note: isPdf ? "downloaded" : `unexpected download (HTTP ${r.status}, ${r.contentType})`,
    });
    downloaded.push(id);
  }
  return { waiting, downloaded };
}

// All Quick Ship open orders: the list is paged (10 per page), so read every page and merge.
async function readAllOpenOrders(c: ReturnType<typeof makeClient>) {
  const { pages, total } = await c.quickShipPages();
  const byId = new Map<string, any>();
  for (const html of pages) for (const o of parseQuickShip(html)) byId.set(o.order_id, o);
  if (total != null && byId.size !== total) throw new Error(`Quick Ship list says ${total} orders but only ${byId.size} were read; not syncing a partial list`);
  return [...byId.values()];
}

async function doSync() {
  let intake: { waiting: number; downloaded: string[] } = { waiting: 0, downloaded: [] };
  const orders = await withClient(async (c) => { intake = await doIntake(c); return readAllOpenOrders(c); });
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
  await setStatus({ last_sync: new Date().toISOString(), session_ok: true, message: `${orders.length} open on OrderStream, ${inserted} new${intake.downloaded.length ? `, downloaded ${intake.downloaded.length} packing slip(s)` : ""}`, needs_login: false });
  return { seen: orders.length, inserted, packingSlips: intake.downloaded.length };
}

async function doRun(limit = 5) {
  if (await isPaused()) return { skipped: "automation is off" };
  const { data: all } = await supa.from("dropship_jobs").select("*").in("status", ["labeled", "shipped", "invoiced"]).order("first_seen_at").limit(20);
  const jobs = (all ?? []).filter((j: any) => !j.problems || (Array.isArray(j.problems) ? j.problems.length === 0 : Object.keys(j.problems).length === 0)).slice(0, limit);
  if (!jobs.length) return { processed: 0 };
  const { data: run } = await supa.from("dropship_runs").insert({ live: true }).select().single();
  let processed = 0;
  const finish = (s: string) => supa.from("dropship_runs").update({ finished_at: new Date().toISOString(), summary: s }).eq("run_id", run.run_id);
  const patch = (id: string, b: Record<string, unknown>) => supa.from("dropship_jobs").update({ ...b, updated_at: new Date().toISOString() }).eq("order_id", id);
  try {
    await withClient(async (c) => {
      for (const job of jobs) {
        const step = job.status === "labeled" ? "ship" : job.status === "shipped" ? "invoice" : "stock";
        const log = (outcome: string, extra: Record<string, unknown> = {}) => supa.from("dropship_events").insert({
          run_id: run.run_id, order_id: job.order_id, po_number: job.po_number, step, outcome,
          page_url: c.audit.pageUrl, request: c.audit.post?.fields ?? null, response_status: c.audit.post?.status,
          response_location: c.audit.post?.location, response_excerpt: c.audit.post?.excerpt, ...extra });
        c.audit.post = null;
        try {
          const r: any = await (step === "ship" ? shipOrder : step === "invoice" ? invoiceOrder : updateStock)(c, job, { dry: false, onPlan: (p: unknown) => supa.from("dropship_jobs").update({ stock_plan: p }).eq("order_id", job.order_id) });
          await log(r.skipped ? "skipped" : "ok", { invoice_number: r.invoice_number });
          const now = new Date().toISOString();
          await patch(job.order_id, step === "ship"
            ? { status: "shipped", last_step: "ship", last_step_at: now, error: null }
            : step === "stock" ? { status: "done", last_step: "stock", last_step_at: now, stock_plan: r.plan ?? job.stock_plan, error: null }
            : { status: "invoiced", invoice_number: r.invoice_number ?? job.invoice_number, last_step: "invoice", last_step_at: now, error: null });
          processed++;
        } catch (e) {
          if (e instanceof SessionExpired) throw e;
          await log("error", { response_excerpt: (e as Error).message.slice(0, 600) });
          await patch(job.order_id, { prev_status: job.status, status: "error", last_step: step, error: `${step}: ${(e as Error).message}` });
          throw new Error(`stopped at order ${job.order_id} ${step}: ${(e as Error).message}`);
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
    const body = await req.json().catch(() => ({}));
    const { action = "status", limit } = body;
    if (action === "status") {
      const { data } = await supa.from("dropship_settings").select("*").in("key", ["paused", "bridge_status"]);
      return json({ settings: data });
    }
    try {
      if (action === "qsinfo") {
        return json(await withClient(async (c) => {
          const { pages, total } = await c.quickShipPages();
          const ids = new Set<string>();
          for (const h of pages) for (const o of parseQuickShip(h)) ids.add(o.order_id);
          return { reported_total: total, pages: pages.length, orders_read: ids.size };
        }));
      }
      if (action === "probe") {
        return json(await withClient(async (c) => {
          const html = await c.quickInvoiceOpen();
          const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
          return { url: c.audit.pageUrl, title: (html.match(/<title>([^<]*)/i) || [])[1] ?? null,
            orders: [...new Set([...html.matchAll(/order\((\d+)\)\.id/g)].map((m) => m[1]))],
            noOrders: /No order\(s\) found/i.test(html), hasAutoFill: /autofill/i.test(html), excerpt: text.slice(0, 400) };
        }));
      }
      if (action === "dry") {
        const { data: jobs } = await supa.from("dropship_jobs").select("*").in("status", ["labeled", "shipped", "invoiced"]).limit(limit ?? 5);
        return json(await withClient(async (c) => {
          const out: unknown[] = [];
          for (const job of jobs ?? []) {
            const step = job.status === "labeled" ? "ship" : job.status === "shipped" ? "invoice" : "stock";
            try { out.push({ order: job.order_id, step, result: await (step === "ship" ? shipOrder : step === "invoice" ? invoiceOrder : updateStock)(c, job, { dry: true }) }); }
            catch (e) { out.push({ order: job.order_id, step, error: (e as Error).message }); }
          }
          return out;
        }));
      }
      if (action === "stockdry") {
        return json(await withClient(async (c) => updateStock(c, { items: (body.skus ?? []).map((s: string) => ({ vendor_sku: s, qty: 1 })) }, { dry: true })));
      }
      if (action === "gridrow") return json(await withClient((c) => gridRow(c, String(body.sku ?? ""))));
      if (action === "addform") return json(await withClient((c) => addFormInfo(c)));
      if (action === "receive") {
        const items: any[] = body.items ?? [];
        if (!items.length || items.length > 60) return json({ error: "send 1-60 items" }, 400);
        return json(await withClient((c) => addStock(c, items, { dry: body.dry !== false, avail_date: body.avail_date })));
      }
      if (action === "addsku") {
        const items: any[] = body.items ?? [];
        if (!items.length || items.length > 30) return json({ error: "send 1-30 items" }, 400);
        return json(await withClient(async (c) => {
          const out: unknown[] = [];
          for (const it of items) {
            try { out.push({ vendor_sku: it.vendor_sku, result: await addInventorySku(c, it, { dry: body.dry !== false }) }); }
            catch (e) { out.push({ vendor_sku: it.vendor_sku, error: (e as Error).message }); if (!body.continueOnError) break; }
          }
          return out;
        }));
      }
      if (action === "sync") return json(await doSync());
      if (action === "run") return json(await doRun(limit));
      if (action === "check") { const s = await doSync(); const r = await doRun(limit); return json({ ...s, run: r }); }
      return json({ error: "unknown action" }, 400);
    } catch (e) {
      const m = (e as Error).message;
      await setStatus({ at: new Date().toISOString(), message: m.slice(0, 900), needs_login: m.startsWith("NEEDS_LOGIN"), session_ok: !m.startsWith("NEEDS_LOGIN") });
      return json({ error: m }, 500);
    }
  } catch (e) { return json({ error: (e as Error).message }, 500); }
});
