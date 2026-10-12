import React, { useState } from "react";
import { Layers, X, Eye, Trash2, Pencil, Copy } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useBatches, removeBatch, renameBatch } from "../../utils/sampleBatches";
import { useAlert } from "../Alerts/AlertContext";
import { useMessage } from "../Messages/MessageContext";

// Button + panel for saved selection batches (see utils/sampleBatches.js).
// "View in list" filters the Samples page to just that batch (?batch=<id>);
// "Done -- remove" is the only way a batch goes away.
export default function SampleBatches() {
  const batches = useBatches();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { showConfirm, showPrompt } = useAlert();
  const { showMessage } = useMessage();

  const view = (b) => {
    navigate(`/samples?batch=${encodeURIComponent(b.id)}`);
    setOpen(false);
  };
  const rename = async (b) => {
    const name = await showPrompt("Rename batch:", { title: "Rename batch", defaultValue: b.name, confirmText: "Rename" });
    if (name && name.trim()) renameBatch(b.id, name);
  };
  const remove = async (b) => {
    const ok = await showConfirm(
      `Remove "${b.name}" (${b.unitCount} item${b.unitCount === 1 ? "" : "s"})? This only removes the saved list from this browser -- it doesn't touch the samples themselves.`,
      { title: "Done with this batch?", confirmText: "Done -- remove", variant: "error" }
    );
    if (ok) removeBatch(b.id);
  };
  const copy = async (b) => {
    try {
      await navigator.clipboard.writeText((b.styleNumbers || []).join("\n"));
      showMessage(`Copied ${b.styleNumbers.length} style numbers`);
    } catch {
      showMessage("Couldn't copy to the clipboard");
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 border rounded-md px-3 py-1.5 text-sm bg-white hover:bg-gray-50 ${
          batches.length > 0 ? "border-[#C5A572] text-[#8a6d3b]" : "border-gray-300 text-gray-600"
        }`}
        title="Saved selections you're still checking"
      >
        <Layers className="w-4 h-4" />
        Batches
        {batches.length > 0 && (
          <span className="bg-[#C5A572] text-white rounded-full text-xs min-w-5 h-5 px-1 flex items-center justify-center">
            {batches.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Batches</h2>
                <p className="text-xs text-gray-500">
                  Selections you ran an action on (or saved). They stay until you remove them. Saved in this browser.
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-5 space-y-3">
              {batches.length === 0 && (
                <p className="text-sm text-gray-500">
                  No batches yet. Select samples, then use Actions &rarr; Save as batch (or run any bulk action and one is
                  saved for you).
                </p>
              )}
              {batches.map((b) => {
                const shown = (b.styleNumbers || []).slice(0, 14);
                const more = (b.styleNumbers || []).length - shown.length;
                return (
                  <div key={b.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{b.name}</div>
                        <div className="text-xs text-gray-500">
                          {b.unitCount} item{b.unitCount === 1 ? "" : "s"} &middot; {b.source} &middot;{" "}
                          {new Date(b.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => view(b)} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-chabot-gold text-white hover:bg-opacity-90">
                          <Eye className="w-3.5 h-3.5" /> View
                        </button>
                        <button onClick={() => copy(b)} className="p-1.5 text-gray-500 hover:text-gray-800" title="Copy style numbers">
                          <Copy className="w-4 h-4" />
                        </button>
                        <button onClick={() => rename(b)} className="p-1.5 text-gray-500 hover:text-gray-800" title="Rename">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => remove(b)} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-red-200 text-red-600 hover:bg-red-50" title="Done -- remove this batch">
                          <Trash2 className="w-3.5 h-3.5" /> Done
                        </button>
                      </div>
                    </div>
                    {shown.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {shown.map((s, i) => (
                          <span key={`${s}-${i}`} className="text-xs bg-gray-100 text-gray-700 rounded px-1.5 py-0.5">{s}</span>
                        ))}
                        {more > 0 && <span className="text-xs text-gray-500 px-1 py-0.5">+{more} more</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
