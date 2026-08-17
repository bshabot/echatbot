// src/store/QbSyncJobStore.js
//
// Global QuickBooks process tracker. EVERY QuickBooks operation — checking
// existence, creating, updating, the memo/PO sync — reports in here via
// qbSyncStatus.js's trackQbProcess(), not just the bulk create/update send.
// Nothing about a QB operation's progress lives in page-local state anymore;
// a page only reads this store (and, for review flows, holds the payloads
// waiting on a human decision — see PurchaseOrders.jsx's qbPreview, which is
// UI state, not a "process").
//
// App.jsx mounts <QbSyncJobWidget /> outside <Routes>, so it never unmounts
// on in-app navigation — whatever's running here stays visible everywhere.
//
// Why this works: once a QB operation (qbSalesOrders.js / qbPoImport.js)
// starts, its `await`s keep running in the JS event loop even after the page
// that triggered it unmounts — React unmounting a component does not cancel
// an in-flight async function closure. persistSyncResult() (qbSyncStatus.js)
// already writes each record's outcome straight to Supabase (qb_* columns +
// sync_logs) the moment it settles, so the *durable* truth never depends on
// this store — this only makes the *in-progress* view (and Stop) reachable
// from anywhere, and gives every process a paired start/finish sync_logs row.
//
// A real page reload (not SPA navigation) does kill the running JS, though.
// If this store rehydrates from localStorage with a process stuck at
// status:"running", there's no live worker behind it — checkInterrupted()
// flips it to "interrupted" so the UI offers Resume instead of a frozen bar
// (resume only really applies to the batch create/update types; other
// process types just get dismissed).
//
// Kevin 8/13: "make the process store by user not global." The underlying
// data here is still ONE array/localStorage key per browser — that part
// didn't change. What changed: every process is stamped with `userId` /
// `userEmail` (whoever was signed in when trackQbProcess started it — see
// qbSyncStatus.js), and QbSyncJobWidget.jsx filters the array down to "mine
// (+ anything unattributed)" before rendering. That's what makes two people
// sharing one computer/browser each see only their own QB activity instead
// of a mixed feed — filtering on display, not a separate store per user.

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Keep at most this many process entries (running + history) so localStorage
// doesn't grow unbounded across a long session of repeated syncs.
const MAX_PROCESSES = 25;

function newProcessId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A5 — a running process whose last heartbeat is younger than this is
 * assumed to have a live worker behind it (progress ticks on every record).
 * Older than this and it's a leftover from a page that was killed.
 */
const LIVE_HEARTBEAT_MS = 90000;

/** B2 — drop an initiator payload too big to be worth persisting. */
const MAX_INITIATOR_CHARS = 20000;
function capInitiator(initiator) {
  if (!initiator || typeof initiator !== "object") return null;
  try {
    const json = JSON.stringify(initiator);
    if (json.length <= MAX_INITIATOR_CHARS) return initiator;
    return { _truncated: true, _bytes: json.length };
  } catch {
    return null;
  }
}

