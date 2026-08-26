// src/utils/qbRetryRegistry.js
//
// Turns a persisted process's `{ type, initiator }` back into a real call —
// this is what makes Retry work on "Interrupted" cards, not just
// cancelled/error ones.
//
// Why this exists: a process only becomes "interrupted" via
// QbSyncJobStore.js's checkInterrupted(), which fires on the NEXT page load
// after finding a process stranded at status:"running" (the reload killed
// whatever JS was running it). By that point every live closure from the
// previous JS context — including the `retry` function trackQbProcess
// attached — is gone for good; a function cannot survive the localStorage
// JSON round-trip (JSON.stringify silently drops function-valued
// properties). `initiator`, by contrast, is plain data (the exact args the
// call needs — samples/rows/costView/prepared/etc.), so it DOES survive that
// round-trip. This registry is the other half: given `{ type, initiator }`,
// know how to call the right function again.
//
// settings/vendors are deliberately NOT stored in `initiator` — they're
// always available live from VendorStore's global cache (the same place
// every page already reads them from), so pulling them fresh here is both
// simpler than snapshotting them and more correct: a retry fired an hour (or
// a day) after the interruption uses TODAY's settings/vendors, not whatever
// was loaded when the process first started.
//
// Only operations that are provably safe to blind-replay are registered
// here — same safety rule qbSyncStatus.js's trackQbProcess doc comment lays
// out for `retry`. The multi-phase sales-order send flows (create-prepare/
// create-send/update-prepare/update-send/so-update — QbSyncJobWidget.jsx's
// RESUMABLE_TYPES) are deliberately NOT here: replaying a stale `prepared`
// payload could re-send an already-created sales order. Those keep routing
// through the Purchase Orders resume banner, which re-checks live
// QuickBooks state before resending — storing their initiator wouldn't
// remove that risk, only hide it behind a button that looks as safe as the
// others.

import { useGenericStore } from "../store/VendorStore";
import {
  createItemsForSamples,
  updateItemsForSamples,
  syncItemForSample,
  updateItemPricesForRows,
} from "./qbItems";
import { prepareFactoryCostPoUpdates, sendPreparedPoUpdates } from "./qbPurchaseOrders";
import { importQbPosFromQb } from "./qbPoImport";
import { createSalesOrdersForPos, syncMemosFromQb } from "./qbSalesOrders";

/** settings + vendors, read live off the shared cache — never stale, never stored. */
function liveEntities() {
  const get = useGenericStore.getState().getEntity;
  return { settings: get("settings"), vendors: get("vendors") };
}

// type -> (initiator, supabase) => Promise. Keep this in sync with every
// call site in qbItems.js / qbPurchaseOrders.js / qbPoImport.js /
// qbSalesOrders.js that sets `initiator` on trackQbProcess.
export const QB_RETRY_REGISTRY = {
  "item-create": (initiator, supabase) => {
    const { settings, vendors } = liveEntities();
    return createItemsForSamples(initiator.samples, { settings, vendors, supabase });
  },
  "item-update": (initiator, supabase) => {
    const { settings, vendors } = liveEntities();
    return updateItemsForSamples(initiator.samples, { settings, vendors, supabase });
  },
  "item-sync-single": (initiator, supabase) => {
    const { settings, vendors } = liveEntities();
    return syncItemForSample(initiator.sample, { settings, vendors, supabase });
  },
  "item-price-update": (initiator, supabase) => {
    const { settings } = liveEntities();
    return updateItemPricesForRows(initiator.rows, { settings, supabase });
  },
  "po-price-prepare": (initiator, supabase) => {
    const { settings } = liveEntities();
    return prepareFactoryCostPoUpdates(initiator.costView, { settings, supabase });
  },
  "po-price-send": (initiator, supabase) => {
    const { settings } = liveEntities();
    return sendPreparedPoUpdates(initiator.prepared, { settings, supabase });
  },
  "po-sync": (initiator, supabase) => {
    const { settings } = liveEntities();
    return importQbPosFromQb(supabase, { settings, view: initiator.view });
  },
  "create-direct": (initiator, supabase) => {
    const { settings } = liveEntities();
    return createSalesOrdersForPos(initiator.pos, { supabase, settings });
  },
  "memo-sync": (initiator, supabase) => {
    const { settings } = liveEntities();
    return syncMemosFromQb({ supabase, settings, poNumbers: initiator.poNumbers });
  },
};

/**
 * True when this process can be replayed from its stored `initiator` —
 * regardless of whether it's still got a live `retry` closure. Used for
 * "interrupted" cards, where `retry` is always null by the time the card
 * exists (see the file header).
 */
export function canReplayFromInitiator(p) {
  return !!(p && p.initiator && typeof QB_RETRY_REGISTRY[p.type] === "function");
}

/** Fire the replay. Caller (the widget) is responsible for surfacing errors — same as p.retry(). */
export function replayFromInitiator(p, supabase) {
  const fn = QB_RETRY_REGISTRY[p.type];
  if (!fn) return Promise.resolve();
  return fn(p.initiator, supabase);
}
