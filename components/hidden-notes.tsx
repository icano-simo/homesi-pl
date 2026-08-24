"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import type { PLNote } from "@/lib/note-scope";

/** One note the active filters are keeping off the report, and what is keeping it. */
export interface HiddenNote {
  note: PLNote;
  /** Display name of the cost centre it is anchored to, or null for none. */
  costCenter: string | null;
  /** Branch it is anchored to, or null for none. */
  branch: string | null;
  /** Which dimensions put it outside the active scope. */
  reasons: string[];
}

/**
 * A count, and nothing else until it is asked.
 *
 * Hidden on purpose when there is nothing hidden. A zero belongs on a status
 * counter — "0 conflicts" says someone looked — but this is a warning, and a
 * warning that is always on screen stops being read.
 */
export function HiddenNotesBadge({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button
      onClick={onOpen}
      title={`${count} note${count === 1 ? "" : "s"} not shown with the active filters`}
      aria-label={`${count} notes hidden by the active filters`}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-300 bg-amber-100 text-[11px] font-bold text-amber-800 hover:bg-amber-200"
    >
      {count}
    </button>
  );
}

/**
 * The list behind the badge.
 *
 * Deliberately NOT the notes window. That one is built around a cell — its
 * anchor drives the composer, its scope drives the containment test, its figure
 * drives the "since it was written" line. These notes are the ones that FAIL
 * that containment: there is no cell, no anchor to write against and no figure
 * to compare, so reusing it would mean a flag that switches off most of it.
 *
 * What this has to say instead is why each note is out of scope, which the other
 * window has no reason to know.
 */
export function HiddenNotesModal({
  open, notes, onClose,
}: {
  open: boolean;
  notes: readonly HiddenNote[];
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-slate-900/25" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Notes hidden by the active filters"
        className="fixed left-1/2 top-1/2 z-[71] flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#001A40]">
              {notes.length} note{notes.length === 1 ? "" : "s"} not shown
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              A note appears only where the report carries every constraint the note does. Nothing
              has been deleted — clear the filter each one names to read it.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {notes.map(({ note, costCenter, branch, reasons }) => (
            <div key={note.id} className="border-b border-slate-200/70 py-3 last:border-0">
              {/* Both dimensions, always. A note can be out of scope by cost
                  centre, by branch or by both, and whoever opens this needs to
                  know which — that is the whole reason the badge is clickable. */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip
                  label="cost center"
                  value={costCenter}
                  none="no cost center"
                  flagged={reasons.includes("cost_center")}
                />
                <Chip
                  label="branch"
                  value={branch}
                  none="no branch"
                  flagged={reasons.includes("branch")}
                />
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-snug text-slate-800">
                {note.note_text}
              </p>
              <p className="mt-1 text-[10px] text-slate-400">{note.author ?? "—"}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Amber when this is what puts the note out of scope; quiet otherwise. */
function Chip({
  label, value, none, flagged,
}: { label: string; value: string | null; none: string; flagged: boolean }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
        flagged
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-slate-200 bg-slate-50 text-slate-500"
      }`}
    >
      {value ? `${label} ${value}` : none}
    </span>
  );
}
