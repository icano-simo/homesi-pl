"use client";

import { useEffect, useState } from "react";
import { X, Trash2, Pencil, MessageSquarePlus } from "lucide-react";
import {
  canonicalScopeKey,
  defaultScopeLabel,
  notesForCell,
  scopeBreadcrumb,
  type PLNote,
  type ScopeKey,
} from "@/lib/note-scope";
import type { CellRef } from "@/lib/cell-ref";

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

interface Props {
  cell: CellRef | null;
  notes: readonly PLNote[];
  scopeOrder: readonly ScopeKey[];
  /** Resolves stable ids back to display names (41309 → "41309 — DM Margin"). */
  labelFor?: (key: ScopeKey, value: string) => string;
  onClose: () => void;
  /** Opens the detail window for the same cell — the level below it. */
  onOpenDetail: () => void;
  /** Called after a note is written, edited or deleted. */
  onChanged: () => void;
}

/**
 * The notes on one cell: read, edit, add.
 *
 * Deliberately separate from the detail window. Someone who already knows a
 * note is there wants to read it, not wait for a breakdown to load; and every
 * note written here is about this cell and nothing else, so there is no anchor
 * to choose. The detail window is where a note can be pointed at a row one
 * level down instead — that is the only difference between them, and it is why
 * both exist.
 */
export function NoteWindow({
  cell, notes, scopeOrder, labelFor, onClose, onOpenDetail, onChanged,
}: Props) {
  const [error, setError]   = useState("");
  const [draft, setDraft]   = useState("");
  const [saving, setSaving] = useState(false);
  /** Note being edited, and the text as it stands in the box. */
  const [editId, setEditId]     = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const cellKey = cell ? canonicalScopeKey(cell.scope) : "";
  useEffect(() => { setDraft(""); setError(""); setEditId(null); }, [cellKey]);

  useEffect(() => {
    if (!cell) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cell, onClose]);

  async function send(url: string, init: RequestInit, fail: string) {
    setError("");
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? fail);
        return false;
      }
      onChanged();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  async function add() {
    const text = draft.trim();
    if (!text || !cell) return;
    setSaving(true);
    const ok = await send("/api/pl-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level:          cell.self.level,
        scope:          cell.self.scope,
        transaction_id: cell.self.scope.transaction_id ?? null,
        note_text:      text,
        amount_at_creation: cell.self.amount,
      }),
    }, "Could not save the note");
    if (ok) setDraft("");
    setSaving(false);
  }

  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    // Only the text. The anchor is immutable — a note that belongs somewhere
    // else is a different note, and silently moving one would change which
    // figure it was written against without saying so.
    const ok = await send(`/api/pl-notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_text: text }),
    }, "Could not save the change");
    if (ok) setEditId(null);
  }

  if (!cell) return null;

  const { direct, rolledUp } = notesForCell(notes, cell.scope);
  const all = [...direct, ...rolledUp];

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-slate-900/25" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Notes"
        className="fixed left-1/2 top-1/2 z-[71] flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        {/* ── The cell these notes are about ──────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1 text-[11px] font-medium text-slate-500">
              {cell.breadcrumb.map((part, i) => (
                <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-slate-300">›</span>}
                  <span className={i === cell.breadcrumb.length - 1 ? "text-[#001A40]" : ""}>{part}</span>
                </span>
              ))}
            </p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className={`font-mono text-xl font-bold tabular-nums ${cell.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                {fmt(cell.amount)}
              </span>
              <span className="text-[10px] text-slate-400">
                {cell.month ?? "all months shown"} · as it stands now
              </span>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {error && (
            <p className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600">{error}</p>
          )}
          {all.length === 0 && (
            <p className="text-sm text-slate-400">No notes on this cell yet.</p>
          )}

          {all.map((n) => {
            const isDirect = n.scope_key === cellKey;
            const trail = scopeBreadcrumb(n.scope, scopeOrder, labelFor ?? defaultScopeLabel);
            const period = [n.scope.month, n.scope.year].filter(Boolean).join(" ");
            const then = n.amount_at_creation;
            // A difference is only worth showing when it is real: a cent of
            // rounding is noise, and on a month still open the figure was always
            // going to move.
            const moved = then != null && Math.abs(then - cell.amount) > 0.005;

            return (
              <div key={n.id} className="border-b border-slate-200/70 py-3 last:border-0">
                {/* What it is anchored to, in words. The raw scope_key answers
                    the same question and nobody can read it. */}
                <p className="flex flex-wrap items-center gap-1 text-[11px] font-medium text-slate-500">
                  {trail.map((part, i) => (
                    <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                      {i > 0 && <span className="text-slate-300">›</span>}
                      <span className={i === trail.length - 1 ? "text-[#001A40]" : ""}>{part}</span>
                    </span>
                  ))}
                  {!isDirect && (
                    <span className="ml-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
                      from a more detailed level
                    </span>
                  )}
                </p>

                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                  {period && <span className="text-[11px] font-semibold text-slate-600">{period}</span>}
                  {/* The figure belongs only to the notes written on the cell
                      that was opened. A note rolled up from a deeper level is
                      about a different, smaller figure, and subtracting this one
                      from what was stored would call the gap between two
                      different numbers a change. */}
                  {isDirect ? (
                    then == null ? (
                      <span className="text-[10px] text-slate-400">no figure recorded when written</span>
                    ) : moved ? (
                      <span className="text-[10px] text-amber-700">
                        was <span className="font-mono line-through">{fmt(then)}</span>{" "}
                        · {fmt(cell.amount - then)} since it was written
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400">unchanged since it was written</span>
                    )
                  ) : then != null ? (
                    <span className="text-[10px] text-slate-500">
                      <span className="font-mono">{fmt(then)}</span> when it was written
                    </span>
                  ) : null}
                </div>

                {editId === n.id ? (
                  <div className="mt-1.5">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 focus:border-[#001A40] focus:outline-none"
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        onClick={() => saveEdit(n.id)}
                        disabled={editText.trim().length === 0}
                        className="rounded-full bg-[#001A40] px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditId(null)}
                        className="text-[11px] text-slate-500 hover:text-slate-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">{n.note_text}</p>
                )}

                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">
                    {n.author ?? "—"} · {when(n.created_at)}
                    {n.updated_at !== n.created_at && <> · edited {when(n.updated_at)}</>}
                  </span>
                  {editId !== n.id && (
                    <span className="flex items-center gap-0.5">
                      <button
                        onClick={() => { setEditId(n.id); setEditText(n.note_text); }}
                        aria-label="Edit note"
                        className="rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => send(`/api/pl-notes/${n.id}`, { method: "DELETE" }, "Could not delete the note")}
                        aria-label="Delete note"
                        className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Add, always on this cell ────────────────────────────────────── */}
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={`Note on ${cell.self.valueLabel}…`}
            className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <button
              onClick={onOpenDetail}
              className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-600 hover:border-slate-300"
            >
              Break it down a level
            </button>
            <button
              onClick={add}
              disabled={saving || draft.trim().length === 0}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
            >
              <MessageSquarePlus size={13} />
              {saving ? "Saving…" : "Add note"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
