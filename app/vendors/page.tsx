"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Search, RefreshCw, Percent, Wand2, X } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { ReportFilter } from "@/components/report-filter";
import { SplitEditor } from "@/components/split-editor";
import { buildSplitsMap } from "@/lib/apply-splits";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import { SplitDisplay } from "@/components/split-display";
import type { SplitEntry } from "@/lib/apply-splits";
import type { CostCenter, VendorSummary } from "@/types";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function sortMonths(arr: string[]): string[] {
  return [...arr].sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));
}

export default function VendorsPage() {
  const { activeBranches } = useActiveBranches();
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [allMonths, setAllMonths]     = useState<string[]>([]);
  const [allYears, setAllYears]       = useState<string[]>([]);

  const [filterBranches, setFilterBranches] = useState<string[]>([]);
  const [filterMonths, setFilterMonths]     = useState<string[]>([]);
  const [filterYears, setFilterYears]       = useState<string[]>([]);

  const [vendors, setVendors]         = useState<VendorSummary[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [allSplits, setAllSplits]     = useState<SplitEntry[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");

  const [query, setQuery]       = useState("");
  const [editing, setEditing]   = useState<VendorSummary | null>(null);
  const [unassigning, setUnassigning] = useState<string | null>(null); // vendor_key being confirmed
  const [unassignBusy, setUnassignBusy] = useState(false);

  // Apply Existing Assignments state
  const [applyCount,   setApplyCount]   = useState<number | null>(null);
  const [applyDialog,  setApplyDialog]  = useState(false);
  const [applyRunning, setApplyRunning] = useState(false);
  const [applyResult,  setApplyResult]  = useState<{
    assigned: number; breakdown: { key: string; count: number }[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/cost-centers")
      .then((r) => r.json())
      .then((data: CostCenter[]) => setCostCenters(data))
      .catch(console.error);
    fetch("/api/cc-allocation-splits")
      .then((r) => r.json())
      .then((data: SplitEntry[]) => setAllSplits(data))
      .catch(console.error);
  }, []);

  const fetchVendors = useCallback(async (
    branches: string[], months: string[], years: string[], isInitial = false,
  ) => {
    setLoading(true); setError("");
    try {
      const effectiveBranches = mergeWithGlobal(activeBranches, branches);
      const p = new URLSearchParams();
      effectiveBranches.forEach((b) => p.append("branch", b));
      months.forEach((m) => p.append("month", m));
      years.forEach((y) => p.append("year", y));
      const res = await fetch(`/api/vendors?${p}`);
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Failed to load"); return; }
      const data = await res.json() as VendorSummary[];
      setVendors(data);
      if (isInitial) {
        const bs = [...new Set(data.flatMap((v) => v.branches))].sort();
        const ms = sortMonths([...new Set(data.flatMap((v) => v.months))]);
        const ys = [...new Set(data.flatMap((v) => v.years))].sort((a, b) => Number(a) - Number(b));
        setAllBranches(bs); setAllMonths(ms); setAllYears(ys);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeBranches]);

  const loadApplyCount = useCallback(async () => {
    const res = await fetch("/api/vendors/apply-existing");
    if (res.ok) { const j = await res.json(); setApplyCount(j.count ?? 0); }
  }, []);

  useEffect(() => { fetchVendors([], [], [], true); }, [fetchVendors]);
  useEffect(() => { loadApplyCount(); }, [loadApplyCount]);

  const filtersKey = `${filterBranches.join("|")}||${filterMonths.join("|")}||${filterYears.join("|")}`;
  const isInitialFilters = filterBranches.length === 0 && filterMonths.length === 0 && filterYears.length === 0;
  useEffect(() => {
    if (isInitialFilters) return;
    fetchVendors(filterBranches, filterMonths, filterYears, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const filtered = useMemo(() => {
    if (!query.trim()) return vendors;
    const q = query.toLowerCase();
    return vendors.filter((v) => v.vendor.toLowerCase().includes(q));
  }, [vendors, query]);

  async function handleApplyExisting() {
    setApplyRunning(true);
    setApplyResult(null);
    try {
      const res = await fetch("/api/vendors/apply-existing", { method: "POST" });
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Apply failed"); return; }
      const result = await res.json();
      setApplyResult(result);
      setApplyDialog(false);
      await Promise.all([fetchVendors(filterBranches, filterMonths, filterYears, false), loadApplyCount()]);
    } finally {
      setApplyRunning(false);
    }
  }

  function handleExport() {
    const data = filtered.map((v) => ({
      vendor:               v.vendor,
      tx_count:             v.tx_count,
      tx_count_unassigned:  v.tx_count_unassigned,
      branches:             v.branches.join(", "),
      months:               v.months.join(", "),
      years:                v.years.join(", "),
      gl_items:             v.gl_items.map((g) => `${g.gl_code}: ${g.gl_name}`).join("; "),
      cost_centers:         v.cost_centers.join(", "),
    }));
    downloadCSV("vendors.csv", data, [
      { key: "vendor",              label: "Vendor" },
      { key: "tx_count",            label: "Total Tx" },
      { key: "tx_count_unassigned", label: "Unassigned Tx" },
      { key: "branches",            label: "Branches" },
      { key: "months",              label: "Months" },
      { key: "years",               label: "Years" },
      { key: "gl_items",            label: "GL Codes / Names" },
      { key: "cost_centers",        label: "Cost Centers" },
    ]);
  }

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-32px)]">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Vendors</h2>
          <p className="text-sm text-gray-500">
            {loading ? "Loading…" : `${filtered.length} of ${vendors.length} vendors`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {filtered.length > 0 && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              <Download size={14} />
              Export CSV
            </button>
          )}
          <button
            onClick={() => { setApplyResult(null); setApplyDialog(true); }}
            disabled={loading || applyCount === 0}
            title={applyCount === 0 ? "No unassigned vendor transactions matching existing assignments" : undefined}
            className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-default"
          >
            <Wand2 size={14} />
            Apply Existing
            {applyCount !== null && applyCount > 0 && (
              <span className="ml-0.5 rounded-full bg-blue-200 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                {applyCount}
              </span>
            )}
          </button>
          <button
            onClick={() => fetchVendors(filterBranches, filterMonths, filterYears, false)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <ReportFilter label="Branch" options={allBranches} selected={filterBranches}
          onChange={(v) => { setFilterBranches(v); if (!loading) fetchVendors(v, filterMonths, filterYears, false); }} />
        <ReportFilter label="Month" options={allMonths} selected={filterMonths}
          onChange={(v) => { setFilterMonths(v); if (!loading) fetchVendors(filterBranches, v, filterYears, false); }} />
        <ReportFilter label="Year" options={allYears} selected={filterYears}
          onChange={(v) => { setFilterYears(v); if (!loading) fetchVendors(filterBranches, filterMonths, v, false); }} />

        <div className="relative flex-1 max-w-xs ml-auto">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" placeholder="Search vendors…"
            value={query} onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm focus:border-blue-400 focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 shrink-0">{error}</p>
      )}

      {applyResult && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <Wand2 size={15} className="shrink-0 text-blue-600" />
            <span className="text-sm text-blue-800">
              Applied existing assignments to{" "}
              <strong>{applyResult.assigned}</strong> transaction{applyResult.assigned !== 1 ? "s" : ""}.
              {applyResult.breakdown.length > 0 && (
                <span className="ml-1 text-blue-600">
                  ({applyResult.breakdown.map((b) => `${b.key}: ${b.count}`).join(", ")})
                </span>
              )}
            </span>
          </div>
          <button onClick={() => setApplyResult(null)} className="ml-3 text-blue-400 hover:text-blue-600">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 rounded-xl border border-gray-200 bg-white shadow-sm overflow-auto min-h-0">
        {loading ? (
          <div className="py-12 text-center text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
            <p className="mt-2 text-xs">Loading vendor data…</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-400">No vendors found.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Vendor</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Total Tx</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Unassigned</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Branches</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">GL Code / Name</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Current CCs</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Allocation</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.vendor_key} className="border-b border-gray-50 hover:bg-gray-50 align-middle">
                  <td className="px-4 py-2.5 font-medium text-gray-900 max-w-[200px] truncate whitespace-nowrap">
                    {v.vendor || <span className="text-gray-400 italic">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600 tabular-nums">{v.tx_count}</td>
                  <td className="px-4 py-2.5">
                    {v.tx_count_unassigned > 0
                      ? <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-600">{v.tx_count_unassigned}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex flex-wrap gap-1">
                      {v.branches.map((b) => (
                        <span key={b} className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{b}</span>
                      ))}
                      {v.branches.length === 0 && <span className="text-gray-300">—</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      {v.gl_items.slice(0, 3).map((g) => (
                        <span key={g.gl_code} className="flex gap-1.5">
                          <span className="font-mono text-gray-700">{g.gl_code}</span>
                          <span className="text-gray-400 truncate max-w-[160px]">{g.gl_name}</span>
                        </span>
                      ))}
                      {v.gl_items.length > 3 && (
                        <span className="text-gray-400">+{v.gl_items.length - 3} more</span>
                      )}
                      {v.gl_items.length === 0 && <span className="text-gray-300">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {(() => {
                      const normVendor = v.vendor.trim().replace(/\s+/g, " ");
                      const splits = normVendor ? splitsMap.get(`vendor:${normVendor}`) : undefined;
                      if (splits && splits.length > 0) {
                        return <SplitDisplay splits={splits} />;
                      }
                      return (
                        <span className="inline-flex flex-wrap gap-1">
                          {v.cost_centers.map((cc) => (
                            <span key={cc} className={[
                              "rounded px-1.5 py-0.5 font-medium",
                              cc === "Unassigned" ? "bg-gray-100 text-gray-500" :
                              cc === "Conflict"   ? "bg-gray-100 text-gray-600" :
                                                   "bg-green-50 text-green-700",
                            ].join(" ")}>{cc}</span>
                          ))}
                          {v.cost_centers.length === 0 && <span className="text-gray-300">—</span>}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2.5">
                    {v.vendor ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setEditing(v)}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 whitespace-nowrap"
                        >
                          <Percent size={11} />
                          Edit allocation
                        </button>
                        {/* Unassign — only visible when a split is defined for this vendor */}
                        {splitsMap.get(`vendor:${v.vendor.trim().replace(/\s+/g, " ")}`) && (
                          unassigning === v.vendor_key ? (
                            <span className="flex items-center gap-1 text-[11px]">
                              <span className="text-red-600 font-medium">Remove?</span>
                              <button
                                onClick={async () => {
                                  setUnassignBusy(true);
                                  await fetch(
                                    `/api/cc-allocation-splits?type=vendor&value=${encodeURIComponent(v.vendor)}`,
                                    { method: "DELETE" }
                                  );
                                  setUnassignBusy(false);
                                  setUnassigning(null);
                                  fetchVendors(filterBranches, filterMonths, filterYears, false);
                                  fetch("/api/cc-allocation-splits").then(r => r.json()).then(setAllSplits).catch(console.error);
                                }}
                                disabled={unassignBusy}
                                className="rounded px-1.5 py-0.5 bg-red-600 text-white text-[10px] hover:bg-red-700 disabled:opacity-40"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setUnassigning(null)}
                                className="rounded px-1.5 py-0.5 border border-gray-200 text-gray-500 text-[10px] hover:bg-gray-50"
                              >
                                No
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setUnassigning(v.vendor_key)}
                              title="Remove this vendor's cost center allocation"
                              className="rounded-lg border border-gray-100 px-2 py-1.5 text-[11px] text-red-400 hover:border-red-200 hover:text-red-600 whitespace-nowrap"
                            >
                              Unassign
                            </button>
                          )
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Apply Existing Assignments confirmation dialog */}
      {applyDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
              <Wand2 size={18} className="mt-0.5 shrink-0 text-blue-600" />
              <div>
                <h3 className="text-base font-semibold text-gray-900">Apply Existing Assignments</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Found{" "}
                  <span className="font-semibold text-gray-900">{applyCount}</span>{" "}
                  unassigned vendor transaction{applyCount !== 1 ? "s" : ""} matching
                  existing manual assignments. Apply the same Cost Center assignments to these transactions?
                </p>
                <p className="mt-2 text-xs text-gray-400">
                  Only unassigned transactions will be affected. Transactions already assigned will not be changed.
                  Assignment origin will be set to "manual".
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <button
                onClick={() => setApplyDialog(false)}
                disabled={applyRunning}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyExisting}
                disabled={applyRunning}
                className="flex items-center gap-2 rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#e03535] disabled:opacity-50"
              >
                {applyRunning && (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                )}
                {applyRunning
                  ? "Applying…"
                  : `Apply to ${applyCount} transaction${applyCount !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Split editor modal */}
      {editing && (
        <SplitEditor
          assignType="vendor"
          assignValue={editing.vendor}
          displayName={editing.vendor}
          txCount={editing.tx_count}
          costCenters={costCenters}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            fetchVendors(filterBranches, filterMonths, filterYears, false);
            fetch("/api/cc-allocation-splits").then(r => r.json()).then(setAllSplits).catch(console.error);
          }}
        />
      )}
    </div>
  );
}
