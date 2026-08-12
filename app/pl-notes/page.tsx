"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { PivotTableDynamic } from "@/components/pivot-table-dynamic";
import { ReportFilter } from "@/components/report-filter";
import { buildSplitsMap } from "@/lib/apply-splits";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import type { SplitEntry } from "@/lib/apply-splits";
import { OrphanedNotesPanel } from "@/components/orphaned-notes-panel";
import { defaultScopeLabel } from "@/components/note-drawer";
import type { PLNote, ScopeKey } from "@/lib/note-scope";
import type { PivotField } from "@/lib/pivot-engine";
import type { PLReportTx, FilterOptionsResponse } from "@/types";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/**
 * Fixed hierarchy — the reason this view exists.
 *
 * P&L All and Cost Center Report let the user rearrange the levels, which makes
 * a note appear on a differently-shaped row from one day to the next even
 * though the figure behind it never moved. Notes therefore live only here,
 * where a cell always means the same thing and an anchor stays put.
 */
const FIXED_LEVELS: PivotField[] = [
  "cost_center", "category_6", "category_7", "gl", "description", "check_desc_3",
];

/** Order breadcrumbs follow when describing an orphaned note's stored scope. */
const SCOPE_ORDER: ScopeKey[] = [...FIXED_LEVELS, "month", "year"];

const SOURCE_LABELS: Record<string, string> = {
  original:             "Original",
  addback:              "Addback",
  offshore_allocations: "OA",
  manual_entry:         "Manual Entry",
};
function srcLabel(s: string) { return SOURCE_LABELS[s] ?? s; }

function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-900">
      <span className="font-normal text-sky-500">{label}:</span>
      {value}
    </span>
  );
}

