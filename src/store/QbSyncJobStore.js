// src/store/QbSyncJobStore.js
//
// Global QuickBooks bulk-sync job tracker. Lifted out of PurchaseOrders.jsx so
// a bulk create/update run keeps going — and stays visible — no matter which
// page is on screen. App.jsx mounts <QbSyncJobWidget /> outside <Routes>, so
// it never unmounts on in-app navigation.
//
// Why this works: once sendPreparedSalesOrderCreates/Updates (qbSalesOrders.js)
// starts, its `await`s keep running in the JS event loop even after the page
// that triggered it unmounts — React unmounting a component does not cancel
// an in-flight async function closure. persistSyncResult() already writes
// each record's outcome straight to Supabase (qb_* columns + sync_logs) the
// moment it settles, so the *durable* truth never depends on this store —
// this only makes the *in-progress* view (and the Stop button) reachable from
// anywhere while it's running.
//
// A real page reload (not SPA navigation) does kill the running JS, though.
// If this store rehydrates from localStorage with a job stuck at
// status:"running", there's no live worker behind it — checkInterrupted()
// flips it to "interrupted" so the UI offers Resume instead of a frozen bar.
// Resume re-selects the job's PO ids and re-runs the normal prepare→review→
// send flow, which already skips anything that finished before the
// interruption (existence/diff checks against live QuickBooks + qb_so_status).

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useQbSyncJobStore = create(
  persist(
    (set, get) => ({
      job: null,

      /**
       * Start tracking a batch. mode: 'create' | 'update'. poIds: the PO ids
       * included in this send (used for Resume). label: short text for the
       * widget header.
       */
      startJob: ({ mode, poIds, label }) => {
        set({
          job: {
            mode,
            poIds: poIds || [],
            label:
              label ||
              (mode === "create" ? "Creating sales orders in QuickBooks" : "Updating sales orders in QuickBooks"),
            total: (poIds || []).length,
            done: 0,
            phase: "Starting…",
            status: "running",
            cancelRequested: false,
            startedAt: Date.now(),
            finishedAt: null,
            summary: null,
          },
        });
      },

      setProgress: (done, total, phase) => {
        const job = get().job;
        if (!job || job.status !== "running") return;
        set({ job: { ...job, done, total: total ?? job.total, phase: phase ?? job.phase } });
      },

      // Checked by runPool (qbSyncStatus.js) before dispatching each new item.
      // Halts new work; whatever's already in flight finishes and persists
      // normally — safe because every result is saved the moment it settles.
      requestCancel: () => {
        const job = get().job;
        if (!job || job.status !== "running") return;
        set({ job: { ...job, cancelRequested: true, phase: "Stopping after current record(s)…" } });
      },

      shouldCancel: () => !!get().job?.cancelRequested,

      finishJob: (summary, status = "done") => {
        const job = get().job;
        if (!job) return;
        const finalStatus = job.cancelRequested ? "cancelled" : status;
        set({
          job: {
            ...job,
            status: finalStatus,
            phase: finalStatus === "cancelled" ? "Stopped" : finalStatus === "error" ? "Failed" : "Done",
            finishedAt: Date.now(),
            summary: summary || null,
          },
        });
      },

      clearJob: () => set({ job: null }),

      // Called once, by the widget, on app mount. A job left "running" from a
      // prior load has no live worker anymore — the reload killed it.
      checkInterrupted: () => {
        const job = get().job;
        if (job && job.status === "running") {
          set({
            job: { ...job, status: "interrupted", phase: "Interrupted — page was reloaded or closed" },
          });
        }
      },
    }),
    {
      name: "qb-sync-job-storage",
    }
  )
);
