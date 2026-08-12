"use client";

import { useEffect, useMemo, useState } from "react";
import { X, MessageSquarePlus, Trash2, CornerDownRight } from "lucide-react";
import {
  SCOPE_LABELS,
  canonicalScopeKey,
  notesForCell,
  scopeBreadcrumb,
  type NoteScope,
  type PLNote,
  type ScopeKey,
} from "@/lib/note-scope";
import type { TxLeaf } from "@/lib/pivot-engine";

export interface NoteDrawerCell {
  /** Dimension constraints of the clicked cell, period included. */
  scope: NoteScope;
  /** Trail shown as the drawer heading, e.g. ["Income", "Revenue", "April"]. */
  breadcrumb: string[];
  amount: number;
  month: string | null;
  /** Transactions making up the amount. Empty for aggregate rows whose
   *  children are still collapsed — the pivot only materializes leaves. */
  transactions: TxLeaf[];
  /** Set when the cell is a single transaction, so the note can be anchored to it. */
  transactionId?: string | null;
  /** Coarse level recorded on the note, derived from the deepest dimension. */
  level: string;
}

interface Props {
  cell: NoteDrawerCell | null;
  notes: readonly PLNote[];
  onClose: () => void;
  onChanged: () => void;
  /** Resolves stable ids back to display names for rolled-up breadcrumbs. */
  labelFor?: (key: ScopeKey, value: string) => string;
  scopeOrder: readonly ScopeKey[];
}

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function NoteDrawer({ cell, notes, onClose, onChanged, labelFor, scopeOrder }: Props) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset the composer whenever a different cell is opened.
  useEffect(() => { setDraft(""); setError(""); }, [cell ? canonicalScopeKey(cell.scope) : null]);

  // Close on Escape — the drawer traps no focus, so this is the expected exit.
  useEffect(() => {
    if (!cell) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cell, onClose]);

  const { direct, rolledUp } = useMemo(
    () => (cell ? notesForCell(notes, cell.scope) : { direct: [], rolledUp: [] }),
    [notes, cell],
  );

  if (!cell) return null;

  async function save() {
    const text = draft.trim();
    if (!text || !cell) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/pl-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level:          cell.level,
          scope:          cell.scope,
          transaction_id: cell.transactionId ?? null,
          note_text:      text,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Could not save the note");
        return;
      }
      setDraft("");
      onChanged();
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
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-slate-900/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Cell notes"
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l border-slate-200 bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1 text-[11px] font-medium text-slate-500">
                {cell.breadcrumb.map((part, i) => (
                  <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                    {i > 0 && <span className="text-slate-300">›</span>}
                    <span className={i === cell.breadcrumb.length - 1 ? "text-[#001A40]" : ""}>{part}</span>
                  </span>
                ))}
              </p>
              <p className={`mt-1 font-mono text-2xl font-bold tabular-nums ${cell.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                {fmt(cell.amount)}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Transactions behind the amount */}
          <section className="border-b border-slate-200 px-5 py-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Transactions ({cell.transactions.length})
            </h3>
            {cell.transactions.length === 0 ? (
              <p className="text-[11px] italic text-slate-400">
                Expand this row to list the individual transactions.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {cell.transactions.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-baseline justify-between gap-3 rounded-lg border border-slate-200/80 px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate text-[11px] text-slate-700">
                      {t.desc ?? t.vendor ?? "—"}
                    </span>
                    <span className={`shrink-0 font-mono text-[11px] tabular-nums ${t.mvmt < 0 ? "text-rose-600" : "text-slate-800"}`}>
                      {fmt(t.mvmt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Notes on this exact cell */}
          <section className="px-5 py-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Notes on this level ({direct.length})
            </h3>
            {direct.length === 0 ? (
              <p className="text-[11px] italic text-slate-400">No notes at this level yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {direct.map((n) => (
                  <li key={n.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="whitespace-pre-wrap text-[12px] text-slate-800">{n.note_text}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">
                        {n.author ? `${n.author} · ` : ""}{timeAgo(n.created_at)}
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
          </section>

          {/* Notes inherited from more granular levels */}
          {rolledUp.length > 0 && (
            <section className="border-t border-slate-200 px-5 py-4">
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                From more detailed levels ({rolledUp.length})
              </h3>
              <ul className="flex flex-col gap-2">
                {rolledUp.map((n) => (
                  <li key={n.id} className="rounded-xl border border-slate-200/80 p-3">
                    {/* Each inherited note carries its own trail, so it is never
                        ambiguous which row down the tree it was written on. */}
                    <p className="mb-1.5 flex items-center gap-1 text-[10px] text-slate-400">
                      <CornerDownRight size={10} className="shrink-0" />
                      <span className="truncate">
                        {scopeBreadcrumb(n.scope, scopeOrder, labelFor).join(" › ")}
                      </span>
                    </p>
                    <p className="whitespace-pre-wrap text-[12px] text-slate-700">{n.note_text}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">
                        {n.author ? `${n.author} · ` : ""}{timeAgo(n.created_at)}
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
            </section>
          )}
        </div>

        {/* Composer — always anchored to the cell that is open */}
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
          {error && (
            <p className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600">
              {error}
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Add a note at this level…"
            className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
          />
          <button
            onClick={save}
            disabled={saving || draft.trim().length === 0}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
          >
            <MessageSquarePlus size={13} />
            {saving ? "Saving…" : "Add note"}
          </button>
          <p className="mt-1.5 text-center text-[10px] text-slate-400">
            Anchored to {scopeBreadcrumb(cell.scope, scopeOrder, labelFor).join(" › ") || "the grand total"}
          </p>
        </div>
      </aside>
    </>
  );
}

/** Label for a scope key/value pair, used when no resolver is supplied. */
export function defaultScopeLabel(key: ScopeKey, value: string): string {
  if (value === "__unassigned__") return "Unassigned";
  if (value === "__conflict__")   return "Conflict";
  if (value === "__no_loan__")    return "No Loan Number";
  if (key === "year") return String(value);
  return value || SCOPE_LABELS[key];
}
