"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { PivotTableDynamic } from "@/components/pivot-table-dynamic";
import { ReportFilter } from "@/components/report-filter";
import { LoanMetricsByMonthBar } from "@/components/loan-metrics-by-month";
import { useLoanMetrics } from "@/lib/use-loan-metrics";
import { LoanDetailDrawer } from "@/components/loan-detail-drawer";
import { CellDetailModal } from "@/components/cell-detail-modal";
import { NoteWindow } from "@/components/note-window";
import { NotesLog } from "@/components/notes-log";
import { buildSplitsMap } from "@/lib/apply-splits";
import { downloadCSV } from "@/lib/csv";
import { hierarchyLabel, hierarchyLevels, SHAPE_LABELS, type HierarchyShape } from "@/lib/pl-hierarchies";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import type { SplitEntry } from "@/lib/apply-splits";
import { OrphanedNotesPanel } from "@/components/orphaned-notes-panel";
import { defaultScopeLabel } from "@/lib/note-scope";
import type { CellRef } from "@/lib/cell-ref";
import type { PLNote, ScopeKey } from "@/lib/note-scope";
import type { PivotField } from "@/lib/pivot-engine";
import type { CostCenter, PLReportTx, FilterOptionsResponse } from "@/types";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/** Every dimension a note can be anchored by here, for orphan breadcrumbs. */
const SCOPE_ORDER: ScopeKey[] = [
  "cost_center", "op_nonop", "category_6", "category_7", "gl", "month", "year",
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

const SOURCE_LABELS: Record<string, string> = {
  original:             "Original",
  addback:              "Addback",
  offshore_allocations: "OA",
  manual_entry:         "Manual Entry",
};
function srcLabel(s: string) { return SOURCE_LABELS[s] ?? s; }

/**
 * The one thing on screen besides the report.
 *
 * A single value rather than one flag per window, and that is the whole point:
 * with three booleans, "only one open at a time" is a rule that every new
 * caller has to remember. With one value it is a property of the state — two
 * cannot be open because there is nowhere to put the second.
 */
type Panel =
  | { kind: "loans"; month: string }
  | { kind: "cell";  ref: CellRef }
  | { kind: "notes"; ref: CellRef }
  | null;

function FilterChip({ label, value }: { label: string; value: string }) {
  // Branch gets more weight than the rest. It is the context that slips out of
  // mind first when reading a grid of figures, and reading the right numbers
  // under the wrong branch is the expensive mistake.
  const isBranch = label === "Branch";
  return (
    <span
      className={
        isBranch
          ? "inline-flex items-center gap-1.5 rounded-full border border-sky-300 bg-sky-100 px-3.5 py-1.5 text-sm font-bold text-sky-900"
          : "inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-900"
      }
    >
      <span className={isBranch ? "text-xs font-semibold uppercase tracking-wide text-sky-600" : "font-normal text-sky-500"}>
        {label}:
      </span>
      {value}
    </span>
  );
}

export default function PLPage() {
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
  /** The same set the table drew its indicators from — see onResolvedNotes. */
  const [placedNotes, setPlacedNotes] = useState<PLNote[]>([]);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [loaded,  setLoaded]  = useState(false);
  const autoLoaded = useRef(false);

  // The four named views. No reordering, so nothing to persist and nothing
  // that can differ between two people looking at the same report.
  const [shape,   setShape]   = useState<HierarchyShape>("regular");
  const [opNonOp, setOpNonOp] = useState(false);

  const [costCenterNames, setCostCenterNames] = useState<string[]>([]);
  const [costCenters,     setCostCenters]     = useState<CostCenter[]>([]);
  const [glCodes, setGlCodes] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(true);

  const [loadedYears,    setLoadedYears]    = useState<string[]>([]);

  const [loadedBranches, setLoadedBranches] = useState<string[]>([]);
  const [loadedSources,  setLoadedSources]  = useState<string[]>([]);

  // Same panel as P&L All, same hook, same filters the table is showing.
  const loanMetrics = useLoanMetrics(loadedYears, loadedBranches, loadedSources);

  const [panel, setPanel] = useState<Panel>(null);

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

  const monthOptions = useMemo(
    () => MONTH_ORDER.filter(m => rawTxs.some(t => t.month === m)),
    [rawTxs]
  );

  const glCodeOptions = useMemo(
    () => [...new Set(rawTxs.map(t => t.gl_code).filter(Boolean) as string[])].sort(),
    [rawTxs]
  );

  const txs = useMemo(() => {
    let out = rawTxs;
    if (months.length  > 0) out = out.filter(t => t.month   && months.includes(t.month));
    if (glCodes.length > 0) out = out.filter(t => t.gl_code && glCodes.includes(t.gl_code));
    return out;
  }, [rawTxs, months, glCodes]);

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const levels = useMemo(() => hierarchyLevels({ shape, opNonOp }), [shape, opNonOp]);

  const ccOptions = useMemo(
    () => [...costCenters.map(c => c.name).sort(), "Unassigned", "Conflict"],
    [costCenters]
  );

  /**
   * The filter as stable scope values, which is what the table compares
   * against. Resolved here and memoised so the table’s own memo is not
   * invalidated on every render.
   */
  const costCenterFilter = useMemo<string[] | null>(() => {
    if (costCenterNames.length === 0) return null;
    return costCenterNames.map((name) => {
      if (name === "Unassigned") return "__unassigned__";
      if (name === "Conflict")   return "__conflict__";
      return costCenters.find(c => c.name === name)?.id ?? "__none__";
    });
  }, [costCenterNames, costCenters]);

  /** A log belongs to one entity; with several picked there is no single
   *  history to show. */
  const logCostCenter = useMemo(() => {
    if (costCenterNames.length !== 1) return null;
    const name = costCenterNames[0];
    if (name === "Unassigned") return { id: "__unassigned__", name };
    if (name === "Conflict")   return { id: "__conflict__",   name };
    const cc = costCenters.find(c => c.name === name);
    return cc ? { id: cc.id, name: cc.name } : null;
  }, [costCenterNames, costCenters]);

  function handleExport() {
    const suffix = loadedYears.length === 1 ? `_${loadedYears[0]}` : "";
    downloadCSV(`pl${suffix}.csv`, txs as unknown as Record<string, unknown>[], CSV_COLUMNS);
  }

  /** Anchor notes to a year only when the report covers exactly one. With
   *  several loaded a month column merges them, so the cell spans periods and
   *  has none to point at. */
  const scopeYear = useMemo(() => {
    const ys = new Set(rawTxs.map(t => t.year).filter((y): y is number => y != null));
    return ys.size === 1 ? [...ys][0] : undefined;
  }, [rawTxs]);

  /**
   * Stable ids in a note's scope are not display text.
   *
   * Built here rather than inside the notes window because the raw transactions
   * are the only place the names live: a scope stores 41309 and a cost centre
   * UUID, and a window that printed those verbatim would be telling the reader
   * what the note is anchored to in a language only the database speaks.
   */
  const labelFor = useMemo(() => {
    const glNames = new Map<string, string>();
    const ccNames = new Map<string, string>();
    for (const tx of rawTxs) {
      if (tx.gl_code) glNames.set(tx.gl_code, tx.gl_name ? `${tx.gl_code} — ${tx.gl_name}` : tx.gl_code);
      if (tx.cost_center_id && tx.cost_centers?.name) ccNames.set(tx.cost_center_id, tx.cost_centers.name);
    }
    return (key: ScopeKey, value: string): string => {
      if (key === "gl")             return glNames.get(value) ?? value;
      if (key === "cost_center")    return ccNames.get(value) ?? defaultScopeLabel(key, value);
      // A raw UUID adds nothing to a trail; scopeBreadcrumb drops empty crumbs.
      if (key === "transaction_id") return "";
      return defaultScopeLabel(key, value);
    };
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
  if (costCenterNames.length > 0)
    loadedChips.push({ label: "Cost Center", value: costCenterNames.length === 1 ? costCenterNames[0] : `${costCenterNames.length} centers` });
  if (glCodes.length > 0)
    loadedChips.push({ label: "GL Code", value: glCodes.length === 1 ? glCodes[0] : `${glCodes.length} codes` });

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
              <ReportFilter label="Month"       options={monthOptions}  selected={months}          onChange={setMonths} />
              <ReportFilter label="Cost Center" options={ccOptions}     selected={costCenterNames} onChange={setCostCenterNames} />
              <ReportFilter label="GL Code"     options={glCodeOptions} selected={glCodes}         onChange={setGlCodes} />
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300"
              >
                <Download size={12} /> CSV
              </button>
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
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold text-[#001A40]">P&amp;L</h2>
          {/* The view is named, and the name is on screen. A screenshot of
              this report says which of the four shapes produced it. */}
          <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5">
            {(Object.keys(SHAPE_LABELS) as HierarchyShape[]).map((sh) => (
              <button
                key={sh}
                onClick={() => setShape(sh)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  shape === sh ? "bg-[#A6DEFF]/30 font-semibold text-[#001A40]" : "text-slate-500 hover:text-[#001A40]"}`}
              >
                {SHAPE_LABELS[sh]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setOpNonOp(v => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              opNonOp ? "border-sky-200 bg-sky-50 text-sky-900"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            Op / Non-Op
          </button>
          <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
            {hierarchyLabel({ shape, opNonOp })}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          Click a figure to open it one level down — a cost centre into
          categories, a category into accounts, an account into descriptions —
          and to write a note about that cell or any row beneath it. Click the
          dot beside a figure to read, edit and add notes on that same cell.
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
        <span className="text-[11px] text-slate-400">
          Click a dot to read, edit and add · click the figure to open one level down
        </span>
      </div>

      {/* Per-month loan metrics — the same panel P&L All shows, from the same
          hook and the same request, so the two reports can never disagree about
          how many loans a month had. */}
      {loaded && (
        <LoanMetricsByMonthBar
          data={loanMetrics.data}
          loading={loanMetrics.loading}
          error={loanMetrics.error}
          mode={loanMetrics.mode}
          onModeChange={loanMetrics.setMode}
          showBps={loanMetrics.showBps}
          onShowBpsChange={loanMetrics.setShowBps}
          bpsBase={loanMetrics.bpsBase}
          onBpsBaseChange={loanMetrics.setBpsBase}
          onOpenMonth={(m) => setPanel({ kind: "loans", month: m })}
        />
      )}

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
          defaultLevels={levels}
          costCenterFilter={costCenterFilter}
          onDrillCell={(ref) => setPanel({ kind: "cell", ref })}
          onOpenNotes={(ref) => setPanel({ kind: "notes", ref })}
          // No storageKey: nothing to persist when the hierarchy cannot change,
          // and it keeps a stale saved order from ever resurfacing here.
          lockHierarchy
          enableNotes
          homesiTheme
          bpsBaseByMonth={loanMetrics.bpsBaseByMonth}
          bpsBaseLabel={loanMetrics.bpsBaseLabel}
          notes={notes}
          onNotesChanged={() => refreshNotes(loadedYears)}
          onOrphansChange={setOrphans}
          onResolvedNotes={setPlacedNotes}
          scopeYear={scopeYear}
          loading={loading}
          emptyMessage="No transactions found for the selected filters."
        />
      )}
        <CellDetailModal
          cell={panel?.kind === "cell" ? panel.ref : null}
          notes={placedNotes}
          onClose={() => setPanel(null)}
          onNoteSaved={() => refreshNotes(loadedYears)}
        />

        <NoteWindow
          cell={panel?.kind === "notes" ? panel.ref : null}
          notes={placedNotes}
          scopeOrder={SCOPE_ORDER}
          labelFor={labelFor}
          onClose={() => setPanel(null)}
          onChanged={() => refreshNotes(loadedYears)}
          // The short path out of the short window: same cell, full detail,
          // and the only place a note is written.
          onOpenDetail={() => setPanel(panel?.kind === "notes" ? { kind: "cell", ref: panel.ref } : null)}
        />

        <LoanDetailDrawer
          open={panel?.kind === "loans"}
          month={panel?.kind === "loans" ? panel.month : null}
          year={loadedYears.length === 1 ? Number(loadedYears[0]) : null}
          branches={loadedBranches}
          sources={loadedSources}
          onClose={() => setPanel(null)}
        />
    </div>
    </div>

  );
}
