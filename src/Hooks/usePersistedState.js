// src/Hooks/usePersistedState.js
import { useEffect, useState } from "react";

/**
 * useState that remembers its value in localStorage, so a page's filter /
 * sort / tab choice survives leaving the page and coming back.
 *
 *   const [view, setView] = usePersistedState("po.view", "open");
 *
 * Safe if storage is blocked or holds junk: it falls back to `initial`.
 * `validate` (optional) rejects stored values that are no longer valid,
 * e.g. an option that was removed.
 */
export default function usePersistedState(key, initial, validate) {
  const storageKey = `plm.${key}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        if (!validate || validate(parsed)) return parsed;
      }
    } catch {
      /* fall through to the default */
    }
    return typeof initial === "function" ? initial() : initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage unavailable -- not fatal */
    }
  }, [storageKey, value]);

  return [value, setValue];
}
