"use client";

import { useEffect, useMemo, useState } from "react";
import { X, MessageSquarePlus } from "lucide-react";
import type { CellRef } from "@/lib/cell-ref";

const DESC_FIELDS = ["check_description", "check_description_2", "check_description_3"] as const;
type DescField = (typeof DESC_FIELDS)[number];

const DESC_LABELS: Record<DescField, string> = {
  check_description:   "Description",
  check_description_2: "Description 2",
  check_description_3: "Description 3",
};

interface Row {
  id: string;
  vendor: string | null;
  ref_numb: string | null;
  movement: number | null;
  check_description: string | null;
  check_description_2: string | null;
  check_description_3: string | null;
}

interface CellDetail {
  gl_code: string | null;
  gl_name: string | null;
  month: string | null;
  row_count: number;
  total: number;
  coverage: Record<DescField, number>;
  rows: Row[];
}

/** A cell plus the filters the report was run with. */
export interface CellTarget extends CellRef {
  years: string[];
  branches: string[];
  sources: string[];
  costCenterIds: string[];
}

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CellDetailModal({
  target,
  onClose,
  onNoteSaved,
}: {
  target: CellTarget | null;
  onClose: () => void;
  onNoteSaved: () => void;
}) {
  const [data, setData]       = useState<CellDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  /**
   * Deliberately null until the reader picks. Preselecting would hide the fact
   * that the right choice is account-dependent, and the whole reason this lives
   * in a modal is that no single description is right for every account.
   */
  const [field, setField] = useState<DescField | null>(null);

  // ── Composer ──────────────────────────────────────────────────────────────
  /**
   * Also null until picked, and for the harder reason: the anchor level used to
   * be decided by *where* the user clicked. Two people hunting for the
   * transaction level both landed on `description` without noticing, because
   * the row for a one-line description group and the transaction under it print
   * the same text. Choosing it is now a separate, explicit act.
   */
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [draft, setDraft]         = useState("");
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  const params = useMemo(() => {
    if (!target) return null;
    const s = target.scope;
    const p = new URLSearchParams();
    if (s.gl && s.gl !== "(No GL)") p.set("gl_code", String(s.gl));
    if (s.category_6) p.set("category_6", String(s.category_6));
    if (s.category_7) p.set("category_7", String(s.category_7));
    if (s.cost_center) p.set("cost_center", String(s.cost_center));
    if (target.month) p.set("month", target.month);
    target.years.forEach((y) => p.append("year", y));
    target.branches.forEach((b) => p.append("branch", b));
    target.sources.forEach((s2) => p.append("source", s2));
    // Only when the cell itself is not already pinned to one centre.
    if (!s.cost_center) target.costCenterIds.forEach((c) => p.append("cost_center_id", c));
    return p.toString();
  }, [target]);

  useEffect(() => {
    if (!target || !params) return;
    setField(null);                 // a new cell is a new choice
    setAnchorIdx(null);
    setDraft(""); setSaveError("");
    if (!target.drillable) { setData(null); setLoading(false); setError(""); return; }

    let cancelled = false;
    setLoading(true); setError("");
    fetch(`/api/pl-cell-detail?${params}`)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(d?.error ?? "Error loading detail"); setData(null); return; }
        setData(d as CellDetail);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const grouped = useMemo(() => {
    if (!data || !field) return null;
    const g = new Map<string, { label: string; total: number; count: number }>();
    for (const r of data.rows) {
      const raw = String(r[field] ?? "").trim();
      const label = raw || "(blank)";
      const e = g.get(label) ?? { label, total: 0, count: 0 };
      e.total += Number(r.movement ?? 0);
      e.count++;
      g.set(label, e);
    }
    return [...g.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [data, field]);

  if (!target) return null;

  const anchor = anchorIdx != null ? target.anchors[anchorIdx] : null;
  // The movement list cannot honour an Operational / Non-Operational
  // constraint: the split is applied when the pivot expands a transaction into
  // two virtual rows, and no column in the table records it.
  const opNonOpCaveat = target.scope.op_nonop != null;
  // Same shape of gap: a transaction split across centres is prorated by the
  // report when it fans the row out, and the table keeps only the single
  // cost_center_id it was assigned. The list can filter by that, not by a share.
  const splitCaveat = target.scope.cost_center != null;

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
      setAnchorIdx(null);
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
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-[#001A40]">{target.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
              {target.breadcrumb.map((part, i) => (
                <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-slate-300">›</span>}
                  {part}
                </span>
              ))}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {target.month ?? "All months"} ·{" "}
              <span className={`font-mono font-bold tabular-nums ${target.amount < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                {fmt(target.amount)}
              </span>
              {data && <> · {data.row_count} rows behind it</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {/* ── Movements ─────────────────────────────────────────────────── */}
          {target.drillable && (
            <>
              <div className="border-b border-slate-200 px-5 py-3">
                <p className="mb-2 text-[11px] font-semibold text-slate-600">Group the movements by</p>
                <div className="flex flex-wrap gap-2">
                  {DESC_FIELDS.map((f) => {
                    const n = data?.coverage[f] ?? 0;
                    const empty = data != null && n === 0;
                    const usual = f === "check_description";
                    return (
                      <button
                        key={f}
                        onClick={() => setField(f)}
                        disabled={loading}
                        title={empty ? "No rows in this cell carry this description" : undefined}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          field === f
                            ? "border-sky-300 bg-sky-100 text-sky-900"
                            : empty
                              ? "border-slate-200 bg-slate-50 text-slate-400"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {DESC_LABELS[f]}
                        {/* The count is the whole point: picking an empty description
                            gives a blank list that reads as a broken page, and only
                            the data can say which one is populated for THIS cell. */}
                        {data && <span className={`ml-1.5 font-mono text-[10px] ${empty ? "text-slate-400" : "text-slate-500"}`}>{n}</span>}
                        {usual && <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-400">usual</span>}
                      </button>
                    );
                  })}
                </div>
                {opNonOpCaveat && (
                  <p className="mt-2 text-[10px] text-amber-700">
                    The Operational / Non-Operational split is applied by the report, not stored on
                    the rows — these movements are the whole cell, before that split.
                  </p>
                )}
                {splitCaveat && (
                  <p className="mt-2 text-[10px] text-amber-700">
                    Movements are listed by the cost centre each row is assigned to. A transaction
                    shared between centres appears here in full, not at its allocated share.
                  </p>
                )}
              </div>

              {loading && <p className="p-5 text-sm text-slate-400">Loading…</p>}
              {error && <p className="m-5 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{error}</p>}

              {!loading && !error && !field && (
                <p className="p-5 text-sm text-slate-500">
                  Pick a description to group these {data?.row_count ?? 0} movements by.
                  The number on each option is how many of them carry it.
                </p>
              )}

              {grouped && (
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-100/95">
                    <tr className="border-b-2 border-slate-200 text-left">
                      <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                        {DESC_LABELS[field!]}
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">Rows</th>
                      <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-700">Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map((g, i) => (
                      <tr key={g.label} className="border-b border-slate-200/60"
                          style={{ backgroundColor: i % 2 ? "#fcfdfe" : "#ffffff" }}>
                        <td className="max-w-[420px] truncate px-3 py-1.5 text-slate-700" title={g.label}>
                          {g.label === "(blank)"
                            ? <span className="italic text-slate-400">(blank)</span>
                            : g.label}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-500">{g.count}</td>
                        <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${g.total < 0 ? "text-rose-600" : "text-[#001A40]"}`}>
                          {fmt(g.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {!target.drillable && (
            <p className="p-5 text-sm text-slate-500">
              This is the report total. Its movements are every row loaded, so there is no
              breakdown to open here — a note can still be written against it below.
            </p>
          )}
        </div>

        {/* ── Composer ──────────────────────────────────────────────────────── */}
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">
          <p className="mb-2 text-[11px] font-semibold text-slate-600">
            Write a note — pick what it is about
          </p>
          {/* Deepest first: the level just clicked is the one most people want,
              and the chain above it is what makes the other levels reachable at
              all. Still no preselection — an anchor chosen by default is an
              anchor chosen by accident, which is how this went wrong before. */}
          <div className="flex flex-wrap gap-2">
            {target.anchors.map((a, i) => (
              <button
                key={`${a.level}-${i}`}
                onClick={() => setAnchorIdx(i)}
                title={`${a.levelLabel}: ${a.valueLabel} · ${fmt(a.amount)}`}
                className={`max-w-[240px] truncate rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  anchorIdx === i
                    ? "border-sky-300 bg-sky-100 text-sky-900"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
              >
                <span className="text-[9px] uppercase tracking-wide text-slate-400">{a.levelLabel}</span>
                <span className="ml-1.5">{a.valueLabel}</span>
              </button>
            ))}
          </div>

          {saveError && (
            <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600">
              {saveError}
            </p>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder={anchor ? `Note on ${anchor.valueLabel}…` : "Pick a level above, then write the note…"}
            className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 placeholder:text-slate-300 focus:border-[#001A40] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[10px] text-slate-400">
              {anchor
                ? <>Anchored to {anchor.levelLabel} · {anchor.valueLabel}
                    {target.month ? ` · ${target.month}` : ""} ·{" "}
                    <span className="font-mono">{fmt(anchor.amount)}</span> at the time of writing</>
                : "No level picked yet."}
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