export const useQbSyncJobStore = create(
  persist(
    (set, get) => ({
      processes: [],

      /**
       * Start tracking one QB operation. type: 'create-prepare' |
       * 'create-send' | 'update-prepare' | 'update-send' | 'so-update' |
       * 'memo-sync' (extend freely — the widget renders unknown types with
       * a generic label). poIds: PO ids involved (used for Resume on the
       * batch send types).
       *
       * Two different mechanisms both drive Retry, for two different
       * failure shapes:
       *   - `retry` (optional) — a zero-arg function that re-runs this exact
       *     operation, closing over its original arguments. Only works
       *     within the SAME browser tab/JS context: it's a live closure, not
       *     data, so it CANNOT survive persistence (JSON.stringify silently
       *     drops function-valued properties) — it just won't be there after
       *     a real reload, same as every other "no live worker anymore" case
       *     checkInterrupted() already handles. Covers Retry on
       *     cancelled/error cards.
       *   - `initiator` (optional) — a plain-data object holding exactly the
       *     arguments this operation needs to be re-run (e.g. `{ samples }`,
       *     `{ rows }`, `{ costView }`) — NOT settings/vendors/supabase,
       *     which are always available live and are pulled fresh at retry
       *     time instead of frozen into a stale snapshot. Because it's plain
       *     JSON, it DOES survive the persist round-trip, so it's what makes
       *     Retry possible on "interrupted" cards too — see
       *     qbRetryRegistry.js, which turns `{ type, initiator }` back into
       *     a real call.
       * Both are deliberately omitted for the multi-phase sales-order send
       * flows (create-send/update-send/so-update) — replaying a stale
       * `prepared` payload could re-send an already-created sales order.
       * Those keep routing through the Purchase Orders resume flow, which
       * re-checks live QuickBooks state before resending.
       *
       * `userId` / `userEmail` (optional) — whoever's signed in right now
       * (qbSyncStatus.js's trackQbProcess fills these in automatically off
       * the Supabase session; nothing else needs to pass them). Plain data,
       * so — like `initiator` — it survives the persist round-trip. This is
       * what QbSyncJobWidget.jsx filters on to show each person only their
       * own activity. Null for anything unauthenticated (a scheduled job)
       * or logged before this field existed — those show to everyone rather
       * than vanish, since there's no "owner" to hide them from.
       * Returns the new process's id.
       */
      startProcess: ({
        type,
        label,
        total = 0,
        poIds = [],
        retry = null,
        initiator = null,
        userId = null,
        userEmail = null,
      }) => {
        const id = newProcessId();
        const proc = {
          id,
          type,
          label: label || type,
          poIds: poIds || [],
          total,
          done: 0,
          phase: "Starting…",
          status: "running",
          cancelRequested: false,
          startedAt: Date.now(),
          lastBeatAt: Date.now(), // A5 — cross-tab proof of life
          finishedAt: null,
          summary: null,
          retry: typeof retry === "function" ? retry : null,
          initiator: initiator && typeof initiator === "object" ? initiator : null,
          userId: userId || null,
          userEmail: userEmail || null,
        };
        set({ processes: [proc, ...get().processes].slice(0, MAX_PROCESSES) });
        return id;
      },

      updateProcess: (id, { done, total, phase } = {}) => {
        set({
          processes: get().processes.map((p) =>
            p.id === id && p.status === "running"
              ? {
                  ...p,
                  done: done ?? p.done,
                  total: total ?? p.total,
                  phase: phase ?? p.phase,
                  // A5 — proof of life. Another TAB reading this store out of
                  // localStorage can't see our closures, only this timestamp.
                  lastBeatAt: Date.now(),
                }
              : p
          ),
        });
      },

      // Checked between dispatches by runPool / prepare loops. Halts new
      // work; whatever's already in flight finishes and persists normally —
      // safe because every result is saved the moment it settles.
      requestCancel: (id) => {
        set({
          processes: get().processes.map((p) =>
            p.id === id && p.status === "running"
              ? { ...p, cancelRequested: true, phase: "Stopping after current record(s)…" }
              : p
          ),
        });
      },

      shouldCancel: (id) => !!get().processes.find((p) => p.id === id)?.cancelRequested,

      finishProcess: (id, { status = "done", summary = null } = {}) => {
        set({
          processes: get().processes.map((p) => {
            if (p.id !== id) return p;
            // B4 — cancelRequested used to win outright, so pressing Stop as
            // the last record finished labelled a 100%-complete run
            // "cancelled". Trust the caller's status: summarize() already
            // decides "cancelled" when the pool actually stopped early. Only
            // fall back to the flag when the caller has no opinion.
            const finalStatus =
              status && status !== "done"
                ? status
                : p.cancelRequested && (p.total ? p.done < p.total : true)
                  ? "cancelled"
                  : status;
            return {
              ...p,
              status: finalStatus,
              phase: finalStatus === "cancelled" ? "Stopped" : finalStatus === "error" ? "Failed" : "Done",
              finishedAt: Date.now(),
              summary,
            };
          }),
        });
      },

      dismissProcess: (id) => set({ processes: get().processes.filter((p) => p.id !== id) }),

      clearFinished: () => set({ processes: get().processes.filter((p) => p.status === "running") }),

      // Called once, by the widget, on app mount. A process left "running"
      // from a prior load usually has no live worker anymore — the reload
      // killed it.
      //
      // A5 — but "a prior load" and "another tab, right now" look identical
      // through localStorage. Tab 2 opening mid-batch used to flip tab A's
      // genuinely-running job to "interrupted" and offer Resume, which is a
      // direct path to sending everything twice. A job whose heartbeat is
      // fresh belongs to a live worker somewhere — leave it alone.
      checkInterrupted: () => {
        const now = Date.now();
        set({
          processes: get().processes.map((p) => {
            if (p.status !== "running") return p;
            const beat = p.lastBeatAt || p.startedAt || 0;
            if (now - beat < LIVE_HEARTBEAT_MS) return p; // someone's on it
            return {
              ...p,
              status: "interrupted",
              phase: "Interrupted — page was reloaded or closed",
            };
          }),
        });
      },

      /** A5 — is any process of these types alive right now (this tab or another)? */
      hasLiveProcess: (types) => {
        const now = Date.now();
        const list = types ? [].concat(types) : null;
        return get().processes.some(
          (p) =>
            p.status === "running" &&
            (!list || list.includes(p.type)) &&
            now - (p.lastBeatAt || p.startedAt || 0) < LIVE_HEARTBEAT_MS
        );
      },
    }),
    {
      name: "qb-sync-job-storage",
      // B2 — never persist bulky payloads. `retry` is a closure (dropped by
      // JSON anyway); `initiator` is capped so one big batch can't push the
      // whole store past localStorage's ~5MB quota and start throwing on
      // every progress tick.
      partialize: (state) => ({
        processes: (state.processes || []).map((p) => ({
          ...p,
          retry: undefined,
          initiator: capInitiator(p.initiator),
        })),
      }),
    }
  )
);

/**
 * A5 — zustand's persist middleware writes to localStorage but never reads it
 * back when another tab writes. Without this, two tabs drift apart and each
 * believes the other's running job is dead. Cheap to wire: rehydrate on the
 * browser's own `storage` event.
 */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key === "qb-sync-job-storage") {
      try {
        useQbSyncJobStore.persist?.rehydrate?.();
      } catch {
        /* non-fatal */
      }
    }
  });
}
