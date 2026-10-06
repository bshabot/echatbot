import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAlert } from "./Alerts/AlertContext";
import { hasUnsavedChanges, confirmLeave } from "../Hooks/useUnsavedChanges";

// Intercepts in-app link clicks while something has unsaved edits and asks
// before leaving. (Programmatic navigations after a save are unaffected.)
export default function NavigationGuard() {
  const navigate = useNavigate();
  const { showConfirm } = useAlert();

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
