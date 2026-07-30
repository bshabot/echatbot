// ── Live UPS status (7/30/26) ───────────────────────────────────────────────
// Source of truth = public.ups_tracking_status, filled by the ups-track edge
// function (pg_cron every 4h at :17 + on-demand invoke). This module is
// React-free: fetch → Map, split multi-number fields, and turn a status row
// into chip meta ({cls,label,title}) for the Shipments page to render.
// POD side effect lives server-side: fill_pod_from_ups() null-fills
// outbound_batches.pod_at/pod_ref — nothing here writes to any table.

// out_tracking / per_box_tracking / master_tracking may hold several numbers
// separated by commas or whitespace. Only UPS 1Z numbers get live status.
export function splitTrackings(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => /^1Z[A-Z0-9]{16}$/.test(t));
}

// All rows (the table only ever holds ~120 days of numbers, so grab it whole).
// Returns Map<TRACKING, row> or null on error (callers just skip chips).
export async function fetchUpsStatuses(supabase) {
  const { data, error } = await supabase
    .from("ups_tracking_status")
    .select(
      "tracking,status,description,delivered_at,signed_by,delivery_location,last_event,last_location,last_event_at,scheduled_delivery"
    )
    .limit(2000);
  if (error) {
    console.error("ups statuses:", error.message);
    return null;
  }
  return new Map((data || []).map((r) => [String(r.tracking).trim().toUpperCase(), r]));
}

// On-demand refresh. No args = everything pending (the function pulls the
// list itself via get_pending_trackings); pass trackingNumbers for one row.
export async function refreshUpsTracking(supabase, trackingNumbers) {
  const { data, error } = await supabase.functions.invoke("ups-track", {
    body: trackingNumbers?.length ? { trackingNumbers } : {},
  });
  if (error) throw new Error(error.message || "ups-track failed");
  if (data?.error) throw new Error(data.error);
  return data || { checked: 0, delivered: 0, pod_filled: 0 };
}

// M/D — date-only strings stay calendar-true (no TZ shift), timestamps go local.
export function fmtShort(v) {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const p = s.split("-");
    return `${Number(p[1])}/${Number(p[2])}`;
  }
  const d = new Date(s);
  return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtWhen(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d)
    ? ""
    : d.toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const BAD = /exception|error|not found|return|void/i;

// One status row → chip meta. Green delivered, amber trouble, blue moving.
export function upsChipMeta(s) {
  const status = s.status || "Unknown";
  const trail =
    [s.last_event, s.last_location, fmtWhen(s.last_event_at)].filter(Boolean).join(" — ") || status;
  if (status === "Delivered") {
    return {
      cls: "bg-green-100 text-green-700 border-green-300",
      label: `Delivered ${fmtShort(s.delivered_at)}${s.signed_by ? " · " + s.signed_by : ""}`,
      title: s.delivery_location ? `${s.delivery_location} — ${trail}` : trail,
    };
  }
  if (BAD.test(status)) {
    return {
      cls: "bg-amber-100 text-amber-700 border-amber-300",
      label: status,
      title: s.description ? `${s.description}${trail !== status ? " — " + trail : ""}` : trail,
    };
  }
  return {
    cls: "bg-blue-100 text-blue-700 border-blue-300",
    label: s.scheduled_delivery ? `${status} · due ${fmtShort(s.scheduled_delivery)}` : status,
    title: trail,
  };
}

// Whole-batch rollup for the Shipped batches strip: master + every per-box
// number, deduped. All delivered → green with the LAST delivery + a signer;
// any trouble → amber; otherwise n/N + earliest due. null = no UPS data
// (EFW freight etc — caller can fall back to pod_at).
export function batchDelivery(b, upsMap) {
  if (!upsMap || upsMap.size === 0) return null;
  const nums = [
    ...new Set([b.master_tracking, ...(b.boxes || []).map((x) => x.tracking)].flatMap(splitTrackings)),
  ];
  const sts = nums.map((n) => upsMap.get(n)).filter(Boolean);
  if (!sts.length) return null;
  const delivered = sts.filter((s) => s.status === "Delivered");
  if (delivered.length === sts.length) {
    const last = delivered.map((s) => s.delivered_at).filter(Boolean).sort().slice(-1)[0];
    const signer = delivered.find((s) => s.signed_by)?.signed_by;
    return {
      cls: "bg-green-100 text-green-700 border-green-300",
      label: `Delivered ${fmtShort(last)}${signer ? " · " + signer : ""}`,
    };
  }
  const bad = sts.find((s) => BAD.test(s.status || ""));
  if (bad) {
    return { cls: "bg-amber-100 text-amber-700 border-amber-300", label: bad.status };
  }
  const due = sts.map((s) => s.scheduled_delivery).filter(Boolean).sort()[0];
  return {
    cls: "bg-blue-100 text-blue-700 border-blue-300",
    label: `${delivered.length}/${sts.length} delivered${due ? " · due " + fmtShort(due) : ""}`,
  };
}
