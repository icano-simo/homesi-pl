"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { NotesLog } from "@/components/notes-log";
import { PivotTableDynamic } from "@/components/pivot-table-dynamic";
import { ReportFilter } from "@/components/report-filter";
import { LoanMetricsByMonthBar } from "@/components/loan-metrics-by-month";
import { buildSplitsMap, fanOutBySplits } from "@/lib/apply-splits";
import { downloadCSV } from "@/lib/csv";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import type { CostCenter, PLReportTx, PLReportTxCC, FilterOptionsResponse } from "@/types";
import type { SplitEntry } from "@/lib/apply-splits";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const CSV_COLUMNS = [
  { key: "month",            label: "Month" },
  { key: "branch",           label: "Branch" },
  { key: "gl_code",          label: "GL Code" },
  { key: "gl_name",          label: "GL Name" },
  { key: "category_2",       label: "Category 2" },
  { key: "category_6",       label: "Category 6" },
  { key: "category_7",       label: "Category 7" },
  { key: "check_description",label: "Description" },
  { key: "vendor",           label: "Vendor" },
  { key: "ref_numb",         label: "Ref #" },
  { key: "debit",            label: "Debit" },
  { key: "credit",           label: "Credit" },
  { key: "movement",         label: "Movement" },
];

type ViewMode = "gl" | "cc";

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

