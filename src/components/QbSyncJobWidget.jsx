// src/components/QbSyncJobWidget.jsx
//
// Floating "process view" for QuickBooks operations. Mounted once in App.jsx,
// outside <Routes>, so it stays on screen across page navigation. EVERY QB
// operation — checking existence, creating, updating, memo/PO sync, the
// single-PO update in POLinesView — reports here via qbSyncStatus.js's
// trackQbProcess(), not just the bulk create/update send. Nothing about a QB
// operation's progress lives only on the page that started it.
//
// The running work itself lives in qbSalesOrders.js / qbPoImport.js and keeps
// executing regardless of what's mounted; this component only reflects the
// shared QbSyncJobStore and offers Stop / Resume / dismiss.
import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Landmark, RefreshCw, X } from "lucide-react";
import { useQbSyncJobStore } from "../store/QbSyncJobStore";
import { useSupabase } from "./SupaBaseProvider";
import { canReplayFromInitiator, replayFromInitiator } from "../utils/qbRetryRegistry";

// Batch types carry poIds and can be picked back up from Purchase Orders;
// everything else (memo-sync, po-sync) just gets retried by clicking the
// button again — same page, no id list to hand back.
const RESUMABLE_TYPES = new Set(["create-prepare", "create-send", "update-prepare", "update-send", "so-update"]);

// Where each non-resumable type's button actually lives, and what that
// button is actually labeled. This is the fallback for a type that has
// neither a live `retry` closure nor a stored `initiator` (see
// qbRetryRegistry.js) — in practice that's only a type nobody's wired up
// initiator-based retry for yet. `action` names the real button so the
// fallback text (shown when you're already on the right page, so there's
// nowhere to navigate to) can say exactly what to click instead of just
// "the button."
const TYPE_ROUTES = {
  "item-create": { path: "/samples", label: "Samples", action: "Create in QB" },
  "item-update": { path: "/samples", label: "Samples", action: "Update in QB" },
  "item-sync-single": { path: "/samples", label: "Samples", action: "Sync to QB" },
  "item-price-update": { path: "/factory-costs", label: "Factory Costs", action: "Update prices in QB" },
  "po-price-prepare": { path: "/factory-costs", label: "Factory Costs", action: "Update prices in QB" },
  "po-price-send": { path: "/factory-costs", label: "Factory Costs", action: "Update prices in QB" },
  "create-direct": { path: "/purchase-orders", label: "Purchase Orders", action: "Create in QB" },
  "memo-sync": { path: "/purchase-orders", label: "Purchase Orders", action: "Sync POs" },
  "po-sync": { path: "/purchase-orders", label: "Purchase Orders", action: "Sync POs" },
};

