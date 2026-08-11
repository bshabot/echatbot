// src/components/QbSyncJobWidget.jsx
//
// Floating "process view" for bulk QuickBooks sales-order syncs. Mounted once
// in App.jsx, outside <Routes>, so it stays on screen across page navigation
// while a Purchase Orders bulk create/update send is running — and survives
// long enough after a Stop/finish to show the outcome.
//
// The running work itself lives in qbSalesOrders.js / qbSyncStatus.js and
// keeps executing regardless of what's mounted; this component only reflects
// the shared QbSyncJobStore and offers Stop / Resume / dismiss.
import React, { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Landmark, X } from "lucide-react";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";

function summaryLine(job) {
  const s = job.summary;
  if (!s) return "";
  if (job.mode === "create") {
    return `${s.created?.length || 0} created, ${s.existed?.length || 0} already existed, ${s.failed?.length || 0} failed.`;
  }
  return `${s.updated?.length || 0} updated, ${s.failed?.length || 0} failed.`;
}

export default function QbSyncJobWidget() {
  const job = useQbSyncJobStore((s) => s.job);
  const requestCancel = useQbSyncJobStore((s) => s.requestCancel);
  const clearJob = useQbSyncJobStore((s) => s.clearJob);
  const checkInterrupted = useQbSyncJobStore((s) => s.checkInterrupted);
  const navigate = useNavigate();
  const location = useLocation();

  // Runs once, on app load. A job that rehydrated as "running" has no live
  // worker behind it — flip it to "interrupted" so Resume shows instead of a
  // progress bar that will never move again.
  useEffect(() => {
    checkInterrupted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!job) return null;

  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const onPoPage = location.pathname === "/purchase-orders";

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-80 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b bg-[#faf6ef] flex items-center gap-2">
        <Landmark className="w-3.5 h-3.5 text-[#C5A572] flex-shrink-0" />
        <span className="text-xs font-medium text-gray-800 flex-1 truncate" title={job.label}>
          {job.label}
        </span>
        {job.status !== "running" && (
          <button onClick={clearJob} className="text-gray-400 hover:text-gray-600" title="Dismiss">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="px-3 py-2.5">
        {job.status === "running" && (
          <>
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span className="truncate">{job.phase}</span>
              <span className="flex-shrink-0 ml-2">
                {job.done}/{job.total}
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded overflow-hidden mb-2">
              <div className="h-full bg-[#C5A572] transition-all" style={{ width: `${pct}%` }} />
            </div>
            <button
              onClick={requestCancel}
              disabled={job.cancelRequested}
              className="w-full text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {job.cancelRequested ? "Stopping after current record(s)…" : "Stop"}
            </button>
          </>
        )}

        {job.status === "interrupted" && (
          <>
            <p className="text-xs text-amber-700 mb-2">
              Interrupted at {job.done}/{job.total}. Nothing already synced was lost — resume on
              the Purchase Orders page to finish the rest.
            </p>
            {onPoPage ? (
              <p className="text-[11px] text-gray-500">Use the Resume banner above the table.</p>
            ) : (
              <button
                onClick={() => navigate("/purchase-orders")}
                className="w-full text-xs px-2 py-1 rounded bg-[#C5A572] text-white hover:bg-[#B89660]"
              >
                Go to Purchase Orders
              </button>
            )}
          </>
        )}

        {job.status === "cancelled" && (
          <p className="text-xs text-gray-600">
            Stopped at {job.done}/{job.total}. {summaryLine(job)}{" "}
            {!onPoPage && (
              <button onClick={() => navigate("/purchase-orders")} className="text-blue-600 hover:underline">
                Resume on Purchase Orders
              </button>
            )}
          </p>
        )}

        {job.status === "done" && (
          <p className="text-xs text-gray-600">
            Finished — {job.done}/{job.total} processed. {summaryLine(job)}
          </p>
        )}

        {job.status === "error" && (
          <p className="text-xs text-red-700">Sync hit an error and stopped. Check the Settings log for details.</p>
        )}
      </div>
    </div>
  );
}
