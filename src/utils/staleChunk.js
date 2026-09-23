// ── Stale build recovery (9/22/26) ──────────────────────────────────────────
// A tab left open across a Netlify deploy still references the OLD build's
// hashed chunk names (e.g. assets/jspdf.es.min-C_TOUXmz.js). Those files are
// gone, and the SPA catch-all answers with index.html at status 200 — so the
// browser rejects it on MIME type and the dynamic import fails with
// "Failed to fetch dynamically imported module". Nothing is broken; the page
// is just out of date. Reload it and the new build loads clean.
//
// Guarded two ways:
//  • once per cooldown, so a genuinely missing chunk can't loop the page
//  • never while a critical operation is in flight (see holdReload) — a
//    reload mid-UPS-call would wipe an on-screen result we can't get back

const KEY = "plm:stale-chunk-reload-at";
const COOLDOWN_MS = 30000;

let holds = 0;

/**
 * Block auto-reload for the duration of an operation that must not lose its
 * on-screen result. Returns the release function — always call it in finally.
 *
 *   const release = holdReload();
 *   try { ...create labels... } finally { release(); }
 */
export function holdReload() {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
  };
}

const PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i,
  // Netlify's SPA fallback answers a missing chunk with index.html (200), so
  // the browser rejects it on MIME type. Chrome and Firefox word it differently.
  /Expected a JavaScript module script/i,
  /is not a valid JavaScript MIME type/i,
];

export function isStaleChunkError(value) {
  const msg =
    typeof value === "string" ? value : String(value?.message ?? value ?? "");
  return PATTERNS.some((re) => re.test(msg));
}

function reloadOnce() {
  if (holds > 0) return false; // mid-operation — let the caller handle it
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    // private mode / storage blocked — fall through, the reload still helps
  }
  if (Date.now() - last < COOLDOWN_MS) return false; // already tried
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

export function installStaleChunkReload() {
  // Vite dispatches this when a lazily-imported chunk can't be preloaded.
  window.addEventListener("vite:preloadError", (e) => {
    if (reloadOnce()) e.preventDefault();
  });

  // The import itself can also reject on its own (the MIME-type case above),
  // which surfaces as an unhandled rejection rather than a preload error.
  window.addEventListener("unhandledrejection", (e) => {
    if (isStaleChunkError(e.reason) && reloadOnce()) e.preventDefault();
  });

  window.addEventListener("error", (e) => {
    if (isStaleChunkError(e.message || e.error)) reloadOnce();
  });
}