export default function PLNotesPage() {
  const { activeBranches, isLoaded: branchFilterLoaded } = useActiveBranches();
  const [opts, setOpts] = useState<FilterOptionsResponse | null>(null);

  const [years,    setYears]    = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [sources,  setSources]  = useState<string[]>([]);
  const [months,   setMonths]   = useState<string[]>([]);

  const [rawTxs,    setRawTxs]    = useState<PLReportTx[]>([]);
  const [allSplits, setAllSplits] = useState<SplitEntry[]>([]);
  const [notes,     setNotes]     = useState<PLNote[]>([]);
  const [orphans,   setOrphans]   = useState<PLNote[]>([]);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [loaded,  setLoaded]  = useState(false);
  const autoLoaded = useRef(false);

  const [loadedYears,    setLoadedYears]    = useState<string[]>([]);
  const [loadedBranches, setLoadedBranches] = useState<string[]>([]);
  const [loadedSources,  setLoadedSources]  = useState<string[]>([]);

  /** Notes come from their own endpoint, so posting one refreshes just them
   *  rather than re-downloading every transaction behind the report. */
  async function refreshNotes(yrs: string[]) {
    try {
      const p = new URLSearchParams();
      yrs.forEach((y) => p.append("year", y));
      const res = await fetch(`/api/pl-notes?${p}`);
      if (res.ok) setNotes(await res.json());
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchData(yrs: string[], brs: string[], srcs: string[]) {
    setLoading(true); setError("");
    try {
      const effectiveBranches = mergeWithGlobal(activeBranches, brs);
      const p = new URLSearchParams();
      yrs.forEach(y => p.append("year", y));
      effectiveBranches.forEach(b => p.append("branch", b));
      srcs.forEach(s => p.append("source", s));
      const res = await fetch(`/api/pl-all?${p}`);
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Error"); return; }
      setRawTxs(await res.json());
      void refreshNotes(yrs);
      setLoaded(true);
      setMonths([]);
      setLoadedYears(yrs);
      setLoadedBranches(effectiveBranches);
      setLoadedSources(srcs);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!branchFilterLoaded) return;
    Promise.all([
      fetch("/api/transactions/filter-options").then(r => r.json()),
      fetch("/api/cc-allocation-splits").then(r => r.json()),
    ]).then(([filterOpts, splits]: [FilterOptionsResponse, SplitEntry[]]) => {
      setOpts(filterOpts);
      setAllSplits(splits);
      const defaultYear = filterOpts.year.length > 0
        ? [filterOpts.year[filterOpts.year.length - 1]]
        : [];
      setYears(defaultYear);
      if (!autoLoaded.current && defaultYear.length > 0) {
        autoLoaded.current = true;
        fetchData(defaultYear, [], []);
      }
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchFilterLoaded]);

  const monthOptions = useMemo(
    () => MONTH_ORDER.filter(m => rawTxs.some(t => t.month === m)),
    [rawTxs]
  );

  const txs = useMemo(
    () => (months.length > 0 ? rawTxs.filter(t => t.month && months.includes(t.month)) : rawTxs),
    [rawTxs, months]
  );

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  /** Anchor notes to a year only when the report covers exactly one. With
   *  several loaded a month column merges them, so the cell spans periods and
   *  has none to point at. */
  const scopeYear = useMemo(() => {
    const ys = new Set(rawTxs.map(t => t.year).filter((y): y is number => y != null));
    return ys.size === 1 ? [...ys][0] : undefined;
  }, [rawTxs]);

  const loadedChips: { label: string; value: string }[] = [];
  if (loadedYears.length > 0)
    loadedChips.push({ label: "Year", value: loadedYears.length === 1 ? loadedYears[0] : `${loadedYears.length} years` });
  if (loadedBranches.length > 0)
    loadedChips.push({ label: "Branch", value: loadedBranches.length === 1 ? loadedBranches[0] : `${loadedBranches.length} branches` });
  if (loadedSources.length > 0)
    loadedChips.push({ label: "Source", value: loadedSources.map(srcLabel).join(", ") });
  if (months.length > 0)
    loadedChips.push({ label: "Month", value: months.length === 1 ? months[0] : `${months.length} months` });

  return (
    // Canvas colour is scoped here rather than applied to <body> so the rest of
    // the portal keeps its current background until its own redesign pass.
    // -m-6 cancels the layout's padding so the tint reaches the edges.
    <div className="-m-6 min-h-screen bg-[#FCFCFA]">
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-4">
      {/* Filter bar */}
      <div className="sticky top-0 z-30 rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-bold uppercase tracking-wider text-[#001A40]">
            Filters:
          </span>

          <ReportFilter label="Year"   options={(opts?.year ?? []).map(String)} selected={years}    onChange={setYears} />
          <ReportFilter label="Branch" options={opts?.branch ?? []}             selected={branches} onChange={setBranches} />
          <ReportFilter label="Source" options={opts?.source ?? []}             selected={sources}  onChange={setSources} />

          <button
            onClick={() => fetchData(years, branches, sources)}
            disabled={loading}
            className="rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
          >
            {loading ? "Loading…" : "Run Report"}
          </button>

          {loaded && (
            <>
              <span className="text-slate-300">|</span>
              <ReportFilter label="Month" options={monthOptions} selected={months} onChange={setMonths} />
            </>
          )}
        </div>

        {loaded && loadedChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {loadedChips.map((chip) => (
              <FilterChip key={chip.label} label={chip.label} value={chip.value} />
            ))}
          </div>
        )}
      </div>

      {/* Title */}
      <div>
        <h2 className="text-xl font-bold text-[#001A40]">P&amp;L Notes</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Click any figure to open its transactions and notes. The hierarchy is
          fixed — Cost Center → Category 6 → Category 7 → GL Code → Description →
          Description 3 (OA) — so a note always stays on the same cell.
          Rows outside Offshore Allocations group under “—” at the last level.
        </p>
      </div>

      {/* Indicator legend — the two dot styles are not self-evident. */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-xs">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <MessageSquare size={12} className="text-slate-400" />
          Indicators:
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#FF4040]" />
          Note written on this cell
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <span className="inline-block h-1.5 w-1.5 rounded-full border border-[#001A40]/40" />
          Notes from more detailed levels below
        </span>
      </div>

      {/* Notes whose transaction was removed by a re-upload. Sits right after
          the legend so it is impossible to miss — the whole point is that a
          comment never disappears without the user being told. */}
      <OrphanedNotesPanel
        orphans={orphans}
        transactions={txs}
        onChanged={() => refreshNotes(loadedYears)}
        scopeOrder={SCOPE_ORDER}
        labelFor={defaultScopeLabel}
      />

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>
      )}

      {!loaded && !loading && (
        <p className="py-10 text-center text-sm text-slate-400">
          Select filters and click Run Report to generate the report.
        </p>
      )}

      {(loaded || loading) && (
        <PivotTableDynamic
          txs={txs}
          splitsMap={splitsMap}
          defaultLevels={FIXED_LEVELS}
          // No storageKey: nothing to persist when the hierarchy cannot change,
          // and it keeps a stale saved order from ever resurfacing here.
          lockHierarchy
          enableNotes
          homesiTheme
          notes={notes}
          onNotesChanged={() => refreshNotes(loadedYears)}
          onOrphansChange={setOrphans}
          scopeYear={scopeYear}
          loading={loading}
          emptyMessage="No transactions found for the selected filters."
        />
      )}
    </div>
    </div>
  );
}
