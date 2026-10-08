import { useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useAlert } from "./Alerts/AlertContext";
import { hasUnsavedChanges, subscribeUnsaved, confirmLeave } from "../Hooks/useUnsavedChanges";

// Intercepts in-app link clicks while something has unsaved edits and asks
// before leaving. (Programmatic navigations after a save are unaffected.)
export default function NavigationGuard() {
  const navigate = useNavigate();
  const { showConfirm } = useAlert();
  const dirty = useSyncExternalStore(subscribeUnsaved, hasUnsavedChanges);
  const pushed = useRef(false);

  // Browser Back can't be cancelled, so while something is unsaved we park a
  // duplicate history entry on top: Back then lands on the same page, we ask,
  // and either re-park (keep editing) or go back for real (leave).
  useEffect(() => {
    if (dirty && !pushed.current) {
      window.history.pushState({ ...(window.history.state || {}), plmGuard: true }, "", window.location.href);
      pushed.current = true;
    } else if (!dirty && pushed.current) {
      pushed.current = false;
      if (window.history.state?.plmGuard) window.history.back(); // drop the unused parked entry
    }
  }, [dirty]);

  useEffect(() => {
    const onPop = async () => {
      if (!pushed.current || !hasUnsavedChanges()) return;
      if (window.history.state?.plmGuard) return; // moved forward onto the parked entry
      if (await confirmLeave(showConfirm)) {
        pushed.current = false;
        window.history.back();
      } else {
        window.history.pushState({ ...(window.history.state || {}), plmGuard: true }, "", window.location.href);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showConfirm]);

  useEffect(() => {
    const onClick = async (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!hasUnsavedChanges()) return;
      const a = e.target.closest?.("a[href]");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      if (await confirmLeave(showConfirm)) navigate(to);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [navigate, showConfirm]);

  return null;
}
