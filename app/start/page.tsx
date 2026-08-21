"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Upload, Filter, Target, Percent, Globe, BookOpen, TrendingUp, Table2,
  ChevronRight, type LucideIcon,
} from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import { useActiveBranches } from "@/components/branch-filter-provider";
import { closePeriod, MONTH_NAMES_IN_ORDER } from "@/lib/close-period";

/**
 * The month-close roadmap.
 *
 * A map of the path, not a list of links: the order is the point. It is the
 * sequence the team actually follows, confirmed, and it is not for this screen
 * to reorder or add to it.
 *
 * Every counter on it comes from the endpoint the destination screen already
 * reads — `?count=1` on the two assignment routes and `?summary=1` on the
 * validation one, all of them early returns over the predicate that was already
 * there. Nothing here counts anything a second time: in this app a second count
 * of the same thing has already drifted from the first.
 */

type Band = "prepare" | "assign" | "loans" | "close";

const BANDS: { key: Band; label: string }[] = [
  { key: "prepare", label: "Prepare" },
  { key: "assign",  label: "Keep assignments current" },
  { key: "loans",   label: "Review loans" },
  { key: "close",   label: "Close" },
];

interface Step {
  n: number;
  band: Band;
  icon: LucideIcon;
  title: string;
  line: string;
  href: string;
  /** Small pill on the card, for things true of the step itself. */
  tag?: string;
  /** Loud line under it. */
  warn?: string;
  /** Which counters this step shows, if any. */
  counters?: ("conflicts" | "unassigned" | "noMargin" | "b2b")[];
}

const STEPS: Step[] = [
  { n: 1, band: "prepare", icon: Upload, href: "/upload",
    title: "Load the files",
    line: "P&L, Loan Count and Offshore Allocations.",
    tag: "once a month" },
  { n: 2, band: "prepare", icon: Filter, href: "/settings",
    title: "Pick the branch",
    line: "Everything that follows is read against it." },

  { n: 3, band: "assign", icon: Target, href: "/cost-centers",
    title: "Cost Center Rules",
    line: "Run “Re-apply all rules”." },
  { n: 4, band: "assign", icon: Percent, href: "/cost-centers/conflicts",
    title: "Cost Center Assignment",
    line: "Resolve the conflicts, then assign what is left.",
    counters: ["conflicts", "unassigned"] },
  { n: 5, band: "assign", icon: Globe, href: "/offshore-allocations",
    title: "Offshore Allocations",
    line: "Check whether anything changed." },

  { n: 6, band: "loans", icon: BookOpen, href: "/loan-count",
    title: "Loan Count",
    line: "Loans with no DM Margin, and the B2B alerts.",
    counters: ["noMargin", "b2b"] },

  { n: 7, band: "close", icon: TrendingUp, href: "/pl",
    title: "Reconcile Net Income",
    line: "Against Blast.",
    warn: "If it does not match, stop here." },
  { n: 8, band: "close", icon: TrendingUp, href: "/pl",
    title: "Review the variances",
    line: "Regular and by cost centre, and leave your notes." },
];

type Counts = {
  conflicts: number | null;
  unassigned: number | null;
  noMargin: number | null;
  b2b: number | null;
};

