// src/utils/logEvent.js
//
// One place to record a PLM activity-log entry into the `sync_logs` table. Any
// subsystem (QB sync, scrapers, imports, manual actions) can call this to leave
// an error / success / info record. Best-effort: logging must never be what
// breaks the action being logged, so it swallows its own failures.

const LEVELS = new Set(["error", "success", "info"]);

/**
 * Insert one row into sync_logs. Returns true if written, false otherwise.
 * Never throws.
 *
 *   logEvent(supabase, {
 *     level,     // 'error' | 'success' | 'info'  (defaults to 'info')
 *     source,    // subsystem, e.g. 'qb-sales-order', 'scraper', 'po-import'
 *     action,    // e.g. 'create' | 'update' | 'memo-sync'
 *     message,   // human-readable one-liner
 *     details,   // any JSON-serializable context object
 *     poNumber,  // optional convenience filter
 *     userId,    // optional — auth.users.id of whoever triggered this (see
 *                // qbSyncStatus.js's trackQbProcess, which fills this in
 *                // automatically for every QB operation via the session)
 *     userEmail, // optional — denormalized alongside userId so SyncLogsCard
 *                // can show/filter by who without joining auth.users
 *   })
 */
export async function logEvent(
  supabase,
  { level = "info", source, action, message, details, poNumber, userId, userEmail } = {}
) {
  if (!supabase) return false;
  const lvl = LEVELS.has(level) ? level : "info";
  try {
    const { error } = await supabase.from("sync_logs").insert({
      level: lvl,
      source: source ?? null,
      action: action ?? null,
      message: message ?? null,
      details: details ?? null,
      po_number: poNumber ?? null,
      user_id: userId ?? null,
      user_email: userEmail ?? null,
    });
    if (error) {
      console.warn("[sync_logs] logEvent insert error", error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[sync_logs] logEvent failed", e);
    return false;
  }
}

/** Level-specific convenience wrappers. */
export const logError = (supabase, o) => logEvent(supabase, { ...o, level: "error" });
export const logSuccess = (supabase, o) => logEvent(supabase, { ...o, level: "success" });
export const logInfo = (supabase, o) => logEvent(supabase, { ...o, level: "info" });
