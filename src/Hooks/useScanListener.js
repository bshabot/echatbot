// src/Hooks/useScanListener.js
import { useEffect, useRef } from "react";

/**
 * Keyboard-wedge scanner listener. A USB 2D scanner "types" the QR payload
 * (the sanitized style number on our tags) as very fast keystrokes ending
 * with Enter. We buffer the fast keys and call onScan(code) on Enter.
 *
 * - Ignores typing in INPUT / TEXTAREA / contenteditable (forms keep working).
 * - Ignores human-speed typing: a pause longer than gapMs resets the buffer.
 * - onScan is kept in a ref, so the latest closure is always called (no stale
 *   state in the handler).
 */
export default function useScanListener(
  onScan,
  { minLength = 3, enabled = true, gapMs = 100 } = {}
) {
  const buf = useRef("");
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      const el = e.target;
      const tag = (el && el.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable)) return;
      const now = Date.now();
      if (now - last.current > gapMs) buf.current = ""; // human-speed gap => new entry
      last.current = now;
      if (e.key === "Enter") {
        const code = buf.current.trim();
        buf.current = "";
        if (code.length >= minLength && cb.current) cb.current(code);
      } else if (e.key && e.key.length === 1) {
        buf.current += e.key;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, gapMs, minLength]);
}
