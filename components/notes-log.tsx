"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquarePlus, Trash2, Loader2 } from "lucide-react";
import { canonicalScopeKey, type NoteScope, type PLNote } from "@/lib/note-scope";

/**
 * Chronological note log for a single entity — a cost center, an employee, a
 * vendor.
 *
 * Deliberately not the pivot's note system. Those notes are anchored to a cell
 * and roll up through the hierarchy; these belong to one entity and answer
 * "why did this change?". Same table, but the lookup here is one exact match on
 * scope_key rather than a containment walk, and nothing aggregates.
 */
export interface NotesLogProps {
  /** Stored on the note; groups log entries by the kind of entity. */
  level: string;
  /** Exact anchor, e.g. { cost_center_id: "…" } or { assign_type, assign_value }. */
  scope: NoteScope;
  /** Shown above the composer so it is obvious what the note attaches to. */
  entityLabel: string;
  emptyMessage?: string;
  className?: string;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function NotesLog({
  level,
  scope,
  entityLabel,
  emptyMessage = "No notes yet.",
  className = "",
}: NotesLogProps) {
  const [notes, setNotes] = useState<PLNote[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Serialize the scope so the effect re-runs when the selected entity changes
  // — an object literal would be a new reference on every render.
  const scopeKey = canonicalScopeKey(scope);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams({ level, scope_key: scopeKey });
      const res = await fetch(`/api/pl-notes?${p}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not load notes");
        return;
      }
      setNotes(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [level, scopeKey]);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    const text = draft.trim();
    if (!text) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/pl-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, scope, note_text: text }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not save the note");
        return;
      }
      setDraft("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError("");
    try {
      const res = await fetch(`/api/pl-notes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not delete the note");
        return;
      }
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-600">
          {error}
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-1.5 py-2 text-[11px] text-slate-400">
          <Loader2 size={12} className="animate-spin" /> Loading notes…
        </p>
      ) : notes.length === 0 ? (
        <p className="py-1 text-[11px] italic text-slate-400">{emptyMessage}</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="whitespace-pre-wrap text-[12px] text-slate-800">{n.note_text}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">
                  {n.author ? `${n.author} · ` : ""}{formatWhen(n.created_at)}
                </span>
                <button
                  onClick={() => remove(n.id)}
                  aria-label="Delete note"
                  className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={`Why did this change? Add a note for ${entityLabel}…`}
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
        />
        <button
          onClick={add}
          disabled={saving || draft.trim().length === 0}
          className="mt-2 flex items-center gap-1.5 rounded-full bg-[#FF4040] px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
        >
          <MessageSquarePlus size={13} />
          {saving ? "Saving…" : "Add note"}
        </button>
      </div>
    </div>
  );
}
