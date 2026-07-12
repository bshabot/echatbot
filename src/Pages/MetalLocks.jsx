import React, { useEffect, useMemo, useState } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { useMetalPriceStore } from "../store/MetalPrices";
import { Trash2, Plus, RefreshCw, AlertTriangle, Zap } from "lucide-react";
import { useAlert } from "../components/Alerts/AlertContext";

// Daily silver + gold metal lock history.
// Powers tariff auto-detect on older POs and serves as a reference for
// pricing decisions / billing reconciliation.
export default function MetalLocks() {
  const { supabase } = useSupabase();
  const { showAlert, showConfirm } = useAlert();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add-row form state
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [newSilver, setNewSilver] = useState("");
  const [newGold, setNewGold] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    refresh();
  }, [supabase]);

  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase
      .from("metal_lock_history")
      .select("*")
      .order("date", { ascending: false });
    if (error) setError(error.message);
    setRows(data ?? []);
    setLoading(false);
  }

  async function addRow() {
    if (!newDate) {
      setError("Date is required");
      return;
    }
    setAdding(true);
    setError("");
    const payload = {
      date: newDate,
      silver_lock: newSilver ? Number(newSilver) : null,
      gold_lock: newGold ? Number(newGold) : null,
      source: "manual",
      notes: newNotes || null,
    };
    // Upsert by date — re-entering same date overwrites
    const { error } = await supabase
      .from("metal_lock_history")
      .upsert(payload, { onConflict: "date" });
    if (error) {
      setError(error.message);
    } else {
      setNewSilver("");
      setNewGold("");
      setNewNotes("");
      await refresh();
    }
    setAdding(false);
  }

  async function updateRow(date, field, value) {
    const num = value === "" ? null : Number(value);
    if (value !== "" && !Number.isFinite(num)) return;
    const { error } = await supabase
      .from("metal_lock_history")
      .update({ [field]: num })
      .eq("date", date);
    if (error) {
      showAlert(error.message, { title: "Update failed", variant: "error" });
      return;
    }
    setRows((prev) => prev.map((r) => (r.date === date ? { ...r, [field]: num } : r)));
  }

  async function updateNotes(date, value) {
    const { error } = await supabase
      .from("metal_lock_history")
      .update({ notes: value || null })
      .eq("date", date);
    if (error) {
      showAlert(error.message, { title: "Update failed", variant: "error" });
      return;
    }
    setRows((prev) => prev.map((r) => (r.date === date ? { ...r, notes: value || null } : r)));
  }

  async function deleteRow(date) {
    if (!(await showConfirm(`Delete metal lock for ${date}?`, { confirmText: "Delete", variant: "error" }))) return;
    const { error } = await supabase.from("metal_lock_history").delete().eq("date", date);
    if (error) {
      showAlert(error.message, { title: "Delete failed", variant: "error" });
      return;
    }
    setRows((prev) => prev.filter((r) => r.date !== date));
  }

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    const silverVals = rows.map((r) => r.silver_lock).filter((v) => v != null);
    const goldVals = rows.map((r) => r.gold_lock).filter((v) => v != null);
    return {
      total: rows.length,
      silver: silverVals.length,
      gold: goldVals.length,
      latestDate: rows[0]?.date,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Metal Locks</h1>
        <p className="text-sm text-gray-500 mt-1">
          Daily silver and gold lock history. Used to auto-detect tariffs on
          older POs and as a reference for billing reconciliation.
        </p>
      </div>

      {/* Add row */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="text-sm font-medium text-gray-700 mb-3">Add a lock</div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Silver $/oz</label>
            <input
              type="number"
              inputMode="decimal"
              value={newSilver}
              onChange={(e) => setNewSilver(e.target.value)}
              placeholder="e.g. 75.73"
              step="0.01"
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Gold $/oz</label>
            <input
              type="number"
              inputMode="decimal"
              value={newGold}
              onChange={(e) => setNewGold(e.target.value)}
              placeholder="e.g. 4720"
              step="0.01"
              className="input w-full"
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
            <input
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="signet daily, manual, etc."
              className="input w-full"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={addRow}
              disabled={adding}
              className="px-4 py-2 bg-[#C5A572] hover:bg-[#B89660] text-white rounded text-sm disabled:opacity-50 flex items-center gap-1"
            >
              <Plus className="w-4 h-4" />
              {adding ? "Saving..." : "Add lock"}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total entries" value={stats.total} />
          <Stat label="Silver entries" value={stats.silver} />
          <Stat label="Gold entries" value={stats.gold} />
          <Stat label="Latest date" value={stats.latestDate || "—"} />
        </div>
      )}

      {/* History table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="text-sm font-medium text-gray-700">History</div>
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                await useMetalPriceStore.getState().syncFromLatestLock(supabase);
                showAlert("System metal prices updated to latest lock.", { title: "Synced", variant: "success" });
              }}
              className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
              title="Push latest lock to system-wide metal prices"
            >
              <Zap className="w-3 h-3" />
              Sync to system prices
            </button>
            <button
              onClick={refresh}
              className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-gray-500">loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            no locks recorded yet. add one above.
          </div>
        ) : (
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Silver $/oz</th>
                <th className="px-4 py-2">Gold $/oz</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Notes</th>
                <th className="px-4 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.date} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono">{r.date}</td>
                  <td className="px-4 py-2">
                    <EditableNumber
                      value={r.silver_lock}
                      onSave={(v) => updateRow(r.date, "silver_lock", v)}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <EditableNumber
                      value={r.gold_lock}
                      onSave={(v) => updateRow(r.date, "gold_lock", v)}
                    />
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">{r.source}</td>
                  <td className="px-4 py-2">
                    <input
                      defaultValue={r.notes || ""}
                      onBlur={(e) => {
                        if (e.target.value !== (r.notes || "")) {
                          updateNotes(r.date, e.target.value);
                        }
                      }}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      className="w-full px-1 py-0.5 border border-transparent hover:border-gray-200 rounded text-xs focus:border-[#C5A572] focus:outline-none"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deleteRow(r.date)}
                      className="p-2 text-gray-400 hover:text-red-600 rounded"
                      title="Delete this entry"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EditableNumber({ value, onSave }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      defaultValue={value ?? ""}
      onBlur={(e) => {
        if (e.target.value !== String(value ?? "")) onSave(e.target.value);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      step="0.01"
      className="w-24 px-1 py-0.5 border border-transparent hover:border-gray-200 rounded text-sm focus:border-[#C5A572] focus:outline-none"
      placeholder="—"
    />
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-3">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  );
}
