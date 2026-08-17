"use client";

import { useEffect, useMemo, useState } from "react";
import { X, MessageSquarePlus } from "lucide-react";
import type { AnchorOption, BreakdownMode, BreakdownRow, CellRef } from "@/lib/cell-ref";
import { canonicalScopeKey, scopeContains, type NoteScope, type PLNote } from "@/lib/note-scope";

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Solid: written here. Hollow: written somewhere below this. */
function Dot({ state }: { state: "direct" | "below" | null }) {
  if (!state) return null;
  return (
    <span
      aria-label={state === "direct" ? "Has a note" : "Has notes at a more detailed level"}
      className={`mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${
        state === "direct" ? "bg-[#FF4040]" : "border border-[#001A40]/40"
      }`}
    />
  );
}

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
 * On the Total column the same rows can be read two ways — a matrix of months,
 * or a list with a month column — and the reader picks, from a switch that is
 * always on screen. Never automatically: a table that changes shape on its own
 * does not say why.
 */
export function CellDetailModal({
  cell,
  notes,
  onClose,
  onNoteSaved,
}: {
  cell: CellRef | null;
  /** Resolved notes, for the indicators on the breakdown rows. */
  notes: readonly PLNote[];
  onClose: () => void;
  onNoteSaved: () => void;
}) {
  /**
   * Which description to group by, as an index into `cell.descriptions`. Null
   * until the reader picks: preselecting would hide that the right choice is
   * account-dependent, which is the whole reason the choice exists.
   */
  const [descIdx, setDescIdx] = useState<number | null>(null);
  /** Null until a description is picked, then seeded from its suggestion. */
  const [mode, setMode] = useState<BreakdownMode | null>(null);
  /** List view only. Null is every month. */
  const [monthFilter, setMonthFilter] = useState<string | null>(null);

  /** Which description row was clicked, and on which month if any. */
  const [picked, setPicked] = useState<{ key: string; month: string | null } | null>(null);
  /** Grain of the anchor: the cell itself, the description, or one of its months. */
  const [grain, setGrain] = useState<"" | "self" | "row" | "cell">("");

  const [draft, setDraft]         = useState("");
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!cell) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cell, onClose]);

  // A new cell is a new set of choices.
  const cellKey = cell ? JSON.stringify(cell.scope) : "";
  useEffect(() => {
    setDescIdx(null); setMode(null); setMonthFilter(null);
    setPicked(null); setGrain(""); setDraft(""); setSaveError("");
  }, [cellKey]);

  const desc = cell && descIdx != null ? cell.descriptions?.[descIdx] ?? null : null;

  /** Picking a description re-suggests the mode; the reader can still change it. */
  function chooseDesc(i: number) {
    setDescIdx(i);
    setMode(cell?.descriptions?.[i]?.suggestedMode ?? null);
    setMonthFilter(null);
    setPicked(null); setGrain("");
  }

  /**
   * Note state for a scope, under the rule the whole report uses: a note shows
   * on a cell when its own scope carries every constraint of that cell.
   *
   * Which is why a note on a description across all months does not appear on
   * that description's month cells — it has no month, so it is the looser of
   * the two and cannot roll down. Nothing to draw there, and one note never
   * paints twelve marks.
   */
  const noteAt = useMemo(() => {
    const own = new Set(notes.map((n) => n.scope_key));
    return (scope: NoteScope): "direct" | "below" | null => {
      const k = canonicalScopeKey(scope);
      if (own.has(k)) return "direct";
      return notes.some((n) => n.scope_key !== k && scopeContains(n.scope, scope)) ? "below" : null;
    };
  }, [notes]);

  const rowByKey = useMemo(() => {
    const m = new Map<string, BreakdownRow>();
    for (const r of desc?.rows ?? []) if (r.key) m.set(r.key, r);
    return m;
  }, [desc]);

  const cellByKey = useMemo(() => {
    const m = new Map<string, BreakdownRow>();
    for (const r of desc?.perMonth ?? desc?.rows ?? []) {
      if (r.key) m.set(`${r.key}|${r.month ?? ""}`, r);
    }
    return m;
  }, [desc]);

  /** Only what this view can actually represent is offered. */
  const anchors = useMemo<{ id: "self" | "row" | "cell"; label: string; a: AnchorOption }[]>(() => {
    if (!cell) return [];
    const out: { id: "self" | "row" | "cell"; label: string; a: AnchorOption }[] = [
      { id: "self", label: "This cell", a: cell.self },
    ];
    if (picked) {
      const c = cellByKey.get(`${picked.key}|${picked.month ?? ""}`);
      if (c && picked.month) out.push({ id: "cell", label: `${c.valueLabel} · ${picked.month}`, a: c });
      // "All months" exists only where a row means all months — the matrix. In
      // the list every row already is a description and a month, and there is
      // no row that would mean anything else.
      const r = rowByKey.get(picked.key);
      if (r && mode === "trend" && cell.month == null) {
        out.push({ id: "row", label: `${r.valueLabel} · all months`, a: r });
      }
      if (c && !picked.month && cell.month != null) {
        out.push({ id: "cell", label: `${c.valueLabel} · ${cell.month}`, a: c });
      }
    }
    return out;
  }, [cell, picked, mode, rowByKey, cellByKey]);

  const anchor = anchors.find((o) => o.id === grain)?.a ?? null;

  if (!cell) return null;

  const isTotalColumn = cell.month == null;
  const trend = isTotalColumn && !!desc?.perMonth && mode === "trend";
  const listRows = desc?.perMonth
    ? (monthFilter ? desc.perMonth.filter((r) => r.month === monthFilter) : desc.perMonth)
    : desc?.rows ?? null;

  const hierarchyRows = cell.children;
  const columnLabel = hierarchyRows ? cell.childLevelLabel : desc?.label ?? null;
  const movements = desc?.rows.reduce((s, r) => s + (r.count ?? 0), 0) ?? 0;

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
      setGrain("");
      onNoteSaved();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const pick = (key: string, month: string | null, id: "row" | "cell") => {
    const same = picked?.key === key && picked.month === month && grain === id;
    setPicked(same ? null : { key, month });
    setGrain(same ? "" : id);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-slate-900/30" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Cell detail"
        // The matrix is the only thing here that needs room, so it is the only
        // thing that gets it — and the switch the reader just used is what
        // explains the change of shape.
        style={{ maxWidth: trend ? "min(96vw, 1400px)" : "48rem" }}
        className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl transition-[max-width] duration-200"
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

        {/* ── Which description, and how to read it ───────────────────────── */}
        {!hierarchyRows && cell.descriptions && (
          <div className="border-b border-slate-200 px-5 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-600">Break down by</span>
                {cell.descriptions.map((d, i) => {
                  const empty = d.populated === 0;
                  return (
                    <button
                      key={d.level}
                      onClick={() => chooseDesc(i)}
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
                      {i === 0 && <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-400">usual</span>}
                    </button>
                  );
                })}
              </div>

              {/* The switch. Always visible, never automatic — it arrives on the
                  sensible option for this account and stays where it is put. */}
              {isTotalColumn && desc?.perMonth && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-600">Read as</span>
                  <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5">
                    {([["trend", "Trend"], ["byMonth", "By month"]] as const).map(([m, lbl]) => (
                      <button
                        key={m}
                        onClick={() => { setMode(m); setPicked(null); setGrain(""); }}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          mode === m ? "bg-[#A6DEFF]/30 font-semibold text-[#001A40]" : "text-slate-500 hover:text-[#001A40]"
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {desc.compression != null && (
                    <span className="text-[10px] text-slate-400">
                      {desc.perMonth.length} rows by month · {desc.rows.length} descriptions
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Month filter, list view only. Getting to one month without
                closing the window and starting again. */}
            {isTotalColumn && desc?.perMonth && mode === "byMonth" && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] font-semibold text-slate-600">Month</span>
                {[null, ...cell.months].map((m) => (
                  <button
                    key={m ?? "__all__"}
                    onClick={() => { setMonthFilter(m); setPicked(null); setGrain(""); }}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                      monthFilter === m
                        ? "border-sky-300 bg-sky-100 text-sky-900"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {m ?? "All"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── One level down ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto">
          {!hierarchyRows && !desc && (
            <p className="p-5 text-sm text-slate-500">
              Pick a description to break these {movements} movements down by.
              The number on each option is how many of them carry it.
            </p>
          )}

          {/* A level of the hierarchy: one column, one row per child. */}
          {hierarchyRows && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">{columnLabel}</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {cell.month ?? "Total"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {hierarchyRows.map((row, i) => {
                  const on = picked?.key === row.valueLabel;
                  return (
                    <tr
                      key={`${row.valueLabel}-${i}`}
                      onClick={() => pick(row.valueLabel, cell.month, "cell")}
                      className={`cursor-pointer border-b border-slate-200/60 ${on ? "bg-sky-50" : "hover:bg-slate-50"}`}
                      style={{ backgroundColor: on ? undefined : i % 2 ? "#fcfdfe" : "#ffffff" }}
                    >
                      <td className="max-w-[420px] truncate px-3 py-1.5 text-slate-700" title={row.valueLabel}>
                        <Dot state={noteAt(row.scope)} />{row.valueLabel}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${row.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                        {fmt(row.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Trend: one row per description, one column per month it has. */}
          {trend && desc && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <th style={{ minWidth: 180, maxWidth: 380, position: "sticky", left: 0 }}
                      className="bg-slate-100 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {desc.label}
                  </th>
                  {cell.months.map((m) => (
                    <th key={m} className="whitespace-nowrap px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">
                      {m.slice(0, 3)}
                    </th>
                  ))}
                  <th className="border-l border-slate-200 px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">Total</th>
                </tr>
              </thead>
              <tbody>
                {desc.rows.map((row, i) => {
                  const bg = i % 2 ? "#fcfdfe" : "#ffffff";
                  const rowOn = picked?.key === row.key && picked?.month === null;
                  return (
                    <tr key={row.key} className="border-b border-slate-200/60" style={{ backgroundColor: rowOn ? "#f0f9ff" : bg }}>
                      {/* The row's name is the "all months" anchor, and where
                          both of that row's indicators live. */}
                      <td
                        onClick={() => pick(row.key!, null, "row")}
                        title={row.valueLabel}
                        style={{ minWidth: 180, maxWidth: 380, position: "sticky", left: 0, backgroundColor: rowOn ? "#f0f9ff" : bg }}
                        className="cursor-pointer truncate border-r border-slate-200 px-3 py-1.5 text-slate-700 hover:text-[#001A40]"
                      >
                        <Dot state={noteAt(row.scope)} />{row.valueLabel}
                      </td>
                      {cell.months.map((m) => {
                        const v = row.byMonth?.[m];
                        const c = cellByKey.get(`${row.key}|${m}`);
                        const on = picked?.key === row.key && picked?.month === m;
                        return (
                          <td
                            key={m}
                            onClick={c ? () => pick(row.key!, m, "cell") : undefined}
                            style={{ backgroundColor: on ? "#e0f2fe" : undefined }}
                            className={`whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums ${
                              c ? "cursor-pointer" : ""
                            } ${v == null ? "text-slate-300" : v < 0 ? "text-rose-600" : "text-[#001A40]"}`}
                          >
                            {c && <Dot state={noteAt(c.scope)} />}
                            {v == null ? "—" : fmt(v)}
                          </td>
                        );
                      })}
                      <td className={`whitespace-nowrap border-l border-slate-200 px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${row.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                        {fmt(row.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* By month: one row per description and month, with a Month column. */}
          {!hierarchyRows && desc && !trend && listRows && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">{desc.label}</th>
                  {isTotalColumn && (
                    <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">Month</th>
                  )}
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">Rows</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {cell.month ?? "Movement"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {listRows.map((row, i) => {
                  const on = picked?.key === row.key && picked?.month === (row.month ?? null);
                  return (
                    <tr
                      key={`${row.key}|${row.month ?? ""}`}
                      onClick={() => pick(row.key!, row.month ?? null, "cell")}
                      className={`cursor-pointer border-b border-slate-200/60 ${on ? "bg-sky-50" : "hover:bg-slate-50"}`}
                      style={{ backgroundColor: on ? undefined : i % 2 ? "#fcfdfe" : "#ffffff" }}
                    >
                      <td className="max-w-[420px] truncate px-3 py-1.5 text-slate-700" title={row.valueLabel}>
                        <Dot state={noteAt(row.scope)} />{row.valueLabel}
                      </td>
                      {isTotalColumn && (
                        <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{row.month}</td>
                      )}
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{row.count}</td>
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
            value={grain}
            onChange={(e) => setGrain(e.target.value as typeof grain)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:border-[#001A40] focus:outline-none"
          >
            {/* No preselection. An anchor chosen by default is an anchor chosen
                by accident — which is how this went wrong in the first place.
                And only what this view can represent is ever listed. */}
            <option value="">— pick what the note is about —</option>
            {anchors.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} · {fmt(o.a.amount)}
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
            placeholder={anchor ? `Note on ${anchor.valueLabel}…` : "Click a row, then pick what the note is about…"}
            className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[10px] text-slate-400">
              {anchor
                ? <>Anchored to {anchor.levelLabel} · {anchor.valueLabel}
                    {anchor.scope.month ? ` · ${anchor.scope.month}` : " · all months shown"} ·{" "}
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
