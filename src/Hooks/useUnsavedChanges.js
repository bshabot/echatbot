import { useEffect, useRef, useCallback } from "react";
import { useAlert } from "../components/Alerts/AlertContext";

// Module-level registry of "something on screen has unsaved edits".
// Read by <NavigationGuard /> (in-app link clicks), the command palette and
// the browser's beforeunload prompt.
const dirtyOwners = new Set();
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
export const hasUnsavedChanges = () => dirtyOwners.size > 0;
export const subscribeUnsaved = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const LEAVE_PROMPT = {
  title: "Leave without saving?",
  confirmText: "Leave",
  cancelText: "Keep editing",
  variant: "warning",
};

// Resolve true when it's fine to navigate away.
export async function confirmLeave(showConfirm) {
  if (!hasUnsavedChanges()) return true;
  return showConfirm("You have unsaved changes. If you leave now they'll be lost.", LEAVE_PROMPT);
}

// Register `dirty` for the lifetime of the calling component.
export function useUnsavedChanges(dirty) {
  const owner = useRef(null);
  if (!owner.current) owner.current = Symbol("unsaved");
  useEffect(() => {
    const id = owner.current;
    if (dirty) dirtyOwners.add(id);
    else dirtyOwners.delete(id);
    notify();
    return () => {
      dirtyOwners.delete(id);
      notify();
    };
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}

// For modal forms. Snapshots `value` shortly after the modal opens (so
// effects that fill the form have run), then treats any later difference as
// unsaved work. Returns requestClose(): asks before discarding when dirty,
// otherwise just closes. Programmatic closes after a save should call
// onClose directly.
export function useDiscardGuard({ isOpen, value, onClose, onDiscard, message }) {
  const { showConfirm } = useAlert();
  const baseline = useRef(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!isOpen) {
      baseline.current = null;
      return undefined;
    }
    const t = setTimeout(() => {
      baseline.current = JSON.stringify(latest.current);
    }, 150);
    return () => clearTimeout(t);
  }, [isOpen]);

  const dirty = isOpen && baseline.current !== null && JSON.stringify(value) !== baseline.current;
  useUnsavedChanges(dirty);

  return useCallback(async () => {
    if (dirty) {
      const ok = await showConfirm(message || "Discard your changes?", {
        title: "Discard changes?",
        confirmText: "Discard",
        cancelText: "Keep editing",
        variant: "warning",
      });
      if (!ok) return;
      // Put the form back exactly as it was when it opened, so nothing typed
      // here survives a Discard (the modals stay mounted between opens).
      if (onDiscard && baseline.current !== null) onDiscard(JSON.parse(baseline.current));
    }
    onClose();
  }, [dirty, onClose, onDiscard, showConfirm, message]);
}
