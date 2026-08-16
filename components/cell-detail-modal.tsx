"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

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
  gl_code: string;
  gl_name: string | null;
  month: string | null;
  row_count: number;
  total: number;
  coverage: Record<DescField, number>;
  rows: Row[];
}

export interface CellTarget {
  glCode: string;
  glLabel: string;
  month: string | null;
  years: string[];
  branches: string[];
  sources: string[];
  costCenterIds: string[];
}

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CellDetailModal({ target, onClose }: { target: CellTarget | null; onClose: () => void }) {
  const [data, setData]     = useState<CellDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");
  /**
   * Deliberately null until the reader picks. Preselecting would hide the fact
   * that the right choice is account-dependent, and the whole reason this lives
   * in a modal is that no single description is right for every account.
   */
  const [field, setField] = useState<DescField | null>(null);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  const key = target
    ? `${target.glCode}|${target.month}|${target.years.join(",")}|${target.branches.join(",")}|${target.sources.join(",")}|${target.costCenterIds.join(",")}`
    : "";

  useEffect(() => {
    if (!target) return;
    setField(null);            // a new cell is a new choice
    const p = new URLSearchParams({ gl_code: target.glCode });
    if (target.month) p.set("month", target.month);
    target.years.forEach((y) => p.append("year", y));
    target.branches.forEach((b) => p.append("branch", b));
    target.sources.forEach((s) => p.append("source", s));
    target.costCenterIds.forEach((c) => p.append("cost_center_id", c));

    let cancelled = false;
    setLoading(true); setError("");
    fetch(`/api/pl-cell-detail?${p}`)
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
  }, [key]);

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
            <h2 className="truncate text-base font-bold text-[#001A40]">{target.glLabel}</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {target.month ?? "All months"}
              {data && <> · {data.row_count} rows · <span className="font-mono tabular-nums">{fmt(data.total)}</span></>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="border-b border-slate-200 px-5 py-3">
          <p className="mb-2 text-[11px] font-semibold text-slate-600">Group by</p>
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
        </div>

        <div className="flex-1 overflow-auto">
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
        </div>
      </div>
    </>
  );
}
