"use client";

import { useEffect, useState } from "react";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const MONTH_SHORT: Record<string, string> = {
  January: "Jan", February: "Feb", March: "Mar", April: "Apr",
  May: "May", June: "Jun", July: "Jul", August: "Aug",
  September: "Sep", October: "Oct", November: "Nov", December: "Dec",
};

interface MonthMetrics {
  total: number; banked: number; brokered: number; other: number;
  b2b: number; processing: number; support_on_demand: number; affinity: number; recruitment: number;
}

interface Props {
  years: string[];
  branches: string[];
  sources: string[];
  costCenterIds?: string[];
}

export function LoanMetricsByMonthBar({ years, branches, sources, costCenterIds }: Props) {
  const [byMonth, setByMonth] = useState<Record<string, MonthMetrics> | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState("");

  const key = [years, branches, sources, costCenterIds ?? []].map((a) => a.join(",")).join("|");

  useEffect(() => {
    const p = new URLSearchParams({ group_by: "month" });
    years.forEach((y) => p.append("year", y));
    branches.forEach((b) => p.append("branch", b));
    sources.forEach((s) => p.append("source", s));
    (costCenterIds ?? []).forEach((id) => p.append("cost_center_id", id));

    setLoading(true);
    setFetchErr("");
    fetch(`/api/loan-metrics?${p}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setFetchErr(d?.error ?? "Error loading loan metrics"); return; }
        setByMonth((d as { by_month: Record<string, MonthMetrics> }).by_month ?? {});
      })
      .catch((e) => setFetchErr(String(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (loading) {
    // Matches the height of the loaded card so the page does not jump.
    return <div className="mb-6 h-[150px] animate-pulse rounded-2xl border border-slate-200/80 bg-slate-50" />;
  }

  if (fetchErr) {
    return (
      <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
        Loan metrics: {fetchErr}
      </p>
    );
  }

  const months = Object.keys(byMonth ?? {})
    .filter((m) => (byMonth?.[m]?.total ?? 0) > 0)
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  if (months.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
      <div className="mb-3 text-xs font-bold uppercase tracking-wider text-[#001A40]">
        Loan Count by Month
      </div>
      {/* Six columns, so a full half-year fills the width and a full year wraps
          into two even rows. Written as a template rather than a grid-cols-6
          class because the month list is whatever the data holds: with four
          months, a fixed six-column grid would leave two empty tracks and make
          the cards narrower than the strip it replaced. */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.min(months.length, 6)}, minmax(0, 1fr))` }}
      >
        {months.map((month) => (
          <MonthCard key={month} month={month} m={byMonth![month]} />
        ))}
      </div>
    </div>
  );
}

function MonthCard({ month, m }: { month: string; m: MonthMetrics }) {
  const hasTags = m.b2b + m.processing + m.support_on_demand + m.affinity + m.recruitment > 0;

  return (
    <div className="flex flex-col justify-between rounded-xl border border-slate-200/60 bg-slate-50/60 p-3 transition-all hover:border-[#A6DEFF] hover:bg-white hover:shadow-xs">
      <div className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">
        {MONTH_SHORT[month] ?? month}
      </div>

      {/* Hero metric. The count is the number anyone reads first, so it gets the
          size and the label shrinks beside it rather than sitting above it. */}
      <div className="flex items-baseline">
        <span className="text-2xl font-bold tabular-nums text-[#001A40]">{m.total}</span>
        <span className="ml-1.5 text-xs font-medium text-slate-500">total</span>
      </div>

      {/* Banked / brokered as one plain line: two numbers competing with the
          hero for attention was most of what made the old card feel crowded. */}
      <div className="mb-2 text-[11px] font-semibold text-slate-600">
        <span className="tabular-nums">{m.banked}</span> B
        <span className="mx-1 text-slate-300">·</span>
        <span className="tabular-nums">{m.brokered}</span> Br
        {m.other > 0 && (
          <>
            <span className="mx-1 text-slate-300">·</span>
            <span className="tabular-nums">{m.other}</span> Other
          </>
        )}
      </div>

      {hasTags && (
        <div className="mt-1 flex flex-wrap gap-1">
          {m.b2b > 0               && <MiniTag label="B2B"  v={m.b2b} />}
          {m.processing > 0        && <MiniTag label="Proc" v={m.processing} />}
          {m.support_on_demand > 0 && <MiniTag label="OD"   v={m.support_on_demand} />}
          {m.affinity > 0          && <MiniTag label="Aff"  v={m.affinity} />}
          {m.recruitment > 0       && <MiniTag label="Rec"  v={m.recruitment} />}
        </div>
      )}
    </div>
  );
}

function MiniTag({ label, v }: { label: string; v: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#A6DEFF]/40 bg-[#A6DEFF]/25 px-2 py-0.5 text-[10px] font-bold text-[#001A40]">
      <span className="tabular-nums">{v}</span>
      {label}
    </span>
  );
}
