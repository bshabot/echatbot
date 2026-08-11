import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import {
  ScrollText,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Info,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

// Self-contained viewer for the general `sync_logs` table (see utils/logEvent.js
// + utils/qbSyncStatus.js). Dropped onto the Settings page as one more card —
// it owns all its own state and never touches the page's save/dirty flow.

const LEVELS = [
  { key: "all", label: "All" },
  { key: "error", label: "Errors" },
  { key: "success", label: "Success" },
  { key: "info", label: "Info" },
];

function levelStyle(level) {
  switch (level) {
    case "error":
      return { cls: "bg-red-100 text-red-700", Icon: AlertCircle };
    case "success":
      return { cls: "bg-green-100 text-green-700", Icon: CheckCircle2 };
    default:
      return { cls: "bg-blue-100 text-blue-700", Icon: Info };
  }
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function SyncLogsCard() {
  const { supabase } = useSupabase();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadError, setLoadError] = useState("");

  const fetchLogs = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setLoadError("");
    try {
      let query = supabase
        .from("sync_logs")
        .select("id,level,source,action,message,details,po_number,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (level !== "all") query = query.eq("level", level);
      if (source !== "all") query = query.eq("source", source);
      const { data, error } = await query;
      if (error) throw error;
      setLogs(data || []);
    } catch (e) {
      setLoadError(e?.message || String(e));
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, level, source, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Source options come from what's actually in the current pull, so the list
  // grows itself as new subsystems start logging.
  const sources = useMemo(() => {
    const s = new Set(logs.map((l) => l.source).filter(Boolean));
    return ["all", ...Array.from(s).sort()];
  }, [logs]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter((l) => {
      const hay = `${l.message || ""} ${l.po_number || ""} ${l.action || ""} ${JSON.stringify(
        l.details || {}
      )}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [logs, q]);

  const errorCount = useMemo(
    () => logs.filter((l) => l.level === "error").length,
    [logs]
  );

  function toggle(id) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="mb-8">
      <h2 className="text-lg font-medium mb-2 flex items-center gap-2">
        <ScrollText className="w-5 h-5 text-[#C5A572]" /> Sync Logs
        {errorCount > 0 && (
          <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-red-100 text-red-700">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
      </h2>
      <div className="bg-gray-50 border rounded-md p-4">
        <p className="text-sm text-gray-600 mb-3">
          Every recorded action across the PLM — QuickBooks sync (create, update,
          memos) and more — including the exact connector error when something
          fails. Newest first. Click a row to see its full details.
        </p>

        {/* filters */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => setLevel(l.key)}
                className={`text-xs px-2.5 py-1 rounded-full ${
                  level === l.key
                    ? "bg-gray-900 text-white"
                    : "bg-white border text-gray-600 hover:bg-gray-100"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-white"
            title="Filter by source"
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All sources" : s}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search message / PO / details…"
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-white flex-1 min-w-[160px]"
          />
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-white"
            title="How many to load"
          >
            {[50, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={fetchLogs}
            disabled={loading}
            className="text-xs px-2.5 py-1.5 rounded border bg-white text-gray-600 hover:bg-gray-100 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {loadError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">
            Couldn’t load logs: {loadError}
          </div>
        )}

        {/* list */}
        <div className="border border-gray-200 rounded-md bg-white divide-y max-h-[28rem] overflow-auto">
          {loading && logs.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">
              No log entries
              {level !== "all" || source !== "all" || q ? " match these filters" : " yet"}.
            </div>
          ) : (
            visible.map((l) => {
              const { cls, Icon } = levelStyle(l.level);
              const isOpen = expanded.has(l.id);
              const hasDetails = l.details && Object.keys(l.details).length > 0;
              return (
                <div key={l.id} className="text-sm">
                  <button
                    type="button"
                    onClick={() => hasDetails && toggle(l.id)}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 ${
                      hasDetails ? "hover:bg-gray-50 cursor-pointer" : "cursor-default"
                    }`}
                  >
                    <span
                      className={`mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${cls}`}
                    >
                      <Icon className="w-3 h-3" />
                      {l.level}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-gray-800 break-words">
                        {l.message || "(no message)"}
                      </span>
                      <span className="block text-[11px] text-gray-400 mt-0.5">
                        {fmtTime(l.created_at)}
                        {l.source ? ` · ${l.source}` : ""}
                        {l.action ? ` · ${l.action}` : ""}
                        {l.po_number ? ` · PO ${l.po_number}` : ""}
                      </span>
                    </span>
                    {hasDetails &&
                      (isOpen ? (
                        <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                      ))}
                  </button>
                  {isOpen && hasDetails && (
                    <pre className="px-3 pb-2 text-[11px] text-gray-600 whitespace-pre-wrap break-words bg-gray-50 border-t">
                      {JSON.stringify(l.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
