"use client";

import { useState, useCallback, useEffect, useMemo, Fragment } from "react";
import { ChevronDown, ChevronRight, Download, AlertTriangle, CheckCircle, TrendingUp } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import * as XLSX from "xlsx";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import type { ValidationResult, ValidationRow, SurplusRow } from "@/app/api/loan-validation/route";

// ─── Sub-tab config ───────────────────────────────────────────────────────────

type ValType = "b2b" | "all_loans";

const SUB_TABS: { type: ValType; label: string; glLabel: string }[] = [
  { type: "all_loans",  label: "All Loans",  glLabel: "DM Margin (41309)" },
  { type: "b2b",        label: "B2B",        glLabel: "B2B Success Fee" },
];

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtUSD(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtBPS(n: number | null | undefined) {
  if (n == null) return "—";
  return `${n.toFixed(1)} bps`;
}
function fmtMov(n: number) {
  const cls = n >= 0 ? "text-emerald-700" : "text-red-600";
  const s = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Math.abs(n));
  return <span className={`font-mono ${cls}`}>{n < 0 ? `(${s})` : s}</span>;
}

// ─── xlsx export helper ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exportToXlsx(filename: string, rows: Record<string, any>[], cols: { key: string; label: string }[]) {
  const aoa = [
    cols.map((c) => c.label),
    ...rows.map((r) => cols.map((c) => r[c.key] ?? "")),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Summary strip ────────────────────────────────────────────────────────────

/**
 * Counts what the table below is showing.
 *
 * It used to print the server's totals whatever the filters were — the comment
 * beside it even said so — so typing a loan number narrowed the rows and left
 * the strip untouched. The loaded totals still matter, so they are kept beside
 * the filtered ones and labelled rather than dropped.
 */
function SummaryStrip({ summary, shown }: {
  summary: ValidationResult["summary"];
  /** Null when nothing is filtered, so no "of N" is drawn. */
  shown: { match: number; missing: number; exempt: number; surplus: number } | null;
}) {
  const Of = ({ v, full, cls }: { v: number; full: number; cls: string }) =>
    v === full ? null : <span className={`text-[10px] ${cls}`}>of {full}</span>;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5">
        <CheckCircle size={13} className="text-green-600" />
        <span className="text-xs font-semibold text-green-700">{shown ? shown.match : summary.match_count}</span>
        {shown && <Of v={shown.match} full={summary.match_count} cls="text-green-500" />}
        <span className="text-xs text-green-600">match{(shown ? shown.match : summary.match_count) !== 1 ? "es" : ""}</span>
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5">
        <AlertTriangle size={13} className="text-amber-600" />
        <span className="text-xs font-semibold text-amber-700">{shown ? shown.missing : summary.missing_count}</span>
        {shown && <Of v={shown.missing} full={summary.missing_count} cls="text-amber-500" />}
        <span className="text-xs text-amber-600">missing in accounting</span>
      </div>
      {/* Counted apart from missing, and in slate: these are not findings, and
          folding them into the amber number would inflate exactly the figure
          someone acts on. */}
      {(shown ? shown.exempt : summary.exempt_count) > 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
          <span className="text-xs font-semibold text-slate-700">{shown ? shown.exempt : summary.exempt_count}</span>
          {shown && <Of v={shown.exempt} full={summary.exempt_count} cls="text-slate-400" />}
          <span className="text-xs text-slate-600">branch exempt</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5">
        <TrendingUp size={13} className="text-blue-600" />
        <span className="text-xs font-semibold text-blue-700">{shown ? shown.surplus : summary.surplus_count}</span>
        {shown && <Of v={shown.surplus} full={summary.surplus_count} cls="text-blue-500" />}
        <span className="text-xs text-blue-600">surplus in accounting</span>
      </div>
    </div>
  );
}

// ─── Surplus section ──────────────────────────────────────────────────────────

function SurplusSection({ rows, type }: { rows: SurplusRow[]; type: ValType }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  const isFlagged = type !== "all_loans";
  const flaggedRows    = isFlagged ? rows.filter((r) => r.surplus_reason === "loan_exists_not_flagged") : [];
  const notFoundRows   = isFlagged ? rows.filter((r) => r.surplus_reason === "loan_not_found") : [];
  const unresolvedRows = isFlagged ? rows.filter((r) => r.surplus_reason === "loan_number_unresolved") : [];
  const flagName = "b2b";

  function handleExport() {
    exportToXlsx(`surplus-${type}-${todayISO()}.xlsx`, rows.map((r) => ({
      loan_number:       r.loan_number ?? "",
      check_description: r.check_description ?? "",
      gl_code:           r.gl_code ?? "",
      branch:            r.branch ?? "",
      month:             r.month ?? "",
      year:              r.year ?? "",
      movement:          r.movement,
      status:            r.surplus_reason === "loan_exists_not_flagged"
                           ? `${flagName}=false`
                           : r.surplus_reason === "loan_not_found"
                           ? "Not in master list"
                           : "Loan # unresolved",
    })), [
      { key: "loan_number",       label: "Loan Number" },
      { key: "check_description", label: "Check Description" },
      { key: "gl_code",           label: "GL Code" },
      { key: "branch",            label: "Branch" },
      { key: "month",             label: "Month" },
      { key: "year",              label: "Year" },
      { key: "movement",          label: "Movement" },
      { key: "status",            label: "Status" },
    ]);
  }

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-blue-50/80 transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={13} className="text-blue-500" /> : <ChevronRight size={13} className="text-blue-500" />}
        <span className="text-xs font-semibold text-blue-700">{rows.length} surplus in accounting</span>
        {isFlagged ? (
          <span className="flex items-center gap-1.5 ml-1">
            {flaggedRows.length > 0 && (
              <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
                {flaggedRows.length} {flagName}=false
              </span>
            )}
            {notFoundRows.length > 0 && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                {notFoundRows.length} not in officials
              </span>
            )}
            {unresolvedRows.length > 0 && (
              <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                {unresolvedRows.length} loan# unresolved
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-blue-500">
            — transactions with this GL code whose loan number is not in the filtered Loan Officials set
          </span>
        )}
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); handleExport(); }}
            className="ml-auto flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"
          >
            <Download size={11} /> Excel
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-blue-100">
          {isFlagged ? (
            <div>
              {/* Sub-group 1: Loan exists but not flagged */}
              {flaggedRows.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 bg-orange-50 border-b border-orange-100">
                    <span className="text-[11px] font-semibold text-orange-700">
                      {flaggedRows.length} — Loan exists but {flagName} = false
                    </span>
                  </div>
                  <div className="overflow-auto max-h-72">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-orange-50">
                        <tr className="text-left text-orange-600/80 border-b border-orange-100">
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Loan Number</th>
                          <th className="px-3 py-2 font-medium">Check Description</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">GL Code</th>
                          <th className="px-3 py-2 font-medium">Branch</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Month</th>
                          <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Movement</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {flaggedRows.map((r, i) => (
                          <tr key={i} className="border-b border-orange-50 hover:bg-orange-50/60">
                            <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{r.loan_number}</td>
                            <td className="max-w-[240px] truncate px-3 py-1.5 text-gray-600 text-[11px]" title={r.check_description ?? ""}>{r.check_description ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.gl_code ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.branch ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.month ?? "—"}{r.year ? ` ${r.year}` : ""}</td>
                            <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtMov(r.movement)}</td>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">{flagName}=false</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Sub-group 2: Loan not found in officials at all */}
              {notFoundRows.length > 0 && (
                <div className={flaggedRows.length > 0 ? "border-t border-blue-100" : ""}>
                  <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-[11px] font-semibold text-gray-600">
                      {notFoundRows.length} — Loan not in master list
                    </span>
                  </div>
                  <div className="overflow-auto max-h-60">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr className="text-left text-gray-500 border-b border-gray-100">
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Loan Number</th>
                          <th className="px-3 py-2 font-medium">Check Description</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">GL Code</th>
                          <th className="px-3 py-2 font-medium">Branch</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Month</th>
                          <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Movement</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notFoundRows.map((r, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/60">
                            <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{r.loan_number ?? "—"}</td>
                            <td className="max-w-[240px] truncate px-3 py-1.5 text-gray-600 text-[11px]" title={r.check_description ?? ""}>{r.check_description ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.gl_code ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.branch ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.month ?? "—"}{r.year ? ` ${r.year}` : ""}</td>
                            <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtMov(r.movement)}</td>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">Not in master list</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Sub-group 3: Loan number null or ambiguous */}
              {unresolvedRows.length > 0 && (
                <div className={(flaggedRows.length > 0 || notFoundRows.length > 0) ? "border-t border-blue-100" : ""}>
                  <div className="px-4 py-1.5 bg-purple-50 border-b border-purple-100">
                    <span className="text-[11px] font-semibold text-purple-700">
                      {unresolvedRows.length} — Loan number not resolved (null or ambiguous)
                    </span>
                  </div>
                  <div className="overflow-auto max-h-60">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-purple-50">
                        <tr className="text-left text-purple-600/80 border-b border-purple-100">
                          <th className="px-3 py-2 font-medium">Description</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">GL Code</th>
                          <th className="px-3 py-2 font-medium">Branch</th>
                          <th className="px-3 py-2 font-medium whitespace-nowrap">Month</th>
                          <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Movement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unresolvedRows.map((r, i) => (
                          <tr key={i} className="border-b border-purple-50 hover:bg-purple-50/60">
                            <td className="px-3 py-1.5 text-gray-700 text-[11px] max-w-[320px] break-all">{r.check_description ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.gl_code ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.branch ?? "—"}</td>
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{r.month ?? "—"}{r.year ? ` ${r.year}` : ""}</td>
                            <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtMov(r.movement)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Original all_loans display */
            <div className="overflow-auto max-h-72">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-blue-50">
                  <tr className="text-left text-blue-600/70 border-b border-blue-100">
                    <th className="px-3 py-2 font-medium">Loan Number</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium text-right">Movement</th>
                    <th className="px-3 py-2 font-medium">Month</th>
                    <th className="px-3 py-2 font-medium">Year</th>
                    <th className="px-3 py-2 font-medium">Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-blue-50 hover:bg-blue-50/60">
                      <td className="px-3 py-1.5 font-mono text-gray-700">
                        {r.loan_number ?? <span className="text-gray-400 italic">no loan#</span>}
                        {r.incomplete && (
                          <span className="ml-1 rounded bg-orange-100 px-1 py-0.5 text-[10px] font-medium text-orange-600">ambiguous</span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-1.5 text-gray-600" title={r.check_description ?? ""}>{r.check_description ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMov(r.movement)}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.month ?? "—"}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.year ?? "—"}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.branch ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main table ───────────────────────────────────────────────────────────────

function ValidationTable({
  rows,
  showLoanOfficer = false,
  showLoanAmount = false,
  showAccountingAmt = false,
  showTxColumns = false,
}: {
  rows: ValidationRow[];
  showLoanOfficer?: boolean;
  showLoanAmount?: boolean;
  showAccountingAmt?: boolean;
  showTxColumns?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-100 bg-white px-6 py-10 text-center text-sm text-gray-400">
        No loans found for this filter combination.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm max-h-[420px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-gray-50">
          <tr className="border-b border-gray-100 text-left text-gray-500">
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Loan Number</th>
            <th className="px-3 py-2 font-medium">Borrower Name</th>
            {showLoanOfficer && <th className="px-3 py-2 font-medium">Loan Officer</th>}
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Month</th>
            {showLoanAmount && <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Loan Amount</th>}
            {showAccountingAmt && <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Accounting Amt.</th>}
            {showTxColumns && <th className="px-3 py-2 font-medium whitespace-nowrap">Description <span className="font-normal text-gray-400">(Br. 700)</span></th>}
            {showTxColumns && <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Movement <span className="font-normal text-gray-400">(Br. 700)</span></th>}
            {showTxColumns && <th className="px-3 py-2 font-medium text-right whitespace-nowrap">BPS</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const missing = row.status === "missing";
            const exempt  = row.status === "exempt";
            return (
              <tr
                key={row.loan_number}
                className={`border-b border-gray-50 hover:brightness-95 ${missing ? "bg-amber-50/70" : ""}`}
              >
                <td className="px-3 py-1.5">
                  {/* Three states, and only one of them is a finding. An exempt
                      branch owes no fee, so its absence is the correct answer —
                      slate, not amber, and no warning triangle. */}
                  {missing ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                      <AlertTriangle size={9} /> Missing
                    </span>
                  ) : exempt ? (
                    <span title="This branch is exempt from the B2B success fee, so no fee is expected."
                          className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                      Branch exempt · not charged
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                      <CheckCircle size={9} /> Match
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.loan_number}</td>
                <td className="max-w-[160px] truncate px-3 py-1.5 text-gray-700" title={row.borrower_name ?? ""}>
                  {row.borrower_name ?? "—"}
                </td>
                {showLoanOfficer && (
                  <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.loan_officer ?? ""}>
                    {row.loan_officer ?? "—"}
                  </td>
                )}
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.branch ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.month ?? "—"}</td>
                {showLoanAmount && (
                  <td className="px-3 py-1.5 text-right font-mono text-gray-700 whitespace-nowrap">
                    {fmtUSD(row.loan_amount)}
                  </td>
                )}
                {showAccountingAmt && (
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {missing ? <span className="text-gray-300">—</span> : fmtMov(row.accounting_total)}
                  </td>
                )}
                {showTxColumns && (
                  <td className="max-w-[200px] truncate px-3 py-1.5 text-gray-600 text-[11px]" title={row.tx_description ?? ""}>
                    {row.tx_description ?? <span className="text-gray-300">—</span>}
                  </td>
                )}
                {showTxColumns && (
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {row.tx_movement != null ? fmtMov(row.tx_movement) : <span className="text-gray-300">—</span>}
                  </td>
                )}
                {showTxColumns && (
                  <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap">
                    {row.tx_movement != null && row.tx_movement !== 0 && row.loan_amount
                      ? `${((row.tx_movement / row.loan_amount) * 10000).toFixed(2)} bps`
                      : <span className="text-gray-300">—</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_OPTS = ["Matched", "Missing in Accounting", "Branch exempt", "Surplus in Accounting"] as const;

// ─── Single validation section (one sub-tab) ──────────────────────────────────

function ValidationSection({
  type, glLabel, months, years, branches, filterLoanNumber,
}: {
  type: ValType;
  glLabel: string;
  months: string[];
  years: string[];
  branches: string[];
  filterLoanNumber: string;
}) {
  const [data, setData] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ type });
      months.forEach((m) => p.append("month", m));
      years.forEach((y) => p.append("year", y));
      branches.forEach((b) => p.append("branch", b));
      const res = await fetch(`/api/loan-validation?${p}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [type, months, years, branches]);

  useEffect(() => { load(); }, [load]);

  const showLoanOfficer   = type === "b2b";
  const showLoanAmount    = type === "b2b";
  const showAccountingAmt = type !== "b2b";
  const showTxColumns     = type === "b2b";

  const visibleRows: ValidationRow[] = !data ? [] :
    data.rows.filter((r) => {
      const lnSearch = filterLoanNumber.trim().toLowerCase();
      if (lnSearch && !r.loan_number.toLowerCase().includes(lnSearch)) return false;
      if (statusFilter.length === 0) return true;
      return (statusFilter.includes("Matched") && r.status === "match") ||
             (statusFilter.includes("Missing in Accounting") && r.status === "missing") ||
             (statusFilter.includes("Branch exempt") && r.status === "exempt");
    });

  const showSurplus = !data ? false :
    data.surplus.length > 0 &&
    (statusFilter.length === 0 || statusFilter.includes("Surplus in Accounting"));

  function handleExport() {
    if (!data) return;
    const csvRows = visibleRows.map((r) => ({
      status: r.status,
      loan_number: r.loan_number,
      borrower_name: r.borrower_name ?? "",
      ...(showLoanOfficer   ? { loan_officer:      r.loan_officer ?? "" }      : {}),
      branch: r.branch ?? "",
      month: r.month ?? "",
      ...(showLoanAmount    ? { loan_amount:        r.loan_amount ?? "" }       : {}),
      ...(showAccountingAmt ? { accounting_total:   r.accounting_total }        : {}),
      ...(showTxColumns     ? { tx_description:     r.tx_description ?? "",
                                tx_movement:        r.tx_movement ?? "",
                                tx_bps:             (r.tx_movement != null && r.tx_movement !== 0 && r.loan_amount)
                                                      ? ((r.tx_movement / r.loan_amount) * 10000).toFixed(2)
                                                      : "" }                    : {}),
    }));
    const cols = [
      { key: "status",           label: "Status" },
      { key: "loan_number",      label: "Loan Number" },
      { key: "borrower_name",    label: "Borrower Name" },
      ...(showLoanOfficer    ? [{ key: "loan_officer",     label: "Loan Officer" }]              : []),
      { key: "branch",           label: "Branch" },
      { key: "month",            label: "Month" },
      ...(showLoanAmount     ? [{ key: "loan_amount",       label: "Loan Amount" }]              : []),
      ...(showAccountingAmt  ? [{ key: "accounting_total", label: "Accounting Amt." }]           : []),
      ...(showTxColumns      ? [{ key: "tx_description",   label: "Description (Branch 700)" },
                                { key: "tx_movement",      label: "Movement (Branch 700)" },
                                { key: "tx_bps",           label: "BPS (Branch 700)" }]         : []),
    ];
    exportToXlsx(`loan-validation-${type}-${todayISO()}.xlsx`, csvRows, cols);
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-gray-500">
          {type === "b2b" ? (
            <span>desc contains &ldquo;B2B SUCCESS FEE&rdquo;</span>
          ) : (
            <>
              GL {glLabel}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <ReportFilter
            label="Status"
            options={[...STATUS_OPTS]}
            selected={statusFilter}
            onChange={setStatusFilter}
          />
          {data && data.rows.length > 0 && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
            >
              <Download size={13} /> Export Excel
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">{error}</div>
      ) : data ? (
        <>
          <SummaryStrip
            summary={data.summary}
            shown={filterLoanNumber.trim() || statusFilter.length > 0
              ? {
                  match:   visibleRows.filter((r) => r.status === "match").length,
                  missing: visibleRows.filter((r) => r.status === "missing").length,
                  exempt:  visibleRows.filter((r) => r.status === "exempt").length,
                  surplus: showSurplus ? data.surplus.length : 0,
                }
              : null}
          />
          <ValidationTable
            rows={visibleRows}
            showLoanOfficer={showLoanOfficer}
            showLoanAmount={showLoanAmount}
            showAccountingAmt={showAccountingAmt}
            showTxColumns={showTxColumns}
          />
          {showSurplus && <SurplusSection rows={data.surplus} type={type} />}
        </>
      ) : null}
    </div>
  );
}

// ─── On Demand: diff badge ────────────────────────────────────────────────────

function DiffBadge({ diff }: { diff: number }) {
  if (diff === 0) return (
    <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
      <CheckCircle size={9} /> 0
    </span>
  );
  if (diff < 0) return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
      <AlertTriangle size={9} /> {diff}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">
      <AlertTriangle size={9} /> +{diff}
    </span>
  );
}

// ─── On Demand: pivot section (Branch vs LOA On Demand) ───────────────────────

// ─── All Loans: types & helpers ───────────────────────────────────────────────

type AllLoansView = "detail" | "analytics";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function sortMonthKey(a: string, b: string): number {
  const parse = (s: string) => {
    const parts = s.split(" ");
    const yr = parseInt(parts[parts.length - 1], 10) || 0;
    const ms = parts.slice(0, -1).join(" ");
    const mi = MONTH_ORDER.findIndex((m) => m.toLowerCase().startsWith(ms.slice(0, 3).toLowerCase()));
    return yr * 100 + (mi >= 0 ? mi : 99);
  };
  return parse(a) - parse(b);
}

function monthKey(r: ValidationRow): string {
  return r.month && r.year ? `${r.month} ${r.year}` : r.month ?? "";
}

interface AnalyticsLONode {
  lo: string;
  loans: ValidationRow[];
  byMonth: Record<string, number>;
  total: number;
}
interface AnalyticsBranchNode {
  branch: string;
  los: AnalyticsLONode[];
  byMonth: Record<string, number>;
  total: number;
}

function buildAnalyticsTree(rows: ValidationRow[]): AnalyticsBranchNode[] {
  const branchMap = new Map<string, Map<string, ValidationRow[]>>();
  for (const row of rows) {
    const b = row.branch ?? "(No Branch)";
    const lo = row.loan_officer ?? "(Unknown LO)";
    if (!branchMap.has(b)) branchMap.set(b, new Map());
    const lm = branchMap.get(b)!;
    if (!lm.has(lo)) lm.set(lo, []);
    lm.get(lo)!.push(row);
  }
  return [...branchMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([branch, lm]) => {
    const los: AnalyticsLONode[] = [...lm.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lo, loans]) => {
        const byMonth: Record<string, number> = {};
        let total = 0;
        for (const l of loans) {
          const k = monthKey(l);
          byMonth[k] = (byMonth[k] ?? 0) + 1;
          total += 1;
        }
        return { lo, loans, byMonth, total };
      });
    const byMonth: Record<string, number> = {};
    let total = 0;
    for (const n of los) {
      for (const [k, v] of Object.entries(n.byMonth)) byMonth[k] = (byMonth[k] ?? 0) + v;
      total += n.total;
    }
    return { branch, los, byMonth, total };
  });
}

// ─── All Loans: Analytics view ────────────────────────────────────────────────

function AnalyticsView({ rows }: { rows: ValidationRow[] }) {
  const months = useMemo(() => {
    const ms = new Set<string>();
    for (const r of rows) { const k = monthKey(r); if (k) ms.add(k); }
    return [...ms].sort(sortMonthKey);
  }, [rows]);

  const tree = useMemo(() => buildAnalyticsTree(rows), [rows]);

  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [expandedLOs, setExpandedLOs] = useState<Set<string>>(new Set());

  const grandByMonth: Record<string, number> = {};
  let grandTotal = 0;
  for (const bn of tree) {
    for (const [k, v] of Object.entries(bn.byMonth)) grandByMonth[k] = (grandByMonth[k] ?? 0) + v;
    grandTotal += bn.total;
  }

  const toggleBranch = (b: string) =>
    setExpandedBranches((p) => { const n = new Set(p); n.has(b) ? n.delete(b) : n.add(b); return n; });
  const toggleLO = (k: string) =>
    setExpandedLOs((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  if (rows.length === 0) return (
    <div className="rounded-xl border border-gray-100 bg-white px-6 py-10 text-center text-sm text-gray-400">
      No loans match the current filters.
    </div>
  );

  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm max-h-[520px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-gray-50">
          <tr className="border-b border-gray-100 text-gray-500">
            <th className="px-3 py-2 font-medium text-left min-w-[220px]">Branch / Loan Officer / Loan</th>
            {months.map((m) => (
              <th key={m} className="px-3 py-2 font-medium text-right whitespace-nowrap">{m}</th>
            ))}
            <th className="px-3 py-2 font-semibold text-right text-gray-700 whitespace-nowrap">Total</th>
          </tr>
        </thead>
        <tbody>
          {/* Grand Total */}
          <tr className="border-b border-blue-100 bg-blue-50/50 font-semibold">
            <td className="px-3 py-2 text-blue-800">Total</td>
            {months.map((m) => (
              <td key={m} className="px-3 py-2 text-right font-mono text-blue-700">
                {grandByMonth[m] ? grandByMonth[m].toLocaleString() : <span className="text-gray-300">—</span>}
              </td>
            ))}
            <td className="px-3 py-2 text-right font-mono text-blue-800">{grandTotal.toLocaleString()}</td>
          </tr>

          {tree.map((bn) => {
            const bExp = expandedBranches.has(bn.branch);
            return (
              <Fragment key={`branch-${bn.branch}`}>
                <tr
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer select-none"
                  onClick={() => toggleBranch(bn.branch)}
                >
                  <td className="px-3 py-2 font-medium text-gray-800">
                    <span className="mr-1.5 text-gray-400 text-[10px]">{bExp ? "▾" : "▸"}</span>
                    Branch {bn.branch}
                    <span className="ml-2 text-gray-400 font-normal text-[10px]">
                      ({bn.los.length} LO{bn.los.length !== 1 ? "s" : ""})
                    </span>
                  </td>
                  {months.map((m) => (
                    <td key={m} className="px-3 py-2 text-right font-mono text-gray-700">
                      {bn.byMonth[m] ? bn.byMonth[m].toLocaleString() : <span className="text-gray-200">—</span>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-gray-800">{bn.total.toLocaleString()}</td>
                </tr>

                {bExp && bn.los.map((ln) => {
                  const loKey = `${bn.branch}::${ln.lo}`;
                  const lExp = expandedLOs.has(loKey);
                  return (
                    <Fragment key={`lo-${loKey}`}>
                      <tr
                        className="border-b border-gray-50 bg-gray-50/40 hover:bg-gray-100/60 cursor-pointer select-none"
                        onClick={() => toggleLO(loKey)}
                      >
                        <td className="px-3 py-1.5 pl-8 text-gray-700">
                          <span className="mr-1.5 text-gray-400 text-[10px]">{lExp ? "▾" : "▸"}</span>
                          {ln.lo}
                          <span className="ml-2 text-gray-400 font-normal text-[10px]">({ln.loans.length})</span>
                        </td>
                        {months.map((m) => (
                          <td key={m} className="px-3 py-1.5 text-right font-mono text-gray-600">
                            {ln.byMonth[m] ? ln.byMonth[m].toLocaleString() : <span className="text-gray-200">—</span>}
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-right font-mono font-medium text-gray-700">{ln.total.toLocaleString()}</td>
                      </tr>

                      {lExp && ln.loans.map((loan) => {
                        const lk = monthKey(loan);
                        return (
                          <tr key={`loan-${loan.loan_number}-${lk}`} className="border-b border-gray-50 bg-white hover:bg-gray-50/50">
                            <td className="px-3 py-1 pl-14 text-gray-700">
                              <span className="font-mono text-gray-800">{loan.loan_number}</span>
                              {loan.borrower_name && (
                                <span className="ml-2 text-gray-500">{loan.borrower_name}</span>
                              )}
                            </td>
                            {months.map((m) => (
                              <td key={m} className="px-3 py-1 text-right font-mono">
                                {lk === m
                                  ? <span className="text-gray-600">1</span>
                                  : <span className="text-gray-200">—</span>}
                              </td>
                            ))}
                            <td className="px-3 py-1 text-right font-mono text-gray-700">
                              {loan.loan_amount != null ? fmtUSD(loan.loan_amount) : "—"}
                              {loan.bps != null && (
                                <span className="ml-2 text-gray-400 text-[10px]">{fmtBPS(loan.bps)}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── All Loans: Detail view ───────────────────────────────────────────────────

function DetailView({
  rows,
  colFilters,
  onColFilterChange,
}: {
  rows: ValidationRow[];
  colFilters: Record<string, string>;
  onColFilterChange: (col: string, val: string) => void;
}) {
  const visible = rows.filter((r) => {
    if (colFilters.borrower_name && !(r.borrower_name ?? "").toLowerCase().includes(colFilters.borrower_name.toLowerCase())) return false;
    if (colFilters.loan_officer && !(r.loan_officer ?? "").toLowerCase().includes(colFilters.loan_officer.toLowerCase())) return false;
    return true;
  });

  function filterHeader(colKey: string, label: string) {
    return (
      <th className="px-3 py-2 font-medium text-left">
        <div className="whitespace-nowrap">{label}</div>
        <input
          value={colFilters[colKey] ?? ""}
          onChange={(e) => onColFilterChange(colKey, e.target.value)}
          placeholder="Filter…"
          className="mt-0.5 w-full min-w-[80px] rounded border border-gray-200 px-1.5 py-0.5 text-[10px] font-normal placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-200"
          onClick={(e) => e.stopPropagation()}
        />
      </th>
    );
  }

  if (visible.length === 0) return (
    <div className="rounded-xl border border-gray-100 bg-white px-6 py-10 text-center text-sm text-gray-400">
      No loans found for this filter combination.
    </div>
  );

  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm max-h-[480px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-gray-50">
          <tr className="border-b border-gray-100 text-gray-500 align-top">
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Status</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Number</th>
            {filterHeader("borrower_name", "Borrower Name")}
            {filterHeader("loan_officer", "Loan Officer")}
            <th className="px-3 py-2 font-medium text-left">Branch</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Month / Year</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Loan Amount</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">DM Margin</th>
            <th className="px-3 py-2 font-medium text-right">BPS</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const missing = row.status === "missing";
            return (
              <tr
                key={`${row.loan_number}-${row.month}-${row.year}`}
                className={`border-b border-gray-50 hover:brightness-95 ${missing ? "bg-amber-50/70" : ""}`}
              >
                <td className="px-3 py-1.5">
                  {missing ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                      <AlertTriangle size={9} /> Missing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                      <CheckCircle size={9} /> Match
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.loan_number}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.borrower_name ?? ""}>{row.borrower_name ?? "—"}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.loan_officer ?? ""}>{row.loan_officer ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.branch ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">
                  {row.month ?? "—"}{row.year ? ` ${row.year}` : ""}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-700 whitespace-nowrap">{fmtUSD(row.loan_amount)}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  {missing ? <span className="text-gray-300">—</span> : fmtMov(row.accounting_total)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap">
                  {missing ? <span className="text-gray-300">—</span> : fmtBPS(row.bps)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── All Loans: metric card ───────────────────────────────────────────────────

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-800">{value}</div>
    </div>
  );
}

// ─── All Loans section ────────────────────────────────────────────────────────

function AllLoansSection({
  months,
  years,
  branches,
  filterLoanNumber,
}: {
  months: string[];
  years: string[];
  branches: string[];
  filterLoanNumber: string;
}) {
  const [view, setView] = useState<AllLoansView>("detail");
  const [data, setData] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterLO, setFilterLO] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [colFilters, setColFilters] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ type: "all_loans" });
      months.forEach((m) => p.append("month", m));
      years.forEach((y) => p.append("year", y));
      branches.forEach((b) => p.append("branch", b));
      const res = await fetch(`/api/loan-validation?${p}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [months, years, branches]);

  useEffect(() => { load(); }, [load]);

  const loOptions = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.loan_officer).filter((x): x is string => x != null))].sort(),
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const lnSearch = filterLoanNumber.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (lnSearch && !r.loan_number.toLowerCase().includes(lnSearch)) return false;
      if (filterLO.length > 0 && !filterLO.includes(r.loan_officer ?? "")) return false;
      if (filterStatus.length > 0) {
        const ok =
          (filterStatus.includes("Matched") && r.status === "match") ||
          (filterStatus.includes("Missing in Accounting") && r.status === "missing");
        if (!ok) return false;
      }
      return true;
    });
  }, [data, filterLoanNumber, filterLO, filterStatus]);

  const matchedRows = filteredRows.filter((r) => r.status === "match");
  const loanCount = filteredRows.length;
  const amtRows = filteredRows.filter((r) => r.loan_amount != null);
  const avgLoanAmount = amtRows.length > 0 ? amtRows.reduce((s, r) => s + r.loan_amount!, 0) / amtRows.length : null;
  const bpsRows = matchedRows.filter((r) => r.bps != null);
  const avgBPS = bpsRows.length > 0 ? bpsRows.reduce((s, r) => s + r.bps!, 0) / bpsRows.length : null;

  const showSurplus =
    !!data && data.surplus.length > 0 &&
    (filterStatus.length === 0 || filterStatus.includes("Surplus in Accounting"));

  function handleExport() {
    if (!data || filteredRows.length === 0) return;
    const today = todayISO();
    if (view === "analytics") {
      const tree = buildAnalyticsTree(filteredRows);
      const exportRows: Record<string, unknown>[] = [];
      for (const bn of tree) {
        for (const ln of bn.los) {
          for (const loan of ln.loans) {
            exportRows.push({
              branch:        bn.branch,
              loan_officer:  ln.lo,
              loan_number:   loan.loan_number,
              borrower_name: loan.borrower_name ?? "",
              month:         monthKey(loan),
              loan_amount:   loan.loan_amount ?? "",
              bps:           loan.bps ?? "",
              status:        loan.status === "missing" ? "Missing" : "Match",
            });
          }
        }
      }
      exportToXlsx(`loan-validation-all-loans-analytics-${today}.xlsx`, exportRows, [
        { key: "branch",        label: "Branch" },
        { key: "loan_officer",  label: "Loan Officer" },
        { key: "loan_number",   label: "Loan Number" },
        { key: "borrower_name", label: "Borrower Name" },
        { key: "month",         label: "Month" },
        { key: "loan_amount",   label: "Loan Amount" },
        { key: "bps",           label: "BPS" },
        { key: "status",        label: "Status" },
      ]);
    } else {
      const exportRows = filteredRows
        .filter((r) => {
          if (colFilters.borrower_name && !(r.borrower_name ?? "").toLowerCase().includes(colFilters.borrower_name.toLowerCase())) return false;
          if (colFilters.loan_officer && !(r.loan_officer ?? "").toLowerCase().includes(colFilters.loan_officer.toLowerCase())) return false;
          return true;
        })
        .map((r) => ({
          status:        r.status === "missing" ? "Missing" : r.status === "exempt" ? "Branch exempt" : "Match",
          loan_number:   r.loan_number,
          borrower_name: r.borrower_name ?? "",
          loan_officer:  r.loan_officer ?? "",
          branch:        r.branch ?? "",
          month_year:    `${r.month ?? ""}${r.year ? ` ${r.year}` : ""}`,
          loan_amount:   r.loan_amount ?? "",
          dm_margin:     r.accounting_total ?? "",
          bps:           r.bps ?? "",
        }));
      exportToXlsx(`loan-validation-all-loans-detail-${today}.xlsx`, exportRows, [
        { key: "status",        label: "Status" },
        { key: "loan_number",   label: "Loan Number" },
        { key: "borrower_name", label: "Borrower Name" },
        { key: "loan_officer",  label: "Loan Officer" },
        { key: "branch",        label: "Branch" },
        { key: "month_year",    label: "Month / Year" },
        { key: "loan_amount",   label: "Loan Amount" },
        { key: "dm_margin",     label: "DM Margin" },
        { key: "bps",           label: "BPS" },
      ]);
    }
  }

  return (
    <div className="space-y-4">
      {/* Sub-tab switcher */}
      <div className="flex gap-1 border-b border-gray-200">
        {(["detail", "analytics"] as AllLoansView[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={[
              "px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              view === v
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
            ].join(" ")}
          >
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500 font-medium">Filter:</span>
        {loOptions.length > 0 && (
          <ReportFilter label="Loan Officer" options={loOptions} selected={filterLO} onChange={setFilterLO} />
        )}
        <ReportFilter
          label="Status"
          options={["Matched", "Missing in Accounting", "Extra in Accounting"]}
          selected={filterStatus}
          onChange={setFilterStatus}
        />
        {(filterLO.length > 0 || filterStatus.length > 0) && (
          <button
            onClick={() => { setFilterLO([]); setFilterStatus([]); }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Clear
          </button>
        )}
        {data && filteredRows.length > 0 && (
          <button
            onClick={handleExport}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
          >
            <Download size={13} /> Export Excel
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">{error}</div>
      ) : data ? (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-3 gap-3">
            <MetricCard label="Loan Count" value={loanCount.toLocaleString()} />
            <MetricCard label="Avg Loan Amount" value={avgLoanAmount != null ? fmtUSD(avgLoanAmount) : "—"} />
            <MetricCard label="Avg BPS" value={avgBPS != null ? fmtBPS(avgBPS) : "—"} />
          </div>

          {view === "detail" ? (
            <DetailView
              rows={filteredRows}
              colFilters={colFilters}
              onColFilterChange={(col, val) => setColFilters((p) => ({ ...p, [col]: val }))}
            />
          ) : (
            <AnalyticsView rows={filteredRows} />
          )}

          {showSurplus && <SurplusSection rows={data.surplus} type="all_loans" />}
        </>
      ) : null}
    </div>
  );
}

// ─── Loan Validation Tab (root export) ───────────────────────────────────────

export function LoanValidationTab({
  allMonths,
  allYears,
  allBranches,
}: {
  allMonths: string[];
  allYears: number[];
  allBranches: string[];
}) {
  const { activeBranches } = useActiveBranches();
  const [activeType, setActiveType] = useState<ValType>("all_loans");
  const [selMonths, setSelMonths] = useState<string[]>([]);
  const [selYears, setSelYears] = useState<string[]>([]);
  const [selBranches, setSelBranches] = useState<string[]>([]);
  const [filterLoanNumber, setFilterLoanNumber] = useState("");

  const effectiveBranches = mergeWithGlobal(activeBranches, selBranches);

  const yearOptions = allYears.map(String);
  const hasFilters = selMonths.length > 0 || selYears.length > 0 || selBranches.length > 0 || filterLoanNumber !== "";

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500 font-medium">Filter:</span>
        <ReportFilter label="Month"  options={allMonths}   selected={selMonths}   onChange={setSelMonths} />
        <ReportFilter label="Year"   options={yearOptions} selected={selYears}    onChange={setSelYears} />
        <ReportFilter label="Branch" options={allBranches} selected={selBranches} onChange={setSelBranches} />
        <input
          type="text"
          value={filterLoanNumber}
          onChange={(e) => setFilterLoanNumber(e.target.value)}
          placeholder="Loan # search…"
          className="h-7 w-40 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        {selBranches.length > 0 && (
          // Which side it narrows, said next to it. The filter restricts the
          // accounting rows by the branch the TRANSACTION was booked in; the
          // master list is compared whole. Measured on 41309: 332 of its rows
          // sit in the corporate branch 700, so picking almost any other branch
          // leaves 0 accounting rows against all 379 loans and every one of
          // them reads as missing. Stated rather than silently changed —
          // scoping by the LOAN's branch instead is a change to what this tool
          // validates, and that is not a decision to make in passing.
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800">
            branch narrows the accounting side only — the master list is compared whole
          </span>
        )}
        {hasFilters && (
          <button
            onClick={() => { setSelMonths([]); setSelYears([]); setSelBranches([]); setFilterLoanNumber(""); }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {SUB_TABS.map((t) => (
          <button
            key={t.type}
            onClick={() => setActiveType(t.type)}
            className={[
              "px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              activeType === t.type
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active section */}
      {activeType === "all_loans" ? (
        <AllLoansSection
          months={selMonths}
          years={selYears}
          branches={effectiveBranches}
          filterLoanNumber={filterLoanNumber}
        />
      ) : (
        SUB_TABS.filter((t) => t.type === activeType).map((t) => (
          <ValidationSection
            key={t.type}
            type={t.type}
            glLabel={t.glLabel}
            months={selMonths}
            years={selYears}
            branches={effectiveBranches}
            filterLoanNumber={filterLoanNumber}
          />
        ))
      )}
    </div>
  );
}