export default function PLAllPage() {
  const { activeBranches, isLoaded: branchFilterLoaded } = useActiveBranches();
  const [opts, setOpts] = useState<FilterOptionsResponse | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("gl");

  const [years,    setYears]    = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [sources,  setSources]  = useState<string[]>([]);

  const [glCodes, setGlCodes] = useState<string[]>([]);
  const [months,  setMonths]  = useState<string[]>([]);
  // Cost Center filter — absorbed from the old Cost Center Report module.
  const [costCenterNames, setCostCenterNames] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(true);

  const [rawTxs,      setRawTxs]      = useState<PLReportTx[]>([]);
  const [allSplits,   setAllSplits]   = useState<SplitEntry[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [loaded,  setLoaded]  = useState(false);
  const autoLoaded = useRef(false);

  // Params that were last successfully loaded — for metrics panel and chips
  const [loadedYears,    setLoadedYears]    = useState<string[]>([]);
  const [loadedBranches, setLoadedBranches] = useState<string[]>([]);
  const [loadedSources,  setLoadedSources]  = useState<string[]>([]);

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
      setLoaded(true);
      setGlCodes([]); setMonths([]);
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
      fetch("/api/cost-centers").then(r => r.json()),
    ]).then(([filterOpts, splits, ccs]: [FilterOptionsResponse, SplitEntry[], CostCenter[]]) => {
      setOpts(filterOpts);
      setAllSplits(splits);
      setCostCenters(ccs);
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

  function load() {
    return fetchData(years, branches, sources);
  }

  const glCodeOptions = useMemo(
    () => [...new Set(rawTxs.map(t => t.gl_code).filter(Boolean) as string[])].sort(),
    [rawTxs]
  );
  const monthOptions = useMemo(
    () => MONTH_ORDER.filter(m => rawTxs.some(t => t.month === m)),
    [rawTxs]
  );

  const txs = useMemo(() => {
    let out = rawTxs;
    if (glCodes.length > 0) out = out.filter(t => t.gl_code && glCodes.includes(t.gl_code));
    if (months.length  > 0) out = out.filter(t => t.month  && months.includes(t.month));
    return out;
  }, [rawTxs, glCodes, months]);

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const ccOptions = useMemo(
    () => [...costCenters.map(c => c.name).sort(), "Unassigned", "Conflict"],
    [costCenters]
  );

  /**
   * The cost center whose note log is shown. Only when exactly one is selected
   * — a log belongs to one entity, and with several picked there is no single
   * history to display.
   */
  const logCostCenter = useMemo(() => {
    if (costCenterNames.length !== 1) return null;
    const name = costCenterNames[0];
    if (name === "Unassigned") return { id: "__unassigned__", name };
    if (name === "Conflict")   return { id: "__conflict__",   name };
    const cc = costCenters.find(c => c.name === name);
    return cc ? { id: cc.id, name: cc.name } : null;
  }, [costCenterNames, costCenters]);

  /**
   * Cost Center filter, absorbed from the old Cost Center Report.
   *
   * Fans out by splits first so a transaction allocated only partly to the
   * selected center contributes its prorated share rather than all-or-nothing,
   * then keeps the rows belonging to the selection.
   */
  const ccFiltered = useMemo((): PLReportTxCC[] | null => {
    if (costCenterNames.length === 0) return null;
    const fanned = fanOutBySplits(txs, splitsMap);
    return fanned.filter(tx =>
      costCenterNames.some(name => {
        if (name === "Unassigned") return !tx.cost_center_id || tx.cost_center_status === "unassigned";
        if (name === "Conflict")   return tx.cost_center_status === "conflict";
        const id = costCenters.find(c => c.name === name)?.id;
        return !!id && tx.cost_center_id === id;
      })
    );
  }, [txs, costCenterNames, splitsMap, costCenters]);

  // Rows the pivot renders. When the CC filter pre-fans, splitsMap must not be
  // handed to the table too or every split row would be fanned a second time.
  const pivotTxs: PLReportTx[] = ccFiltered ?? txs;
  const pivotSplitsMap = ccFiltered ? undefined : splitsMap;

  function handleExport() {
    const suffix = loadedYears.length === 1 ? `_${loadedYears[0]}` : "";
    if (ccFiltered) {
      const flat = ccFiltered.map((tx) => ({
        ...tx,
        cost_center_name: (tx.cost_centers as { name: string } | null)?.name ?? "",
      })) as Record<string, unknown>[];
      downloadCSV(`pl_cc${suffix}.csv`, flat, [...CSV_COLUMNS, { key: "cost_center_name", label: "Cost Center" }]);
    } else {
      downloadCSV(`pl_all${suffix}.csv`, txs as unknown as Record<string, unknown>[], CSV_COLUMNS);
    }
  }

  // Active filter chips (what was actually loaded)
  const loadedChips: { label: string; value: string }[] = [];
  if (loadedYears.length > 0)
    loadedChips.push({ label: "Year", value: loadedYears.length === 1 ? loadedYears[0] : `${loadedYears.length} years` });
  if (loadedBranches.length > 0)
    loadedChips.push({ label: "Branch", value: loadedBranches.length === 1 ? loadedBranches[0] : `${loadedBranches.length} branches` });
  if (loadedSources.length > 0)
    loadedChips.push({ label: "Source", value: loadedSources.map(srcLabel).join(", ") });
  if (costCenterNames.length > 0)
    loadedChips.push({ label: "Cost Center", value: costCenterNames.length === 1 ? costCenterNames[0] : `${costCenterNames.length} centers` });

  return (
    // Canvas scoped to the page rather than <body> so modules that have not had
    // their redesign pass keep their current background.
    <div className="-m-6 min-h-screen bg-[#FCFCFA]">
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-4">
      {/* Sticky filter bar */}
      <div className="sticky top-0 z-30 rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-xs">
        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-bold uppercase tracking-wider text-[#001A40]">Filters:</span>

          <ReportFilter label="Year"   options={(opts?.year ?? []).map(String)} selected={years}    onChange={setYears} />
          <ReportFilter label="Branch" options={opts?.branch ?? []}              selected={branches} onChange={setBranches} />
          <ReportFilter
            label="Source"
            options={opts?.source ?? []}
            selected={sources}
            onChange={setSources}
          />

          <button
            onClick={load}
            disabled={loading}
            className="rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
          >
            {loading ? "Loading…" : "Run Report"}
          </button>

          {loaded && (
            <>
              <span className="text-slate-300">|</span>
              <ReportFilter label="Cost Center" options={ccOptions}     selected={costCenterNames} onChange={setCostCenterNames} />
              <ReportFilter label="GL Code"     options={glCodeOptions} selected={glCodes}         onChange={setGlCodes} />
              <ReportFilter label="Month"       options={monthOptions}  selected={months}          onChange={setMonths} />
            </>
          )}
        </div>

        {/* Active filter chips — shown after successful load */}
        {loaded && loadedChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-300">Loaded:</span>
            {loadedChips.map((chip) => (
              <FilterChip key={chip.label} label={chip.label} value={chip.value} />
            ))}
          </div>
        )}
      </div>

      {/* Page title + export */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-[#001A40]">P&amp;L All</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {ccFiltered
              ? "Filtered by Cost Center — vendor/OA allocations prorated by %. Use Pivot by: to reorder levels."
              : "Use Pivot by: to reorder or add hierarchy levels."}
          </p>
        </div>
        {loaded && (
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-600 shadow-xs hover:border-[#001A40]"
          >
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      {/* Per-month loan metrics — shown after first successful load.
          Loan officials live in their own table with independent branch naming,
          so we don't pass loadedBranches (pl_transactions branch names). Year is
          sufficient context and avoids a silent empty-panel when branch formats differ. */}
      {loaded && (
        <LoanMetricsByMonthBar
          years={loadedYears}
          branches={[]}
          sources={[]}
        />
      )}

      {/* Per-cost-center note log. Collapsible and directly under the filters,
          because it belongs to the current filter selection rather than to any
          row of the table below. */}
      {logCostCenter && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-xs">
          <button
            onClick={() => setLogOpen(o => !o)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
          >
            {logOpen
              ? <ChevronDown  size={14} className="shrink-0 text-slate-400" />
              : <ChevronRight size={14} className="shrink-0 text-slate-400" />}
            <MessageSquare size={13} className="shrink-0 text-slate-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-[#001A40]">
              Cost Center Notes Log
            </span>
            <span className="truncate text-xs text-slate-500">— {logCostCenter.name}</span>
          </button>
          {logOpen && (
            <div className="border-t border-slate-200 px-4 py-3">
              <NotesLog
                level="cost_center"
                scope={{ cost_center_id: logCostCenter.id }}
                entityLabel={logCostCenter.name}
                emptyMessage="No notes for this cost center yet."
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>
      )}

      {!loaded && !loading && (
        <p className="py-10 text-center text-sm text-slate-400">
          Select filters and click Run Report to generate the report.
        </p>
      )}

      {/* One pivot for both cases. The old "P&L by GL" / "P&L by Cost Center"
          toggle only swapped the default hierarchy, and Cost Center is now
          reachable both as a filter and as a level in "Pivot by:" — so the
          toggle no longer selected anything the user cannot pick directly. */}
      {(loaded || loading) && (
        <PivotTableDynamic
          txs={pivotTxs}
          splitsMap={pivotSplitsMap}
          defaultLevels={["op_nonop", "category_2", "category_6", "category_7", "gl"]}
          storageKey="pl_all_gl_hierarchy"
          homesiTheme
          loading={loading}
          emptyMessage="No transactions found for the selected filters."
        />
      )}
    </div>
    </div>
  );
}
