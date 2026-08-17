"use client";

import { useEffect, useMemo, useState } from "react";
import { X, MessageSquarePlus } from "lucide-react";
import type { AnchorOption, BreakdownRow, CellRef } from "@/lib/cell-ref";

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * One cell, one level down.
 *
 * Shows the figure that was clicked and the rows immediately beneath it — a
 * cost centre broken into categories, a category into accounts, an account into
 * descriptions — and nothing deeper. That is what makes every level cost the
 * same to open, and why a cost centre no longer drags its whole detail across
 * the wire.
 *
 * Every figure in it comes from the tree the table already built, including the
 * description breakdown at the bottom. It used to be a query, and a query
 * answers from the raw cost-centre assignment while the report answers from the
 * allocation split: on CC01 in June, 7 of 18 GL cells came back with a
 * breakdown that did not add up to the heading above it, the worst by
 * 10.161,63 against 18.993,66.
 *
 * It is also where notes are written, and the anchor is picked from a named
 * list: this cell, or any row of the breakdown. Never inferred from where the
 * click landed — that is what put notes meant for a transaction onto a
 * description, twice, without either person noticing.
 */
export function CellDetailModal({
  cell,
  onClose,
  onNoteSaved,
}: {
  cell: CellRef | null;
  onClose: () => void;
  onNoteSaved: () => void;
}) {
  /**
   * Which description to group by, as an index into `cell.descriptions`. Null
   * until the reader picks: preselecting would hide that the right choice is
   * account-dependent, which is the whole reason the choice exists.
   */
  const [descIdx, setDescIdx] = useState<number | null>(null);

  const [anchorKey, setAnchorKey] = useState<string>("");
  const [draft, setDraft]         = useState("");
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!cell) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cell, onClose]);

  // A new cell is a new choice, in both selectors.
  const cellKey = cell ? JSON.stringify(cell.scope) : "";
  useEffect(() => {
    setDescIdx(null); setAnchorKey(""); setDraft(""); setSaveError("");
  }, [cellKey]);

  /**
   * The breakdown, and with it the anchors on offer — they are the same rows.
   * A note is either about this cell or about one of the lines under it.
   */
  const breakdown = useMemo<BreakdownRow[] | null>(() => {
    if (!cell) return null;
    if (cell.children) return cell.children;
    if (descIdx == null) return null;
    return cell.descriptions?.[descIdx]?.rows ?? null;
  }, [cell, descIdx]);

  const anchors = useMemo<AnchorOption[]>(
    () => (cell ? [cell.self, ...(breakdown ?? [])] : []),
    [cell, breakdown],
  );
  const keyOf = (a: AnchorOption, i: number) => `${i}|${a.level}|${a.valueLabel}`;
  const anchor = anchors.find((a, i) => keyOf(a, i) === anchorKey) ?? null;

  if (!cell) return null;

  const byDescription = !cell.children && !!cell.descriptions;
  const columnLabel = cell.children
    ? cell.childLevelLabel
    : descIdx != null ? cell.descriptions?.[descIdx]?.label ?? null : null;
  const rowCount = cell.descriptions?.[0]?.rows.reduce((s, r) => s + (r.count ?? 0), 0) ?? 0;

  async function save() {
    const text = draft.trim();
    if (!text || !anchor) return;
    setSaving(true); setSaveError("");
    try {
      const res = await fetch("/api/pl-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level:          anchor.level,
          scope:          anchor.scope,
          transaction_id: anchor.scope.transaction_id ?? null,
          note_text:      text,
          // Stored now because it cannot be recovered later: pl_transactions
          // keeps no history, so once the figure moves the old one is gone.
          amount_at_creation: anchor.amount,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setSaveError(j.error ?? "Could not save the note");
        return;
      }
      setDraft("");
      setAnchorKey("");
      onNoteSaved();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-slate-900/30" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Cell detail"
        className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        {/* ── The cell itself ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-[#001A40]">{cell.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
              {cell.breadcrumb.map((part, i) => (
                <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-slate-300">›</span>}
                  {part}
                </span>
              ))}
            </p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className={`font-mono text-2xl font-bold tabular-nums ${cell.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                {fmt(cell.amount)}
              </span>
              <span className="text-[11px] text-slate-500">
                {/* The Total column is a period of its own — every month on
                    screen — and a note written there carries no month. */}
                {cell.month ?? "all months shown"}
              </span>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        {/* ── Which description, at the deepest level ─────────────────────── */}
        {byDescription && (
          <div className="border-b border-slate-200 px-5 py-3">
            <p className="mb-2 text-[11px] font-semibold text-slate-600">Break down by</p>
            <div className="flex flex-wrap gap-2">
              {cell.descriptions!.map((d, i) => {
                const empty = d.populated === 0;
                const usual = i === 0;
                return (
                  <button
                    key={d.level}
                    onClick={() => setDescIdx(i)}
                    title={empty ? "No rows in this cell carry this description" : undefined}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      descIdx === i
                        ? "border-sky-300 bg-sky-100 text-sky-900"
                        : empty
                          ? "border-slate-200 bg-slate-50 text-slate-400"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {d.label}
                    {/* The count is the whole point: picking an empty description
                        gives a blank list that reads as a broken page, and only
                        the data can say which one is populated for THIS cell. */}
                    <span className={`ml-1.5 font-mono text-[10px] ${empty ? "text-slate-400" : "text-slate-500"}`}>
                      {d.populated}
                    </span>
                    {usual && <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-400">usual</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── One level down ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto">
          {!breakdown && (
            <p className="p-5 text-sm text-slate-500">
              {byDescription
                ? <>Pick a description to break these {rowCount} movements down by.
                    The number on each option is how many of them carry it.</>
                : "Nothing below this level."}
            </p>
          )}

          {breakdown && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {columnLabel}
                  </th>
                  {byDescription && (
                    <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">Rows</th>
                  )}
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {cell.month ?? "Total"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row, i) => {
                  const k = keyOf(row, i + 1);
                  const picked = anchorKey === k;
                  return (
                    <tr
                      key={k}
                      // A shortcut for the selector below, not a second way of
                      // choosing: both drive the same value, and the composer
                      // restates it in words before anything is saved.
                      onClick={() => setAnchorKey(picked ? "" : k)}
                      className={`cursor-pointer border-b border-slate-200/60 ${picked ? "bg-sky-50" : "hover:bg-slate-50"}`}
                      style={{ backgroundColor: picked ? undefined : i % 2 ? "#fcfdfe" : "#ffffff" }}
                    >
                      <td className="max-w-[420px] truncate px-3 py-1.5 text-slate-700" title={row.valueLabel}>
                        {row.valueLabel}
                      </td>
                      {byDescription && (
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{row.count}</td>
                      )}
                      <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${row.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                        {fmt(row.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Composer ────────────────────────────────────────────────────── */}
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">
          <label className="mb-1.5 block text-[11px] font-semibold text-slate-600" htmlFor="note-anchor">
            Write a note about
          </label>
          <select
            id="note-anchor"
            value={anchorKey}
            onChange={(e) => setAnchorKey(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:border-[#001A40] focus:outline-none"
          >
            {/* No preselection. An anchor chosen by default is an anchor chosen
                by accident — which is how this went wrong in the first place. */}
            <option value="">— pick what the note is about —</option>
            {anchors.map((a, i) => (
              <option key={keyOf(a, i)} value={keyOf(a, i)}>
                {i === 0 ? "This cell" : a.levelLabel} · {a.valueLabel} · {fmt(a.amount)}
              </option>
            ))}
          </select>

          {saveError && (
            <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600">
              {saveError}
            </p>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={anchor ? `Note on ${anchor.valueLabel}…` : "Pick what the note is about, then write it…"}
            className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[10px] text-slate-400">
              {anchor
                ? <>Anchored to {anchor.levelLabel} · {anchor.valueLabel}
                    {cell.month ? ` · ${cell.month}` : " · all months shown"} ·{" "}
                    <span className="font-mono">{fmt(anchor.amount)}</span> at the time of writing</>
                : "Nothing picked yet."}
            </p>
            <button
              onClick={save}
              disabled={saving || !anchor || draft.trim().length === 0}
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
