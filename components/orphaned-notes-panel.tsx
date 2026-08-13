"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Link2, Trash2 } from "lucide-react";
import {
  SCOPE_LABELS,
  scopeBreadcrumb,
  type PLNote,
  type ScopeKey,
} from "@/lib/note-scope";
import type { PLReportTx } from "@/types";

/**
 * Notes whose transaction was deleted by a re-upload and could not be matched
 * back automatically.
 *
 * Before this existed such notes were dropped from the render and became
 * unreachable — present in the database, invisible in the app. The point of the
 * panel is that losing a transaction never silently loses the comment about it.
 */
interface Props {
  orphans: readonly PLNote[];
  /** Candidates offered when re-linking by hand — the loaded report's rows. */
  transactions: readonly PLReportTx[];
  onChanged: () => void;
  scopeOrder: readonly ScopeKey[];
  labelFor?: (key: ScopeKey, value: string) => string;
}

function whenOrphaned(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const money = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function OrphanedNotesPanel({
  orphans, transactions, onChanged, scopeOrder, labelFor,
}: Props) {
  const [open, setOpen] = useState(true);
  const [relinking, setRelinking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Candidate list for manual re-linking. Narrowed by the note's own scope
  // where possible — a note that remembers its GL code and month should not
  // offer every transaction in the report.
  const candidatesFor = useMemo(() => (note: PLNote) => {
    const gl = note.scope.gl;
    const month = note.scope.month;
    return transactions
      .filter(t => (!gl || t.gl_code === String(gl)) && (!month || t.month === String(month)))
      .slice(0, 200);
  }, [transactions]);

  if (orphans.length === 0) return null;

  async function relink(noteId: string, transactionId: string) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/pl-notes/${noteId}/relink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not re-link the note");
        return;
      }
      setRelinking(null);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function discard(noteId: string) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/pl-notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not discard the note");
        return;
      }
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 shadow-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        {open
          ? <ChevronDown  size={14} className="shrink-0 text-amber-500" />
          : <ChevronRight size={14} className="shrink-0 text-amber-500" />}
        <AlertTriangle size={13} className="shrink-0 text-amber-500" />
        <span className="text-xs font-bold uppercase tracking-wider text-[#001A40]">
          Orphaned Notes
        </span>
        <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-bold text-amber-900">
          {orphans.length}
        </span>
        <span className="truncate text-xs text-slate-500">
          — their transaction was removed by a re-upload
        </span>
      </button>

      {open && (
        <div className="border-t border-amber-200 px-4 py-3">
          {error && (
            <p className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-600">
              {error}
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {orphans.map((n) => {
              const trail = scopeBreadcrumb(n.scope, scopeOrder, labelFor);
              const candidates = candidatesFor(n);
              return (
                <li key={n.id} className="rounded-xl border border-amber-200/80 bg-white p-3">
                  {/* The stored scope survives the transaction, so the note can
                      still say which GL / category / month it was about. */}
                  <p className="mb-1 truncate text-[10px] text-slate-400">
                    {trail.length > 0 ? trail.join(" › ") : "No scope recorded"}
                  </p>
                  <p className="whitespace-pre-wrap text-[12px] text-slate-800">{n.note_text}</p>
                  <p className="mt-1.5 text-[10px] text-slate-400">
                    Orphaned {whenOrphaned(n.orphaned_at)}
                  </p>

                  {relinking === n.id ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Pick the transaction this note belongs to
                      </p>
                      {candidates.length === 0 ? (
                        <p className="text-[11px] italic text-slate-400">
                          No transaction in the loaded report matches this note&apos;s scope.
                          Load the period it belongs to and try again.
                        </p>
                      ) : (
                        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                          {candidates.map((t) => (
                            <li key={t.id}>
                              <button
                                onClick={() => relink(n.id, t.id)}
                                disabled={busy}
                                className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-slate-200 px-2.5 py-1.5 text-left hover:border-[#001A40] disabled:opacity-40"
                              >
                                <span className="min-w-0 truncate text-[11px] text-slate-700">
                                  {t.month} · {t.check_description ?? t.vendor ?? "—"}
                                </span>
                                <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-800">
                                  {money(t.movement)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        onClick={() => setRelinking(null)}
                        className="self-start text-[11px] text-slate-400 underline hover:text-slate-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        onClick={() => setRelinking(n.id)}
                        className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-600 hover:border-[#001A40]"
                      >
                        <Link2 size={11} /> Re-link
                      </button>
                      <button
                        onClick={() => discard(n.id)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-400 hover:border-rose-300 hover:text-rose-600 disabled:opacity-40"
                      >
                        <Trash2 size={11} /> Discard
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="mt-2 text-[10px] text-slate-400">
            {SCOPE_LABELS.transaction_id}-level notes appear here when their row was
            replaced and no single new transaction matched its content.
          </p>
        </div>
      )}
    </div>
  );
}
