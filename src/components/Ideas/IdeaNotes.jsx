import React, { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";

// Team progress notes on an idea/deck. Author = logged-in user's email prefix.
export default function IdeaNotes({ ideaId }) {
  const { supabase, session } = useSupabase();
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!ideaId) return;
    const { data, error } = await supabase
      .from("idea_notes")
      .select("id, author, body, created_at")
      .eq("idea_id", ideaId)
      .order("created_at", { ascending: false });
    if (!error) setNotes(data || []);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    const author =
      session?.user?.email?.split("@")[0] || session?.user?.email || "team";
    const { error } = await supabase
      .from("idea_notes")
      .insert({ idea_id: ideaId, author, body });
    setBusy(false);
    if (!error) {
      setDraft("");
      load();
    }
  };

  const fmt = (d) => {
    const date = new Date(d);
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days === 0)
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Progress notes
      </label>
      <div className="flex gap-2 mb-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="e.g. sent to Nicole, waiting on pricing"
          className="input block w-full rounded-md border-gray-300 shadow-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !draft.trim()}
          className="px-3 rounded-md bg-chabot-gold text-white disabled:opacity-40"
          title="Add note"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto space-y-2">
        {notes.map((n) => (
          <div key={n.id} className="bg-gray-50 border rounded-md px-3 py-2 text-sm">
            <div className="flex justify-between text-xs text-gray-500 mb-0.5">
              <span className="font-medium text-gray-700">{n.author}</span>
              <span>{fmt(n.created_at)}</span>
            </div>
            <div className="whitespace-pre-wrap">{n.body}</div>
          </div>
        ))}
        {notes.length === 0 && (
          <div className="text-xs text-gray-400">No notes yet.</div>
        )}
      </div>
    </div>
  );
}
