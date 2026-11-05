// The vendor list is cached in the browser for 24h (see VendorStore.fetchEntity). If a vendor was
// deleted meanwhile, saving an item that points at it fails with a foreign-key error
// (samples_vendor_fkey, Postgres code 23503). Leave the cache alone otherwise, but when that
// happens, refetch the vendor list so the form shows what really exists.
import { useGenericStore } from "../store/VendorStore";

export function isVendorFkError(error) {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  return error?.code === "23503" && /vendor/i.test(text);
}

// Returns true when it was a stale-vendor error (and the list has been refreshed).
export function recoverFromVendorFkError(error, showMessage) {
  if (!isVendorFkError(error)) return false;
  useGenericStore.getState().fetchEntity("vendors", { force: true });
  showMessage?.("That vendor no longer exists. The vendor list has been refreshed, so pick the vendor again and save.");
  return true;
}
