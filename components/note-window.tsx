"use client";

import { useEffect, useState } from "react";
import { X, Trash2 } from "lucide-react";
import {
  canonicalScopeKey,
  defaultScopeLabel,
  notesForCell,
  scopeBreadcrumb,
  type NoteScope,
  type PLNote,
  type ScopeKey,
} from "@/lib/note-scope";

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export interface NoteWindowTarget {
  scope: NoteScope;
  /** Figure of the cell as it stands right now. */
  amount: number;
}

interface Props {
  target: NoteWindowTarget | null;
  notes: readonly PLNote[];
  scopeOrder: readonly ScopeKey[];
  /** Resolves stable ids back to display names (41309 → "41309 — DM Margin"). */
  labelFor?: (key: ScopeKey, value: string) => string;
  onClose: () => void;
  /** Opens the full detail for this cell, where notes are written. */
  onOpenDetail: () => void;
  /** Called after a note is deleted, so the page can refetch. */
  onChanged: () => void;
}

/**
 * Reading a note, and nothing else.
 *
 * Deliberately separate from the detail modal. Someone who already knows a note
 * is there wants to read it, not wait for every movement behind the figure to
 * load; and someone writing a note needs the movements in front of them to pick
 * what to anchor it to. One window cannot be short for the first and complete
 * for the second, so there are two.
 */
export function NoteWindow({ target, notes, scopeOrder, labelFor, onClose, onOpenDetail, onChanged }: Props) {
  const [error, setError] = useState("");

  // Deleting lives here and only here. It used to sit in the drawer that
  // this window replaces, and a note with no way to remove it is worse than
  // no note at all.
  async function remove(id: string) {
    setError("");
    try {
      const res = await fetch(`/api/pl-notes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not delete the note");
        return;
      }
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const { direct, rolledUp } = notesForCell(notes, target.scope);
  const all = [...direct, ...rolledUp];

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-slate-900/25" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Notes"
        className="fixed left-1/2 top-1/2 z-[71] flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#001A40]">
              {all.length} note{all.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">on this cell and below it</p>
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
            <p className="text-sm text-slate-400">No notes on this cell.</p>
          )}

          {all.map((n) => {
            const isDirect = n.scope_key === canonicalScopeKey(target.scope);
            const trail = scopeBreadcrumb(n.scope, scopeOrder, labelFor ?? defaultScopeLabel);
            const period = [n.scope.month, n.scope.year].filter(Boolean).join(" ");
            const then = n.amount_at_creation;
            // A difference is only worth showing when it is real: a cent of
            // rounding is noise, and on a month still open the figure was always
            // going to move.
            const moved = then != null && Math.abs(then - target.amount) > 0.005;

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
                  {/* The figure only belongs to the notes written on the cell
                      that was opened. A note rolled up from a deeper level is
                      about a different, smaller figure, and printing this one
                      beside it — or subtracting it from what was stored — would
                      be comparing two different numbers and calling the
                      difference a change. */}
                  {isDirect ? (
                    <>
                      <span className="font-mono text-sm font-bold tabular-nums text-[#001A40]">
                        {fmt(target.amount)}
                      </span>
                      {then == null ? (
                        <span className="text-[10px] text-slate-400">current amount</span>
                      ) : moved ? (
                        <span className="text-[10px] text-amber-700">
                          was <span className="font-mono line-through">{fmt(then)}</span>{" "}
                          · {fmt(target.amount - then)} since it was written
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">unchanged since it was written</span>
                      )}
                    </>
                  ) : then != null ? (
                    <span className="text-[10px] text-slate-500">
                      <span className="font-mono">{fmt(then)}</span> when it was written
                    </span>
                  ) : null}
                </div>

                <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">{n.note_text}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">
                    {n.author ?? "—"} · {when(n.created_at)}
                  </span>
                  <button
                    onClick={() => remove(n.id)}
                    aria-label="Delete note"
                    className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-slate-200 px-5 py-3">
          <button
            onClick={onOpenDetail}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300"
          >
            Open movements and write a note
          </button>
        </div>
      </div>
    </>
  );
}
