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

// Turns the known `details` shapes (failedDetail/conflictDetail/notFound —
// see qbSyncStatus.js capDetail(), qbPoImport.js, qbSalesOrders.js) into a
// readable per-item list instead of a raw JSON dump. Kevin 8/19: "I see
// conflict which one" — the count and the underlying data were already
// there, but finding "which one and why" meant reading a JSON blob by eye.
// Falls back to the raw JSON for anything that isn't one of these shapes, so
// nothing is ever hidden — this only adds a friendlier view on top.
function DetailList({ title, items, truncated, tone = "gray" }) {
  if (!items || items.length === 0) return null;
  const toneCls =
    tone === "error"
      ? "border-red-200 bg-red-50"
      : tone === "warning"
      ? "border-amber-200 bg-amber-50"
      : "border-gray-200 bg-gray-50";
  return (
    <div className={`rounded border ${toneCls} p-2`}>
      <div className="text-[11px] font-semibold text-gray-600 mb-1">
        {title} ({items.length}
        {truncated ? `, +${truncated} more not shown` : ""})
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => {
          // Two shapes seen in practice: a plain string ("PO 123: board says
          // X, QB says Y") from the PO-import/memo-sync conflict arrays, or
          // { sample|item|po, error } from the item/SO batch failure arrays.
          if (typeof it === "string") {
            return (
              <li key={i} className="text-[11px] text-gray-700 break-words">
                • {it}
              </li>
            );
          }
          const label = it.sample || it.item || it.po || it.label || `#${i + 1}`;
          const err = it.error || it.reason || it.message;
          return (
            <li key={i} className="text-[11px] text-gray-700 break-words">
              • <span className="font-medium">{String(label)}</span>
              {err ? <span className="text-red-700"> — {String(err)}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// A capDetail()-shaped value is either a plain array, or
// { items: [...], truncated: N } once it was capped. Normalize both.
function splitCapped(v) {
  if (!v) return { items: [], truncated: 0 };
  if (Array.isArray(v)) return { items: v, truncated: 0 };
  return { items: v.items || [], truncated: v.truncated || 0 };
}

const KNOWN_DETAIL_KEYS = {
  failedDetail: { title: "Failed", tone: "error" },
  conflictDetail: { title: "Conflicts", tone: "warning" },
  notFound: { title: "Not found in QuickBooks", tone: "warning" },
  errors: { title: "Errors", tone: "error" },
};

function StructuredDetails({ details }) {
  if (!details || typeof details !== "object") return null;
  const lists = Object.entries(KNOWN_DETAIL_KEYS)
    .map(([key, meta]) => {
      const { items, truncated } = splitCapped(details[key]);
      return items.length ? { key, meta, items, truncated } : null;
    })
    .filter(Boolean);

  // The plain scalar fields (result, so_ref, po_id, error, total, ...) —
  // whatever's left once the per-item arrays above are pulled out — shown
  // as a compact key: value strip so "what happened" reads at a glance
  // before "which ones" underneath.
  const shownKeys = new Set(Object.keys(KNOWN_DETAIL_KEYS));
  const scalarEntries = Object.entries(details).filter(
    ([k, v]) => !shownKeys.has(k) && v !== null && v !== undefined && v !== ""
  );

  if (lists.length === 0 && scalarEntries.length === 0) return null;

  return (
    <div className="space-y-2">
      {scalarEntries.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600">
          {scalarEntries.map(([k, v]) => (
            <span key={k}>
              <span className="text-gray-400">{k}:</span>{" "}
              <span className="text-gray-800">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </span>
            </span>
          ))}
        </div>
      )}
      {lists.map(({ key, meta, items, truncated }) => (
        <DetailList key={key} title={meta.title} tone={meta.tone} items={items} truncated={truncated} />
      ))}
    </div>
  );
}

export default function SyncLogsCard() {
  const { supabase } = useSupabase();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const [user, setUser] = useState("all");
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
        .select("id,level,source,action,message,details,po_number,user_email,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (level !== "all") query = query.eq("level", level);
      if (source !== "all") query = query.eq("source", source);
      if (user !== "all") query = user === "unattributed" ? query.is("user_email", null) : query.eq("user_email", user);
      const { data, error } = await query;
      if (error) throw error;
      setLogs(data || []);
    } catch (e) {
      setLoadError(e?.message || String(e));
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, level, source, user, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Source options come from what's actually in the current pull, so the list
  // grows itself as new subsystems start logging.
  const sources = useMemo(() => {
    const s = new Set(logs.map((l) => l.source).filter(Boolean));
    return ["all", ...Array.from(s).sort()];
  }, [logs]);

  // Same idea for who: built from whatever's actually in the pull, plus an
  // "Unattributed" bucket for entries logged before user_email existed (or
  // anything that ran without a signed-in session, e.g. a scheduled job).
  const users = useMemo(() => {
    const u = new Set(logs.map((l) => l.user_email).filter(Boolean));
    const hasUnattributed = logs.some((l) => !l.user_email);
    return ["all", ...Array.from(u).sort(), ...(hasUnattributed ? ["unattributed"] : [])];
  }, [logs]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter((l) => {
      const hay = `${l.message || ""} ${l.po_number || ""} ${l.action || ""} ${l.user_email || ""} ${JSON.stringify(
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
          <select
            value={user}
            onChange={(e) => setUser(e.target.value)}
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-white"
            title="Filter by user"
          >
            {users.map((u) => (
              <option key={u} value={u}>
                {u === "all" ? "All users" : u === "unattributed" ? "Unattributed" : u}
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
              {level !== "all" || source !== "all" || user !== "all" || q
                ? " match these filters"
                : " yet"}
              .
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
                        {l.user_email ? ` · by ${l.user_email}` : ""}
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
                    <div className="px-3 pb-2 pt-1 border-t bg-gray-50">
                      <StructuredDetails details={l.details} />
                      <details className="mt-2">
                        <summary className="text-[10px] text-gray-400 cursor-pointer select-none">
                          Raw details
                        </summary>
                        <pre className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap break-words">
                          {JSON.stringify(l.details, null, 2)}
                        </pre>
                      </details>
                    </div>
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
