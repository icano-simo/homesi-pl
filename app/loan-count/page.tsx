"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, CheckCircle2, AlertCircle, Save, X } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import { downloadCSV } from "@/lib/csv";
import type { LoanOfficial } from "@/types";
import { LoanValidationTab } from "./loan-validation-tab";

const BOOL_FIELDS: { key: keyof LoanOfficial; label: string }[] = [
  { key: "affinity",          label: "Affinity" },
  { key: "b2b",               label: "B2B" },
  { key: "support_on_demand", label: "Support on demand" },
  { key: "processing",        label: "Processing" },
  { key: "recruitment",       label: "Recruitment" },
];

const CSV_COLUMNS = [
  { key: "month",             label: "Month" },
  { key: "year",              label: "Year" },
  { key: "loan_number",       label: "Loan Number" },
  { key: "borrower_name",     label: "Borrower Name" },
  { key: "loan_officer",      label: "Loan Officer" },
  { key: "lead_source_lo",    label: "Lead Source LO" },
  { key: "loan_info_channel", label: "Loan Info Channel" },
  { key: "branch",            label: "Branch" },
  { key: "loan_amount",       label: "Loan Amount" },
  { key: "bd_owner",          label: "BD Owner" },
  { key: "b2b",               label: "B2B" },
  { key: "processing",        label: "Processing" },
  { key: "support_on_demand", label: "Support on Demand" },
  { key: "affinity",          label: "Affinity" },
  { key: "recruitment",       label: "Recruitment" },
];

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

// ─── Bool filter toggle (All / Yes / No) ──────────────────────────────────────

type BoolFilter = "all" | "yes" | "no";

function BoolFilterToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: BoolFilter;
  onChange: (v: BoolFilter) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white px-1.5 py-0.5 h-7">
      <span className="text-[11px] text-gray-500 pr-1 border-r border-gray-200 mr-1">{label}</span>
      {(["all", "yes", "no"] as BoolFilter[]).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
            value === v
              ? v === "yes"
                ? "bg-green-600 text-white"
                : v === "no"
                ? "bg-red-500 text-white"
                : "bg-blue-600 text-white"
              : "text-gray-400 hover:text-gray-700"
          }`}
        >
          {v === "all" ? "All" : v === "yes" ? "Yes" : "No"}
        </button>
      ))}
    </div>
  );
}

// ─── Editable bool toggle ─────────────────────────────────────────────────────

function BoolToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        "h-5 w-9 rounded-full transition-colors focus:outline-none disabled:opacity-40",
        value ? "bg-green-500" : "bg-gray-200",
      ].join(" ")}
      title={value ? "Yes — click to set No" : "No — click to set Yes"}
    >
      <span
        className={[
          "block h-4 w-4 rounded-full bg-white shadow transition-transform mx-0.5",
          value ? "translate-x-4" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}

// ─── Inline text editor ───────────────────────────────────────────────────────

function TextCell({
  value,
  onSave,
  disabled,
}: {
  value: string | null;
  onSave: (v: string | null) => Promise<void>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    if (disabled) return;
    setDraft(value ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit() {
    setEditing(false);
    const next = draft.trim() || null;
    if (next !== value) await onSave(next);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full min-w-[100px] rounded border border-blue-300 bg-white px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    );
  }

  return (
    <button
      disabled={disabled}
      onClick={startEdit}
      className="w-full text-left text-xs truncate disabled:opacity-50 hover:text-blue-600"
      title={value ?? undefined}
    >
      {value ?? <span className="text-gray-300">—</span>}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type MainTab = "count" | "validation";

export default function LoanCountPage() {
  const [mainTab, setMainTab] = useState<MainTab>("count");

  const [loans, setLoans] = useState<LoanOfficial[]>([]);
  const [loading, setLoading] = useState(true);
  const [allMonths, setAllMonths] = useState<string[]>([]);
  const [allYears, setAllYears] = useState<number[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [selMonths, setSelMonths] = useState<string[]>([]);
  const [selYears, setSelYears] = useState<string[]>([]);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveErr, setSaveErr] = useState("");
  const [pendingChanges, setPendingChanges] = useState<Record<string, Partial<LoanOfficial>>>({});
  const [isSavingAll, setIsSavingAll] = useState(false);

  // Re-extraction state
  const [reextractStatus, setReextractStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [reextractResult, setReextractResult] = useState<{
    scanned: number;
    extracted: number;
    completion: { completed_from_9: number; completed_from_10: number; completed_direct: number; incomplete_no_match: number; incomplete_ambiguous: number };
    examples: { id: string; check_description: string | null; loan_number_raw: string | null; loan_number: string | null; loan_number_incomplete: boolean | null }[];
  } | null>(null);
  const [reextractError, setReextractError] = useState("");

  // Column filters
  const [filterLoanNumber, setFilterLoanNumber] = useState("");
  const [filterBranches,  setFilterBranches]  = useState<string[]>([]);
  const [filterLOs,       setFilterLOs]       = useState<string[]>([]);
  const [filterChannels,  setFilterChannels]  = useState<string[]>([]);
  const [filterB2B,       setFilterB2B]       = useState<BoolFilter>("all");
  const [filterAffinity,  setFilterAffinity]  = useState<BoolFilter>("all");
  const [filterProcessing,setFilterProcessing]= useState<BoolFilter>("all");
  const [filterOnDemand,  setFilterOnDemand]  = useState<BoolFilter>("all");
  const [filterRecruit,   setFilterRecruit]   = useState<BoolFilter>("all");

  useEffect(() => {
    fetch("/api/loan-officials/filter-options")
      .then((r) => r.json())
      .then((d: { months: string[]; years: number[]; branches: string[] }) => {
        setAllMonths(d.months ?? []);
        setAllYears(d.years ?? []);
        setAllBranches(d.branches ?? []);
      })
      .catch(console.error);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      selMonths.forEach((m) => params.append("month", m));
      selYears.forEach((y) => params.append("year", y));
      const res = await fetch(`/api/loan-officials?${params}`);
      if (res.ok) setLoans(await res.json());
    } finally { setLoading(false); }
  }, [selMonths, selYears]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (Object.keys(pendingChanges).length === 0) return;
    function handler(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = ""; }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pendingChanges]);

  async function handleUpdate(loan: LoanOfficial, field: keyof LoanOfficial, newValue: boolean | string | null) {
    setSaving((prev) => ({ ...prev, [loan.id]: true }));
    setSaveErr("");
    try {
      const res = await fetch(`/api/loan-officials/${loan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: newValue }),
      });
      const json = await res.json();
      if (!res.ok) { setSaveErr(json.error ?? "Failed to save"); return; }
      setLoans((prev) => prev.map((l) => l.id === loan.id ? { ...l, ...json } : l));
    } catch (err) {
      setSaveErr(String(err));
    } finally {
      setSaving((prev) => ({ ...prev, [loan.id]: false }));
    }
  }

  async function handleSaveAll() {
    setIsSavingAll(true);
    setSaveErr("");
    const updates: LoanOfficial[] = [];
    try {
      await Promise.all(
        Object.entries(pendingChanges).map(async ([id, changes]) => {
          const res = await fetch(`/api/loan-officials/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "Failed to save");
          updates.push(json as LoanOfficial);
        })
      );
      setLoans((prev) => {
        const byId = new Map(updates.map((u) => [u.id, u]));
        return prev.map((l) => byId.get(l.id) ?? l);
      });
      setPendingChanges({});
    } catch (err) {
      setSaveErr(String(err));
    } finally {
      setIsSavingAll(false);
    }
  }

  function handleDiscard() {
    setPendingChanges({});
  }

  const yearOptions = useMemo(() => allYears.map(String), [allYears]);

  // Column filter option lists derived from loaded data
  const branchOptions  = useMemo(() => [...new Set(loans.map(l => l.branch).filter(Boolean) as string[])].sort(), [loans]);
  const loOptions      = useMemo(() => [...new Set(loans.map(l => l.loan_officer).filter(Boolean) as string[])].sort(), [loans]);
  const channelOptions = useMemo(() => [...new Set(loans.map(l => l.loan_info_channel).filter(Boolean) as string[])].sort(), [loans]);

  const hasColumnFilters =
    filterLoanNumber.trim() !== "" ||
    filterBranches.length > 0 || filterLOs.length > 0 || filterChannels.length > 0 ||
    filterB2B !== "all" || filterAffinity !== "all" || filterProcessing !== "all" ||
    filterOnDemand !== "all" || filterRecruit !== "all";

  // Apply column filters to the loaded loans
  const displayedLoans = useMemo(() => {
    let out = loans;
    const lnSearch = filterLoanNumber.trim().toLowerCase();
    if (lnSearch) out = out.filter(l => l.loan_number?.toLowerCase().includes(lnSearch));
    if (filterBranches.length)  out = out.filter(l => l.branch           && filterBranches.includes(l.branch));
    if (filterLOs.length)       out = out.filter(l => l.loan_officer      && filterLOs.includes(l.loan_officer));
    if (filterChannels.length)  out = out.filter(l => l.loan_info_channel && filterChannels.includes(l.loan_info_channel));
    const applyBool = (arr: LoanOfficial[], f: BoolFilter, key: keyof LoanOfficial) =>
      f === "all" ? arr : arr.filter(l => f === "yes" ? l[key] : !l[key]);
    out = applyBool(out, filterB2B,        "b2b");
    out = applyBool(out, filterAffinity,   "affinity");
    out = applyBool(out, filterProcessing, "processing");
    out = applyBool(out, filterOnDemand,   "support_on_demand");
    out = applyBool(out, filterRecruit,    "recruitment");
    return out;
  }, [loans, filterLoanNumber, filterBranches, filterLOs, filterChannels, filterB2B, filterAffinity, filterProcessing, filterOnDemand, filterRecruit]);

  // Dashboard metrics computed from the full loaded set (before column filters)
  const metrics = useMemo(() => ({
    total:            loans.length,
    banked:           loans.filter(l => l.loan_info_channel === "Banked - Retail").length,
    brokered:         loans.filter(l => l.loan_info_channel === "Brokered").length,
    other:            loans.filter(l => l.loan_info_channel && l.loan_info_channel !== "Banked - Retail" && l.loan_info_channel !== "Brokered").length,
    b2b:              loans.filter(l => l.b2b).length,
    processing:       loans.filter(l => l.processing).length,
    support_on_demand:loans.filter(l => l.support_on_demand).length,
    affinity:         loans.filter(l => l.affinity).length,
    recruitment:      loans.filter(l => l.recruitment).length,
  }), [loans]);

  function clearColumnFilters() {
    setFilterLoanNumber("");
    setFilterBranches([]); setFilterLOs([]); setFilterChannels([]);
    setFilterB2B("all"); setFilterAffinity("all"); setFilterProcessing("all");
    setFilterOnDemand("all"); setFilterRecruit("all");
  }

  function handleExport() {
    downloadCSV("loan_count.csv", displayedLoans as unknown as Record<string, unknown>[], CSV_COLUMNS);
  }

  async function handleReextract() {
    setReextractStatus("running");
    setReextractResult(null);
    setReextractError("");
    try {
      const res = await fetch("/api/transactions/reextract-loan-numbers", { method: "POST" });
      const json = await res.json();
      if (!res.ok) { setReextractError(json.error ?? "Unknown error"); setReextractStatus("error"); return; }
      setReextractResult(json);
      setReextractStatus("done");
    } catch (err) {
      setReextractError(String(err));
      setReextractStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-32px)]">
      {/* Title + main tab bar */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Loan Count</h2>
          <p className="text-sm text-gray-500">Master loan list — upload via Upload P&L → Loan Count.</p>
        </div>
        <div className="flex items-center gap-2">
          {mainTab === "validation" && (
            <button
              onClick={handleReextract}
              disabled={reextractStatus === "running"}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm disabled:opacity-50"
              title="Re-scan all transactions with no loan number and re-apply extraction"
            >
              <RefreshCw size={13} className={reextractStatus === "running" ? "animate-spin" : ""} />
              {reextractStatus === "running" ? "Processing…" : "Reprocess Loan Numbers"}
            </button>
          )}
          {mainTab === "count" && Object.keys(pendingChanges).length > 0 && (
            <>
              <button
                onClick={handleDiscard}
                disabled={isSavingAll}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 shadow-sm disabled:opacity-50"
              >
                <X size={13} /> Discard Changes
              </button>
              <button
                onClick={handleSaveAll}
                disabled={isSavingAll}
                className="flex items-center gap-1.5 rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#e03535] disabled:opacity-50"
              >
                <Save size={13} className={isSavingAll ? "animate-pulse" : ""} />
                {isSavingAll ? "Saving…" : `Save Changes (${Object.keys(pendingChanges).length})`}
              </button>
            </>
          )}
          {mainTab === "count" && loans.length > 0 && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
            >
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Re-extraction result banner */}
      {mainTab === "validation" && reextractStatus === "done" && reextractResult && (
        <div className="shrink-0 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-xs text-green-900">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-600" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold">
                Re-extraction complete — {reextractResult.extracted} of {reextractResult.scanned} transactions updated
              </p>
              <p className="mt-0.5 text-green-700">
                Completed: {reextractResult.completion.completed_from_9} from 9-digit,{" "}
                {reextractResult.completion.completed_from_10} from 10-digit,{" "}
                {reextractResult.completion.completed_direct} direct 12-digit.
                {(reextractResult.completion.incomplete_no_match + reextractResult.completion.incomplete_ambiguous) > 0 && (
                  <span className="text-amber-700">
                    {" "}{reextractResult.completion.incomplete_no_match + reextractResult.completion.incomplete_ambiguous} still incomplete (no match or ambiguous).
                  </span>
                )}
              </p>
              {reextractResult.examples.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="font-medium text-green-800">Sample updated rows:</p>
                  {reextractResult.examples.map((ex) => (
                    <div key={ex.id} className="flex gap-2 font-mono text-[11px] text-green-800">
                      <span className="truncate max-w-[280px] shrink-0 text-green-600">{ex.check_description}</span>
                      <span>→ raw: <strong>{ex.loan_number_raw}</strong></span>
                      <span>→ loan: <strong>{ex.loan_number ?? (ex.loan_number_incomplete ? "⚠ incomplete" : "—")}</strong></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => setReextractStatus("idle")} className="text-green-500 hover:text-green-700 text-xs">✕</button>
          </div>
        </div>
      )}

      {/* Re-extraction error banner */}
      {mainTab === "validation" && reextractStatus === "error" && (
        <div className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-500" />
          <span className="flex-1">{reextractError}</span>
          <button onClick={() => setReextractStatus("idle")} className="text-red-400 hover:text-red-600 text-xs">✕</button>
        </div>
      )}

      {/* Main tab switcher */}
      <div className="flex gap-1 border-b border-gray-200 shrink-0 -mt-2">
        {(["count", "validation"] as MainTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            className={[
              "px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              mainTab === t
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
            ].join(" ")}
          >
            {t === "count" ? "Loan Count" : "Loan Validation"}
          </button>
        ))}
      </div>

      {/* Loan Validation tab */}
      {mainTab === "validation" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <LoanValidationTab
            allMonths={allMonths}
            allYears={allYears}
            allBranches={allBranches}
          />
        </div>
      )}

      {/* Loan Count tab content below — hidden when validation is active */}
      {mainTab === "count" && (<>

      {/* Month/Year filters */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <span className="text-xs text-gray-500 font-medium">Filter:</span>
        <ReportFilter label="Month" options={allMonths}   selected={selMonths} onChange={setSelMonths} />
        <ReportFilter label="Year"  options={yearOptions} selected={selYears}  onChange={setSelYears} />
        <input
          type="text"
          value={filterLoanNumber}
          onChange={(e) => setFilterLoanNumber(e.target.value)}
          placeholder="Loan # search…"
          className="h-7 w-40 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        {(selMonths.length > 0 || selYears.length > 0 || filterLoanNumber) && (
          <button
            onClick={() => { setSelMonths([]); setSelYears([]); setFilterLoanNumber(""); }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {loading ? "Loading…" : `${displayedLoans.length.toLocaleString()}${hasColumnFilters ? ` of ${loans.length.toLocaleString()}` : ""} loan${loans.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Metrics panel */}
      {!loading && loans.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm overflow-x-auto shrink-0">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Overview</div>
          <div className="flex items-center gap-6 min-w-max">
            <div className="flex items-end gap-4">
              <MetricCard label="Total"    value={metrics.total}    accent="gray" />
              <MetricCard label="Banked"   value={metrics.banked}   accent="blue" />
              <MetricCard label="Brokered" value={metrics.brokered} accent="indigo" />
              {metrics.other > 0 && <MetricCard label="Other" value={metrics.other} accent="orange" />}
            </div>
            {(metrics.b2b + metrics.processing + metrics.support_on_demand + metrics.affinity + metrics.recruitment > 0) && (
              <>
                <div className="h-10 w-px self-stretch bg-gray-100" />
                <div className="flex flex-wrap gap-1.5">
                  {metrics.b2b > 0              && <TagPill label="B2B"         value={metrics.b2b} />}
                  {metrics.processing > 0        && <TagPill label="Processing"  value={metrics.processing} />}
                  {metrics.support_on_demand > 0 && <TagPill label="On Demand"   value={metrics.support_on_demand} />}
                  {metrics.affinity > 0          && <TagPill label="Affinity"    value={metrics.affinity} />}
                  {metrics.recruitment > 0       && <TagPill label="Recruitment" value={metrics.recruitment} />}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {saveErr && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600 shrink-0">{saveErr}</p>
      )}

      {/* Column filters */}
      {!loading && loans.length > 0 && (
        <div className="overflow-x-auto shrink-0">
          <div className="flex items-center gap-2 min-w-max">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mr-1">Column filters</span>
            <ReportFilter label="Branch"   options={branchOptions}  selected={filterBranches} onChange={setFilterBranches} />
            <ReportFilter label="LO"       options={loOptions}      selected={filterLOs}      onChange={setFilterLOs} />
            <ReportFilter label="Channel"  options={channelOptions} selected={filterChannels} onChange={setFilterChannels} />
            <BoolFilterToggle label="B2B"         value={filterB2B}        onChange={setFilterB2B} />
            <BoolFilterToggle label="Affinity"    value={filterAffinity}   onChange={setFilterAffinity} />
            <BoolFilterToggle label="Processing"  value={filterProcessing} onChange={setFilterProcessing} />
            <BoolFilterToggle label="On Demand"   value={filterOnDemand}   onChange={setFilterOnDemand} />
            <BoolFilterToggle label="Recruitment" value={filterRecruit}    onChange={setFilterRecruit} />
            {hasColumnFilters && (
              <button onClick={clearColumnFilters} className="text-xs text-gray-400 hover:text-gray-600 underline">
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table area — flex-1 takes all remaining height */}
      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : loans.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center rounded-xl border border-gray-100 bg-white">
          <p className="text-sm text-gray-400">
            No loan data found.{" "}
            {allMonths.length === 0
              ? "Upload a Loan Count file first (Upload P&L → Loan Count)."
              : "Try adjusting the Month / Year filters."}
          </p>
        </div>
      ) : displayedLoans.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center rounded-xl border border-gray-100 bg-white">
          <p className="text-sm text-gray-400">No loans match the active column filters.</p>
          <button onClick={clearColumnFilters} className="mt-2 text-xs text-blue-600 hover:underline">Clear filters</button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="text-xs" style={{ minWidth: "100%", width: "max-content" }}>
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Month</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Loan Number</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Borrower Name</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Loan Officer</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Lead Source LO</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Loan Info Channel</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Branch</th>
                <th className="px-3 py-2.5 font-medium text-right whitespace-nowrap">Loan Amount</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">BD Owner</th>
                {BOOL_FIELDS.map((f) => (
                  <th key={f.key} className="px-3 py-2.5 font-medium text-center whitespace-nowrap">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedLoans.map((loan) => {
                const pending = pendingChanges[loan.id];
                return (
                <tr key={loan.id} className={`border-b border-gray-50 hover:bg-gray-50/60 ${pending ? "bg-amber-50/30" : ""}`}>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                    {loan.month ?? "—"}{loan.year ? ` ${loan.year}` : ""}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-800 whitespace-nowrap">
                    {loan.loan_number}
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2 font-medium text-gray-800">
                    {loan.borrower_name ?? "—"}
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2 text-gray-600">
                    {loan.loan_officer ?? "—"}
                  </td>
                  <td className="max-w-[120px] px-3 py-2 text-gray-600">
                    <TextCell
                      value={loan.lead_source_lo}
                      onSave={(v) => handleUpdate(loan, "lead_source_lo", v)}
                      disabled={!!saving[loan.id] || isSavingAll}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {loan.loan_info_channel ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                    {loan.branch ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700">
                    {fmt(loan.loan_amount)}
                  </td>
                  <td className="max-w-[120px] px-3 py-2 text-gray-600">
                    <TextCell
                      value={loan.bd_owner}
                      onSave={(v) => handleUpdate(loan, "bd_owner", v)}
                      disabled={!!saving[loan.id] || isSavingAll}
                    />
                  </td>
                  {BOOL_FIELDS.map((f) => (
                    <td key={f.key} className="px-3 py-2 text-center">
                      <BoolToggle
                        value={(pending?.[f.key] as boolean | undefined) ?? (loan[f.key] as boolean)}
                        onChange={(v) => {
                          setPendingChanges((prev) => ({
                            ...prev,
                            [loan.id]: { ...(prev[loan.id] ?? {}), [f.key]: v },
                          }));
                        }}
                        disabled={isSavingAll}
                      />
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>)}
    </div>
  );
}

function MetricCard({ label, value, accent }: { label: string; value: number; accent: "gray" | "blue" | "indigo" | "orange" }) {
  const colors = { gray: "text-gray-900", blue: "text-blue-700", indigo: "text-indigo-700", orange: "text-orange-700" };
  return (
    <div className="flex flex-col items-center min-w-[40px]">
      <span className={`text-xl font-bold tabular-nums ${colors[accent]}`}>{value.toLocaleString()}</span>
      <span className="text-[10px] text-gray-400 mt-0.5">{label}</span>
    </div>
  );
}

function TagPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-[11px]">
      <span className="font-semibold text-indigo-700">{value}</span>
      <span className="text-indigo-500">{label}</span>
    </span>
  );
}
