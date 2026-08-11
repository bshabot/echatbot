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

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Keep at most this many process entries (running + history) so localStorage
// doesn't grow unbounded across a long session of repeated syncs.
const MAX_PROCESSES = 25;

function newProcessId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
       * batch send types). Returns the new process's id.
       */
      startProcess: ({ type, label, total = 0, poIds = [] }) => {
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
          finishedAt: null,
          summary: null,
        };
        set({ processes: [proc, ...get().processes].slice(0, MAX_PROCESSES) });
        return id;
      },

      updateProcess: (id, { done, total, phase } = {}) => {
        set({
          processes: get().processes.map((p) =>
            p.id === id && p.status === "running"
              ? { ...p, done: done ?? p.done, total: total ?? p.total, phase: phase ?? p.phase }
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
            const finalStatus = p.cancelRequested ? "cancelled" : status;
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

      // Called once, by the widget, on app mount. Any process left "running"
      // from a prior load has no live worker anymore — the reload killed it.
      checkInterrupted: () => {
        set({
          processes: get().processes.map((p) =>
            p.status === "running"
              ? { ...p, status: "interrupted", phase: "Interrupted — page was reloaded or closed" }
              : p
          ),
        });
      },
    }),
    {
      name: "qb-sync-job-storage",
    }
  )
);
