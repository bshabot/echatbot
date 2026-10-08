import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

// Keys that describe a one-off view rather than a filter choice.
const TRANSIENT = ["page", "sampleId", "quote"];

/**
 * Keeps a page's URL filters across visits. Returning to the page with a
 * bare URL (e.g. from the sidebar) restores the last filters; any URL that
 * already carries params (a deep link, a bookmark) wins untouched. Clearing
 * all filters is remembered too. Page number is not remembered.
 */
export default function useRememberedSearchParams(key) {
  const storageKey = `plm.filters.${key}`;
  const [params, setParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if ([...params.keys()].length === 0) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) setParams(new URLSearchParams(saved), { replace: true });
      } catch {
        /* storage blocked -- nothing to restore */
      }
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      const next = new URLSearchParams(params);
      TRANSIENT.forEach((k) => next.delete(k));
      const str = next.toString();
      if (str) localStorage.setItem(storageKey, str);
      else localStorage.removeItem(storageKey);
    } catch {
      /* storage blocked */
    }
  }, [params, ready, storageKey]);
}
