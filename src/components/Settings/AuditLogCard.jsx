import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { History, RefreshCw, ChevronRight, ChevronDown } from "lucide-react";

// Viewer for `audit_log` -- the DB-trigger-backed record of every insert /
// update / delete on the core catalog tables (samples, starting_info,
// stones, running lines + their child tables, POs, quotes). Unlike
// sync_logs (app-code-driven, for the specific save-failed-here-are-the-
// details case -- see SyncLogsCard/logEvent.js), this one is written by a
// Postgres trigger, so it captures a write no matter which code path
// (this app, a script, a scrape, a direct SQL edit) made it, and it holds
// the full row as it stood right after the write -- useful for "what did
// this look like before it changed" recovery, not just "why did this fail."
const ACTIONS = [
  { key: "all", label: "All" },
  { key: "INSERT", label: "Added" },
  { key: "UPDATE", label: "Updated" },
  { key: "DELETE", label: "Deleted" },
];

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function actionStyle(action) {
  switch (action) {
    case "INSERT":
      return "bg-green-100 text-green-700";
    case "DELETE":
      return "bg-red-100 text-red-700";
    default:
      return "bg-blue-100 text-blue-700";
  }
}

export default function AuditLogCard() {
  const { supabase } = useSupabase();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("all");
  const [table, setTable] = useState("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadError, setLoadError] = useState("");

  const fetchRows = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setLoadError("");
    try {
      let query = supabase
        .from("audit_log")
        .select("id,table_name,row_pk,action,payload,old_payload,changed_by_email,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (action !== "all") query = query.eq("action", action);
      if (table !== "all") query = query.eq("table_name", table);
      const { data, error } = await query;
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setLoadError(e?.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, action, table, limit]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const tables = useMemo(() => {
    const s = new Set(rows.map((r) => r.table_name).filter(Boolean));
    return ["all", ...Array.from(s).sort()];
  }, [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => {
      const hay = `${r.table_name || ""} ${r.row_pk || ""} ${r.changed_by_email || ""} ${JSON.stringify(
        r.payload || {}
      )}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q]);

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
        <History className="w-5 h-5 text-[#C5A572]" /> Audit Log
      </h2>
      <div className="bg-gray-50 border rounded-md p-4">
        <p className="text-sm text-gray-600 mb-3">
          Every add, edit, and delete on samples, starting info, stones, running lines, POs,
          and quotes -- written by the database itself, so it's there no matter what made the
          change. Click a row to see the full record as it stood right after that write, in
          case something needs to be recovered.
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-1">
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setAction(a.key)}
                className={`text-xs px-2.5 py-1 rounded-full ${
                  action === a.key ? "bg-gray-900 text-white" : "bg-white border text-gray-600 hover:bg-gray-100"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <select
            value={table}
            onChange={(e) => setTable(e.target.value)}
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-white"
            title="Filter by table"
          >
            {tables.map((t) => (
              <option key={t} value={t}>
                {t === "all" ? "All tables" : t}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search style #, id, who…"
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
            onClick={fetchRows}
            disabled={loading}
            className="text-xs px-2.5 py-1.5 rounded border bg-white text-gray-600 hover:bg-gray-100 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {loadError && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">
            Couldn't load the audit log: {loadError}
          </div>
        )}

        <div className="border border-gray-200 rounded-md bg-white divide-y max-h-[28rem] overflow-auto">
          {loading && rows.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">
              No changes {action !== "all" || table !== "all" || q ? "match these filters" : "recorded yet"}.
            </div>
          ) : (
            visible.map((r) => {
              const isOpen = expanded.has(r.id);
              const styleNumber = r.payload?.styleNumber || r.payload?.ssp_number || r.payload?.po_number;
              return (
                <div key={r.id} className="text-sm">
                  <button
                    type="button"
                    onClick={() => toggle(r.id)}
                    className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-gray-50 cursor-pointer"
                  >
                    <span className={`mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${actionStyle(r.action)}`}>
                      {r.action}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-gray-800 break-words">
                        {r.table_name} #{r.row_pk}
                        {styleNumber ? ` — ${styleNumber}` : ""}
                      </span>
                      <span className="block text-[11px] text-gray-400 mt-0.5">
                        {fmtTime(r.created_at)}
                        {r.changed_by_email ? ` · by ${r.changed_by_email}` : ""}
                      </span>
                    </span>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-2 pt-1 border-t bg-gray-50 space-y-2">
                      {r.action !== "INSERT" && r.old_payload && (
                        <details>
                          <summary className="text-[10px] text-gray-400 cursor-pointer select-none">Before</summary>
                          <pre className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap break-words">
                            {JSON.stringify(r.old_payload, null, 2)}
                          </pre>
                        </details>
                      )}
                      {r.payload && (
                        <details open>
                          <summary className="text-[10px] text-gray-400 cursor-pointer select-none">
                            {r.action === "DELETE" ? "Last known values" : "Current record"}
                          </summary>
                          <pre className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap break-words">
                            {JSON.stringify(r.payload, null, 2)}
                          </pre>
                        </details>
                      )}
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