function summaryLine(p) {
  const s = p.summary;
  if (!s) return "";
  const bits = Object.entries(s)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${v} ${k}`);
  return bits.length ? bits.join(", ") + "." : "";
}

// Terminal states a card can auto-clear itself from. "interrupted" is
// deliberately excluded — that one needs the user to actually resume or
// retry, so it stays until dismissed by hand.
const AUTO_DISMISS_STATUSES = new Set(["done", "cancelled", "error"]);
const AUTO_DISMISS_MS = 10000;

// A card offers one-click Retry via one of two mechanisms:
//   - a live `retry` closure (see qbSyncStatus.js's trackQbProcess) — only
//     possible on "cancelled"/"error", both of which happen in the SAME
//     browser session the operation ran in, so the closure is still alive.
//   - a stored `initiator` (see qbRetryRegistry.js) — plain data, so unlike
//     `retry` it survives a reload, which is what makes Retry possible on
//     "interrupted" cards too (that status only exists because
//     checkInterrupted() flips a stranded "running" process on the NEXT page
//     load, by which point any `retry` closure from the previous JS context
//     is gone for good — `initiator` is not).
// A type with neither falls back to the "Go to <page>" / named-button text
// below (see TYPE_ROUTES).
function canRetry(p) {
  if (typeof p.retry === "function" && (p.status === "error" || p.status === "cancelled")) return true;
  if (p.status === "interrupted" && canReplayFromInitiator(p)) return true;
  return false;
}

function ProcessCard({ p, onStop, onDismiss, onRetry, onGoToRoute, onPoPage, currentPath }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const retryable = canRetry(p);

  // Finished cards clear themselves after 10s so the widget doesn't pile up
  // with old runs — still dismissible by hand before that, and every result
  // is in sync_logs regardless of whether the card is still on screen.
  useEffect(() => {
    if (!AUTO_DISMISS_STATUSES.has(p.status)) return;
    const t = setTimeout(() => onDismiss(p.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [p.status, p.id, onDismiss]);

  return (
    <div className="border-b last:border-b-0">
      <div className="px-3 py-2 flex items-center gap-2 bg-[#faf6ef]">
        <Landmark className="w-3.5 h-3.5 text-[#C5A572] flex-shrink-0" />
        <span className="text-xs font-medium text-gray-800 flex-1 truncate" title={p.label}>
          {p.label}
        </span>
        {p.status === "running" ? (
          <button
            onClick={() => onStop(p.id)}
            disabled={p.cancelRequested}
            className="text-red-500 hover:text-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title={p.cancelRequested ? "Stopping…" : "Cancel"}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0">
            {retryable && (
              <button onClick={() => onRetry(p)} className="text-[#C5A572] hover:text-[#B89660]" title="Retry">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => onDismiss(p.id)} className="text-gray-400 hover:text-gray-600" title="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      <div className="px-3 py-2.5">
        {p.status === "running" && (
          <>
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span className="truncate">{p.phase}</span>
              {p.total > 0 && (
                <span className="flex-shrink-0 ml-2">
                  {p.done}/{p.total}
                </span>
              )}
            </div>
            {p.total > 0 && (
              <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
                <div className="h-full bg-[#C5A572] transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
          </>
        )}

        {p.status === "interrupted" && (
          <>
            <p className="text-xs text-amber-700 mb-2">
              Interrupted at {p.total > 0 ? `${p.done}/${p.total}` : "start"}. Nothing already synced was lost.
            </p>
            {RESUMABLE_TYPES.has(p.type) ? (
              onPoPage ? (
                <p className="text-[11px] text-gray-500">Use the Resume banner above the table.</p>
              ) : (
                <button
                  onClick={() => onGoToRoute("/purchase-orders")}
                  className="w-full text-xs px-2 py-1 rounded bg-[#C5A572] text-white hover:bg-[#B89660]"
                >
                  Go to Purchase Orders to resume
                </button>
              )
            ) : canReplayFromInitiator(p) ? (
              <p className="text-[11px] text-gray-500">Hit Retry above to pick up where this left off.</p>
            ) : TYPE_ROUTES[p.type] ? (
              TYPE_ROUTES[p.type].path !== currentPath ? (
                <button
                  onClick={() => onGoToRoute(TYPE_ROUTES[p.type].path)}
                  className="w-full text-xs px-2 py-1 rounded bg-[#C5A572] text-white hover:bg-[#B89660]"
                >
                  Go to {TYPE_ROUTES[p.type].label} to retry
                </button>
              ) : (
                <p className="text-[11px] text-gray-500">
                  Click &quot;{TYPE_ROUTES[p.type].action}&quot; again to retry.
                </p>
              )
            ) : (
              <p className="text-[11px] text-gray-500">Click the button again to retry.</p>
            )}
          </>
        )}

        {p.status === "cancelled" && (
          <p className="text-xs text-gray-600">
            Stopped at {p.done}/{p.total}. {summaryLine(p)}
          </p>
        )}

        {p.status === "done" && <p className="text-xs text-gray-600">Finished. {summaryLine(p)}</p>}

        {p.status === "error" && (
          <p className="text-xs text-red-700">Failed — check the Settings log for details.</p>
        )}
      </div>
    </div>
  );
}

export default function QbSyncJobWidget() {
  const processes = useQbSyncJobStore((s) => s.processes);
  const requestCancel = useQbSyncJobStore((s) => s.requestCancel);
  const dismissProcess = useQbSyncJobStore((s) => s.dismissProcess);
  const clearFinished = useQbSyncJobStore((s) => s.clearFinished);
  const checkInterrupted = useQbSyncJobStore((s) => s.checkInterrupted);
  const navigate = useNavigate();
  const location = useLocation();
  const { supabase } = useSupabase();

  // Runs once, on app load. Any process that rehydrated as "running" has no
  // live worker behind it — flip it to "interrupted" so Resume shows instead
  // of a progress bar that will never move again.
  useEffect(() => {
    checkInterrupted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!processes || processes.length === 0) return null;

  const onPoPage = location.pathname === "/purchase-orders";
  const running = processes.filter((p) => p.status === "running");
  // Cap the visible history so a long session doesn't grow the card forever —
  // the full list still lives in sync_logs either way.
  const history = processes.filter((p) => p.status !== "running").slice(0, 4);

  // Kick off the retry (it starts its own new tracked process, same as
  // clicking the original button) and clear the old finished card right
  // away — the new attempt shows up as its own running card. Prefer the live
  // `retry` closure when it's still around (cancelled/error, same session);
  // fall back to replaying the stored `initiator` (qbRetryRegistry.js) for
  // "interrupted" cards, where `retry` never survives. Swallow a rejection
  // here: trackQbProcess already logged/marked it "error" before rethrowing,
  // and that shows up as the new card's own status, so there's nothing left
  // for this click handler to do with the error.
  const handleRetry = (p) => {
    if (typeof p.retry === "function") {
      Promise.resolve(p.retry()).catch(() => {});
    } else if (canReplayFromInitiator(p)) {
      Promise.resolve(replayFromInitiator(p, supabase)).catch(() => {});
    } else {
      return;
    }
    dismissProcess(p.id);
  };

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-80 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden max-h-[70vh] flex flex-col">
      <div className="px-3 py-1.5 border-b bg-gray-50 flex items-center justify-between flex-shrink-0">
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
          QuickBooks {running.length > 0 ? `(${running.length} running)` : ""}
        </span>
        {history.length > 0 && (
          <button onClick={clearFinished} className="text-[11px] text-gray-400 hover:text-gray-600">
            Clear
          </button>
        )}
      </div>
      <div className="overflow-y-auto">
        {[...running, ...history].map((p) => (
          <ProcessCard
            key={p.id}
            p={p}
            onStop={requestCancel}
            onDismiss={dismissProcess}
            onRetry={handleRetry}
            onGoToRoute={navigate}
            onPoPage={onPoPage}
            currentPath={location.pathname}
          />
        ))}
      </div>
    </div>
  );
}
