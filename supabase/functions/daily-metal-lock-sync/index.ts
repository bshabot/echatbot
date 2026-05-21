// Supabase Edge Function: daily-metal-lock-sync
//
// Fetches London-fix gold + silver prices directly from LBMA's public JSON
// feeds (the official source Signet's portal mirrors) and upserts into
// metal_lock_history. Scheduled via pg_cron to run daily.
//
// Sources (free, no auth):
//   https://prices.lbma.org.uk/json/silver.json
//   https://prices.lbma.org.uk/json/gold_pm.json
// Each returns: [{ d: "2026-05-20", v: [USD, EUR, GBP], is_cms_locked: 0 }, ...]
// We use v[0] (USD).
//
// Auto-injected secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:
//   supabase functions deploy daily-metal-lock-sync
//
// Manual test:
//   curl -X POST -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
//     https://ujwdpieleyuaiammaopj.supabase.co/functions/v1/daily-metal-lock-sync

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface LbmaRow {
  d: string; // ISO date
  v: number[]; // [USD, EUR, GBP]
  is_cms_locked: number;
}

interface LockRow {
  date: string;
  silver_lock: number | null;
  gold_lock: number | null;
  source: string;
}

async function fetchLbmaJson(metal: "silver" | "gold_pm"): Promise<LbmaRow[]> {
  const res = await fetch(`https://prices.lbma.org.uk/json/${metal}.json`, {
    headers: { Accept: "application/json", "User-Agent": "echabot-plm" },
  });
  if (!res.ok) throw new Error(`LBMA ${metal} returned HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`LBMA ${metal} returned non-array`);
  return data;
}

function mergeBands(silver: LbmaRow[], gold: LbmaRow[], days = 30): LockRow[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Map by date
  const byDate = new Map<string, LockRow>();
  for (const r of silver) {
    if (r.d < cutoffIso) continue;
    byDate.set(r.d, {
      date: r.d,
      silver_lock: r.v[0] ?? null,
      gold_lock: null,
      source: "lbma",
    });
  }
  for (const r of gold) {
    if (r.d < cutoffIso) continue;
    const existing = byDate.get(r.d);
    if (existing) existing.gold_lock = r.v[0] ?? null;
    else byDate.set(r.d, { date: r.d, silver_lock: null, gold_lock: r.v[0] ?? null, source: "lbma" });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Forward-fill every calendar date in [start, end] using the most recent prior
// row from `rows`. Matches how Signet's portal shows weekends/holidays — they
// carry forward Friday's (or last trading day's) lock onto Saturday, Sunday,
// and any non-trading holidays.
function forwardFill(rows: LockRow[], startIso: string, endIso: string): LockRow[] {
  const byDate = new Map<string, LockRow>(rows.map((r) => [r.date, r]));
  const out: LockRow[] = [];
  let last: LockRow | null = null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const exact = byDate.get(iso);
    if (exact) {
      last = exact;
      out.push(exact);
    } else if (last) {
      // Forward-fill from the most recent known lock
      out.push({
        date: iso,
        silver_lock: last.silver_lock,
        gold_lock: last.gold_lock,
        source: "lbma",
      });
    }
  }
  return out;
}

Deno.serve(async (_req) => {
  const startedAt = new Date().toISOString();
  try {
    const [silver, goldPm] = await Promise.all([
      fetchLbmaJson("silver"),
      fetchLbmaJson("gold_pm"),
    ]);

    // Build rows from LBMA, then forward-fill weekends/holidays so every
    // calendar day has a row (matches how Signet's portal displays it).
    const rawRows = mergeBands(silver, goldPm, 30);
    if (rawRows.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "No rows from LBMA in last 30d", startedAt }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    const startIso = rawRows[0].date;
    const endIso = new Date().toISOString().slice(0, 10);
    const rows = forwardFill(rawRows, startIso, endIso);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const { error } = await sb
      .from("metal_lock_history")
      .upsert(rows, { onConflict: "date" });
    if (error) throw error;

    const latest = rows[rows.length - 1];
    return new Response(
      JSON.stringify({
        ok: true,
        startedAt,
        upserted: rows.length,
        rawFromLbma: rawRows.length,
        forwardFilled: rows.length - rawRows.length,
        latestDate: latest.date,
        latestSilver: latest.silver_lock,
        latestGold: latest.gold_lock,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err);
    console.error("daily-metal-lock-sync failed:", msg, err);
    return new Response(
      JSON.stringify({ ok: false, error: msg, raw: err, startedAt }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
});