export default function StartPage() {
  const { activeBranches, isLoaded: branchLoaded } = useActiveBranches();

  const [months, setMonths] = useState<string[]>([]);
  const [years, setYears] = useState<string[]>([]);
  const [monthOpts, setMonthOpts] = useState<string[]>([]);
  const [yearOpts, setYearOpts] = useState<string[]>([]);

  const [counts, setCounts] = useState<Counts>({ conflicts: null, unassigned: null, noMargin: null, b2b: null });
  const [loading, setLoading] = useState(true);
  /** Rows in the selected period. Null while unknown. */
  const [periodRows, setPeriodRows] = useState<number | null>(null);

  /**
   * The period defaults to the month just ended — see lib/close-period.ts.
   *
   * Chosen before the options are known, and NOT reconciled against them: if
   * that month has nothing loaded the screen says so and stays on it. Falling
   * back to another month would put a period on screen that nobody asked for,
   * and reading July's figures believing they are August is the expensive
   * mistake this is guarding.
   */
  useEffect(() => {
    const p = closePeriod();
    setMonths([p.month]);
    setYears([String(p.year)]);

    fetch("/api/transactions/filter-options")
      .then((r) => r.json())
      .then((d: { month?: string[]; year?: (string | number)[] }) => {
        setMonthOpts(MONTH_NAMES_IN_ORDER.filter((m) => (d.month ?? []).includes(m)));
        setYearOpts([...(d.year ?? [])].map(String).sort());
      })
      .catch(console.error);
  }, []);

  /**
   * Whether the selected period has any transactions at all.
   *
   * Read from /api/transactions, which already answers this: it takes month and
   * year and returns the count of the same predicate Transaction Review lists.
   * page=1 brings one page of rows along with it, which is the price of not
   * writing a second definition of "rows in this period".
   */
  useEffect(() => {
    if (months.length !== 1 || years.length !== 1) { setPeriodRows(null); return; }
    let cancelled = false;
    const p = new URLSearchParams({ month: months[0], year: years[0], page: "1" });
    fetch(`/api/transactions?${p}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => { if (!cancelled) setPeriodRows(d?.count ?? null); })
      .catch(() => { if (!cancelled) setPeriodRows(null); });
    return () => { cancelled = true; };
  }, [months, years]);

  const scope = useMemo(() => {
    const p = new URLSearchParams();
    activeBranches.forEach((b) => p.append("branch", b));
    months.forEach((m) => p.append("month", m));
    years.forEach((y) => p.append("year", y));
    return p.toString();
  }, [activeBranches, months, years]);

  useEffect(() => {
    if (!branchLoaded) return;
    let cancelled = false;
    setLoading(true);
    const j = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    Promise.allSettled([
      j(`/api/conflicts?count=1&${scope}`),
      j(`/api/cost-center-assignment/unassigned?count=1&${scope}`),
      // The loans side is scoped by period only: its branch means the branch of
      // the loan, which is a different question from the accounting branch the
      // global filter names — see /api/loan-validation.
      j(`/api/loan-validation?summary=1&type=all_loans&${new URLSearchParams(
        [...months.map((m) => ["month", m] as [string, string]), ...years.map((y) => ["year", y] as [string, string])],
      )}`),
      j(`/api/loan-validation?summary=1&type=b2b&${new URLSearchParams(
        [...months.map((m) => ["month", m] as [string, string]), ...years.map((y) => ["year", y] as [string, string])],
      )}`),
    ]).then((res) => {
      if (cancelled) return;
      const val = <T,>(r: PromiseSettledResult<T>): T | null =>
        r.status === "fulfilled" ? r.value : null;
      setCounts({
        conflicts:  val(res[0])?.count ?? null,
        unassigned: val(res[1])?.count ?? null,
        noMargin:   val(res[2])?.summary?.missing_count ?? null,
        b2b:        val(res[3])?.summary?.missing_count ?? null,
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [branchLoaded, scope, months, years]);

  /** What the numbers are about, spelled out. A figure without its scope beside
   *  it is what has cost this project several rounds. */
  const scopeLabel = [
    months.length === 1 ? months[0] : months.length ? `${months.length} months` : "all months",
    years.length === 1 ? years[0] : years.length ? `${years.length} years` : "all years",
  ].join(" ") + " · " + (activeBranches.length === 1
    ? `branch ${activeBranches[0]}`
    : activeBranches.length ? `${activeBranches.length} branches` : "all branches");

  const partial = months.length === 0 || years.length === 0 || activeBranches.length === 0;

  const label: Record<keyof Counts, string> = {
    conflicts: "conflicts", unassigned: "unassigned", noMargin: "no DM Margin", b2b: "B2B alerts",
  };

  /**
   * Which of these follow the branch and which do not.
   *
   * The loans side is period-only on purpose: /api/loan-validation reads
   * `branch` as the branch that PRODUCED the loan, while the global filter names
   * accounting branches — and the margin of nearly every loan is booked in 700,
   * a branch no loan belongs to. Passing it there returns nothing, which is a
   * regression this project already shipped once.
   *
   * So the chip above says "branch 716" and these two do not obey it. Rather
   * than leave that to be discovered, each says what it is scoped to.
   */
  const note: Partial<Record<keyof Counts, string>> = {
    noMargin: "period only",
    b2b:      "period only",
  };

  return (
    <div className="-m-6 min-h-screen bg-[#FCFCFA]">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-5 px-6 py-6">
        <div>
          <h1 className="text-2xl font-bold text-[#001A40]">Where to start</h1>
          <p className="mt-1 text-sm text-slate-500">
            The month-close path, in order. Each step links to its screen, and the ones that can
            tell you whether there is work left say so.
          </p>
        </div>

        {/* What the counters are counting. Always on screen, never implied. */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Counting
          </span>
          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-bold text-sky-900">
            {scopeLabel}
          </span>
          <ReportFilter label="Month" options={monthOpts} selected={months} onChange={setMonths} />
          <ReportFilter label="Year"  options={yearOpts}  selected={years}  onChange={setYears} />
          <Link href="/settings" className="text-[11px] text-slate-500 underline hover:text-[#001A40]">
            change branch
          </Link>
          {partial && (
            <span className="text-[11px] text-amber-700">
              Without a period and a branch these are whole-table totals, not a to-do list.
            </span>
          )}
          {/* Said out loud rather than fixed by moving to another month. */}
          {periodRows === 0 && months.length === 1 && years.length === 1 && (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
              {months[0]} {years[0]} has no transactions loaded
            </span>
          )}
        </div>

        {/* The path */}
        <div className="flex flex-col gap-3">
          {BANDS.map((band, bi) => {
            const steps = STEPS.filter((s) => s.band === band.key);
            return (
              <div key={band.key}>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
                  <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                    {band.label}
                  </p>
                  <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
                    {steps.map((s, i) => (
                      <div key={s.n} className="flex flex-col items-center gap-3 md:flex-row">
                        <StepCard step={s} counts={counts} loading={loading} label={label} note={note} />
                        {i < steps.length - 1 && (
                          <ChevronRight size={18} className="shrink-0 rotate-90 text-slate-300 md:rotate-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                {/* Between bands, a heavier mark: the path continues. */}
                {bi < BANDS.length - 1 && (
                  <div className="flex justify-center py-1">
                    <ChevronRight size={22} className="rotate-90 text-slate-300" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Outside the sequence, and it has to look outside it. */}
        <div className="mt-2 border-t border-slate-200 pt-4">
          <Link
            href="/transactions"
            className="group flex max-w-md items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs hover:border-[#001A40]"
          >
            <Table2 size={18} className="mt-0.5 shrink-0 text-slate-400" />
            <span className="min-w-0">
              <span className="block text-sm font-bold text-[#001A40] group-hover:underline">
                Transaction Review
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                The detail behind any transaction, at any point. Not part of the sequence.
              </span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}

function StepCard({
  step, counts, loading, label, note,
}: {
  step: Step;
  counts: Counts;
  loading: boolean;
  label: Record<keyof Counts, string>;
  note: Partial<Record<keyof Counts, string>>;
}) {
  const Icon = step.icon;
  return (
    <Link
      href={step.href}
      className="group flex w-full min-w-[230px] max-w-[300px] flex-col rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs transition-colors hover:border-[#001A40] md:w-auto"
    >
      <span className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#001A40] text-[11px] font-bold text-white">
          {step.n}
        </span>
        <Icon size={15} className="shrink-0 text-slate-400" />
        <span className="min-w-0 truncate text-sm font-bold text-[#001A40] group-hover:underline">
          {step.title}
        </span>
      </span>
      <span className="mt-1.5 text-xs leading-snug text-slate-500">{step.line}</span>
      {step.tag && (
        <span className="mt-2 self-start rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {step.tag}
        </span>
      )}
      {step.warn && (
        <span className="mt-2 text-[11px] font-semibold text-amber-700">{step.warn}</span>
      )}
      {step.counters && (
        <span className="mt-2.5 flex flex-wrap gap-1.5">
          {step.counters.map((k) => (
            <Counter key={k} value={counts[k]} label={label[k]} note={note[k]} loading={loading} />
          ))}
        </span>
      )}
    </Link>
  );
}

/**
 * A zero is shown, and that is the point: "0 conflicts" says someone looked.
 * A card with no counter says nothing at all, which is why an absent counter is
 * never used to mean "none".
 */
function Counter({ value, label, note, loading }: {
  value: number | null; label: string; note?: string; loading: boolean;
}) {
  if (loading) {
    return (
      <span className="animate-pulse rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-300">
        {label}
      </span>
    );
  }
  if (value === null) {
    return (
      <span title="This count could not be read" className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-400">
        {label} · —
      </span>
    );
  }
  const open = value > 0;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
        open ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-500"
      }`}
    >
      {value.toLocaleString()} {label}
      {note && <span className="ml-1 font-normal opacity-60">· {note}</span>}
    </span>
  );
}
