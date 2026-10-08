// src/Hooks/useEscapeKey.js
import { useEffect, useRef } from "react";

// Stack of open dialogs so Escape only closes the TOPMOST one (a confirm
// opened on top of a dialog shouldn't also close the dialog underneath).
const stack = [];

/**
 * Close a dialog / panel when Escape is pressed.
 *
 *   useEscapeKey(onClose);              // always on while mounted
 *   useEscapeKey(onCancel, !busy);      // ignored while a save is running
 *
 * Skips the keypress if the app's alert/confirm popup (marked
 * data-plm-alert) is showing -- that popup handles Escape itself.
 */
export default function useEscapeKey(handler, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return undefined;
    const token = {};
    stack.push(token);
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (stack[stack.length - 1] !== token) return;
      if (document.querySelector("[data-plm-alert]")) return;
      ref.current?.(e);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}
