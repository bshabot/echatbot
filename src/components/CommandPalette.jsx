import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAlert } from "./Alerts/AlertContext";
import { confirmLeave } from "../Hooks/useUnsavedChanges";
import { Search, CornerDownLeft, Hammer, Loader2 } from "lucide-react";
import { useSupabase } from "./SupaBaseProvider";
import { NAV_SECTIONS } from "./navItems";
import { fuzzyFilter, fuzzyScore, looseLikePattern } from "../utils/fuzzy";

/**
 * Ctrl/Cmd+K "jump to" box: type a page name to go there, or a style number
 * to open that sample. Mounted once in the authenticated layout.
 * Opened from anywhere with the shortcut, or by dispatching the
 * "plm:open-palette" window event (the sidebar's search button does this).
 */
export default function CommandPalette() {
  const navigate = useNavigate();
  const { showConfirm } = useAlert();
  const { supabase } = useSupabase();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [samples, setSamples] = useState([]); // style-number matches
  const [searching, setSearching] = useState(false); // style-number lookup in flight
  const [opening, setOpening] = useState(false); // handing off to the chosen page
  const inputRef = useRef(null);

  const pages = useMemo(
    () => NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.name }))),
    []
  );

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("plm:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("plm:open-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setSamples([]);
      setSearching(false);
      setOpening(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Look up style numbers once the user pauses typing. Loose on purpose:
  // the letters just have to appear in order, then we rank the candidates.
  useEffect(() => {
    const term = q.trim();
    setSamples([]);
    setSearching(false);
    if (!open || term.replace(/[^a-z0-9]/gi, "").length < 3) return undefined;
    let cancelled = false;
    // Show the spinner right away (during the typing pause too) so the box
    // never looks frozen or "empty" while a lookup is pending.
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase
          .from("sample_with_stones_export")
          .select("*")
          .ilike("styleNumber", looseLikePattern(term))
          .limit(40);
        if (error) throw error;
        // Dedupe (the view can repeat a sample per stone), rank, keep the top few.
        const seen = new Set();
        const unique = (data || []).filter((r) => {
          if (seen.has(r.sample_id)) return false;
          seen.add(r.sample_id);
          return true;
        });
        const ranked = fuzzyFilter(term, unique, (r) => [r.styleNumber]).slice(0, 6);
        if (!cancelled) setSamples(ranked);
      } catch {
        /* lookup is best-effort */
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, supabase]);

  const results = useMemo(() => {
    const term = q.trim();
    const matched = term
      ? fuzzyFilter(term, pages, (p) => [p.label, `${p.section} ${p.label}`, ...(p.keywords || [])])
      : pages;
    const out = matched.map((p) => ({
      key: p.to,
      label: p.label,
      hint: p.section,
      Icon: p.icon,
      run: async () => { if (await confirmLeave(showConfirm)) navigate(p.to); },
    }));
    const sampleRows = samples.map((sm) => ({
      key: `sample-${sm.sample_id}`,
      label: `Open sample ${sm.styleNumber}`,
      hint: "Samples",
      Icon: Hammer,
      slow: true,
      run: async () => { if (await confirmLeave(showConfirm)) navigate(`/samples?sampleId=${encodeURIComponent(sm.sample_id)}`); },
    }));
    // A page that matches the typed text outright beats a loose sample guess;
    // otherwise samples lead (typing a style number should open that sample).
    const topPage = term && matched[0] ? fuzzyScore(term, matched[0].label) : 0;
    return topPage >= 140 ? [...out.slice(0, 1), ...sampleRows, ...out.slice(1)] : [...sampleRows, ...out];
  }, [q, pages, samples, navigate, showConfirm]);

  useEffect(() => setActive(0), [q, samples]);

  if (!open) return null;

  const choose = (r) => {
    if (!r) return;
    // Sample pages fetch before they render, so keep the box up with a short
    // "Opening…" screen instead of snapping shut onto a blank page.
    if (r.slow) {
      setOpening(true);
      r.run();
      setTimeout(() => setOpen(false), 600);
      return;
    }
    setOpen(false);
    r.run();
  };

  const onInputKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/30 flex items-start justify-center pt-[15vh] px-4"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        role="combobox"
        aria-expanded="true"
        className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 border-b border-gray-200">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Jump to a page, or type a style number…"
            className="flex-1 py-3.5 text-sm outline-none"
          />
          <kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        {opening ? (
          <div role="status" className="flex flex-col items-center justify-center gap-3 py-14 text-sm text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin text-[#C5A572]" />
            Opening…
          </div>
        ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
          {searching && (
            <li role="status" className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin text-[#C5A572]" />
              Looking up “{q.trim()}”…
            </li>
          )}
          {results.length === 0 && !searching && (
            <li className="px-4 py-6 text-center text-sm text-gray-500">
              Nothing matches “{q}”.
            </li>
          )}
          {results.map((r, i) => (
            <li key={r.key}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm ${
                  i === active ? "bg-[#C5A572]/10" : ""
                }`}
              >
                <r.Icon className="w-4 h-4 text-gray-500 shrink-0" />
                <span className="flex-1 text-gray-800">{r.label}</span>
                <span className="text-xs text-gray-400">{r.hint}</span>
                {i === active && <CornerDownLeft className="w-3.5 h-3.5 text-gray-400" />}
              </button>
            </li>
          ))}
        </ul>
        )}
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 flex gap-3">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span className="ml-auto">Ctrl+K anywhere</span>
        </div>
      </div>
    </div>
  );
}
