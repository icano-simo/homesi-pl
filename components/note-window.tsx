"use client";

import { useEffect, useState } from "react";
import { X, Trash2, Pencil, MessageSquarePlus } from "lucide-react";
import {
  canonicalScopeKey,
  defaultScopeLabel,
  notesForCell,
  scopeBreadcrumb,
  type NoteScope,
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

/**
 * The branch a note was written under, first and always.
 *
 * It is the one thing that tells a reader at a glance whether branches are
 * being mixed, and until the branch entered the anchor a note written looking
 * at 700 turned up under 710. Amber when absent, because "no branch" is a real
 * state with a real consequence — the note only shows while no branch is
 * filtered — and not a missing value to gloss over.
 */
function BranchChip({ branch }: { branch: string | null }) {
  return branch ? (
    <span className="rounded-full border border-sky-300 bg-sky-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-sky-900">
      BRANCH {branch}
    </span>
  ) : (
    <span
      title="Written before notes carried a branch, or with several branches active. It shows only while no branch is filtered."
      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-800"
    >
      NO BRANCH
    </span>
  );
}

const branchOf = (s: NoteScope): string | null =>
  s.branch === undefined || s.branch === null ? null : String(s.branch);

interface Props {
  cell: CellRef | null;
  notes: readonly PLNote[];
  scopeOrder: readonly ScopeKey[];
  /** Resolves stable ids back to display names (41309 to "41309 — DM Margin"). */
  labelFor?: (key: ScopeKey, value: string) => string;
  /** Branches the report is scoped to, for the warning on the composer. */
  activeBranches: readonly string[];
  onClose: () => void;
  /** Opens the detail window for the same cell — the level below it. */
  onOpenDetail: () => void;
  /** Called after a note is written, edited or deleted. */
  onChanged: () => void;
}

/**
 * The notes on one cell: read, edit, add.
 *
 * Laid out in bands rather than one run of text. It used to put the trail, the
 * "from a more detailed level" tag, both amounts, the author and the date into a
 * single paragraph and nothing could be found in it. Now each note reads
 * top-down: which branch and period, what it is anchored to, what it says, and
 * only then the bookkeeping.
 */
export function NoteWindow({
  cell, notes, scopeOrder, labelFor, activeBranches, onClose, onOpenDetail, onChanged,
}: Props) {
  const [error, setError]   = useState("");
  const [draft, setDraft]   = useState("");
  const [saving, setSaving] = useState(false);
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
  const cellBranch = branchOf(cell.scope);

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-slate-900/25" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Notes"
        className="fixed left-1/2 top-1/2 z-[71] flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        {/* The cell these notes are about */}
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <BranchChip branch={cellBranch} />
                <span className="text-[11px] font-semibold text-slate-600">
                  {cell.month ?? "all months shown"}
                </span>
              </div>
              <p className="mt-1.5 truncate text-[11px] text-slate-500" title={cell.breadcrumb.join(" > ")}>
                {cell.breadcrumb.join(" › ")}
              </p>
              <p className={`mt-1 font-mono text-xl font-bold tabular-nums ${cell.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                {fmt(cell.amount)}
              </p>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <X size={16} />
            </button>
          </div>
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
            // The branch has its own chip above; repeating it inside the trail
            // is the kind of duplication that made this window unreadable.
            const noteBranch = branchOf(n.scope);
            const trail = scopeBreadcrumb(n.scope, scopeOrder, labelFor ?? defaultScopeLabel)
              .filter((p) => p !== noteBranch);
            const period = [n.scope.month, n.scope.year].filter(Boolean).join(" ");
            const then = n.amount_at_creation;
            const moved = then != null && Math.abs(then - cell.amount) > 0.005;

            return (
              <div key={n.id} className="border-b border-slate-200/70 py-3 last:border-0">
                {/* Band 1 — where and when. Always, and always first. */}
                <div className="flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <BranchChip branch={noteBranch} />
                    {period && <span className="text-[11px] font-semibold text-slate-600">{period}</span>}
                    {!isDirect && (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
                        from a deeper level
                      </span>
                    )}
                  </span>
                  {editId !== n.id && (
                    <span className="flex shrink-0 items-center gap-0.5">
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

                {/* Band 2 — what it is anchored to, one line. */}
                <p className="mt-1 truncate text-[11px] text-slate-400" title={trail.join(" > ")}>
                  {trail.join(" › ") || "the whole report"}
                </p>

                {/* Band 3 — the note. The reason the window exists, so it gets
                    the room and the only full-size type here. */}
                {editId === n.id ? (
                  <div className="mt-2">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800 focus:border-[#001A40] focus:outline-none"
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        onClick={() => saveEdit(n.id)}
                        disabled={editText.trim().length === 0}
                        className="rounded-full bg-[#001A40] px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button onClick={() => setEditId(null)} className="text-[11px] text-slate-500 hover:text-slate-700">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800">{n.note_text}</p>
                )}

                {/* Band 4 — bookkeeping, deliberately quiet. */}
                <p className="mt-2 text-[10px] text-slate-400">
                  {n.author ?? "—"} · {when(n.created_at)}
                  {n.updated_at !== n.created_at && <> · edited {when(n.updated_at)}</>}
                  {isDirect
                    ? then == null
                      ? <> · no figure recorded when written</>
                      : moved
                        ? <> · was <span className="font-mono text-amber-700">{fmt(then)}</span>, {fmt(cell.amount - then)} since</>
                        : <> · unchanged since written</>
                    : then != null
                      ? <> · <span className="font-mono">{fmt(then)}</span> when written</>
                      : null}
                </p>
              </div>
            );
          })}
        </div>

        {/* Add, always on this cell */}
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">
          {/* Without this, someone writes a note believing it belongs to one
              branch when it belongs to none. */}
          {!cellBranch && (
            <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
              {activeBranches.length > 1
                ? `${activeBranches.length} branches active (${activeBranches.join(", ")}) — a note written now is not tied to any one of them, and will only show while no branch is filtered.`
                : "No branch filter — a note written now is not tied to a branch, and will only show while no branch is filtered."}
            </p>
          )}
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
