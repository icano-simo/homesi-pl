"use client";

import { useState, useCallback, useEffect, useMemo, Fragment } from "react";
import { ChevronDown, ChevronRight, Download, AlertTriangle, CheckCircle, TrendingUp, SlidersHorizontal, X } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import * as XLSX from "xlsx";
import { useActiveBranches } from "@/components/branch-filter-provider";
import type { ValidationResult, ValidationRow, SurplusRow } from "@/app/api/loan-validation/route";
import {
  activeChips,
  buildFacetOptions,
  clearOne,
  EMPTY_FILTERS,
  NO_VALUE,
  rowMatches,
  type LoanValidationFilters,
  type RangeFilter,
} from "@/lib/loan-validation-filters";

// ─── Sub-tab config ───────────────────────────────────────────────────────────

type ValType = "b2b" | "all_loans";

const SUB_TABS: { type: ValType; label: string; glLabel: string }[] = [
  // Las cuatro que otorgan margen, porque un prestamo casa con cualquiera de
  // ellas. La etiqueta y la comprobacion cambian siempre juntas: cuando decia
  // "DM Margin" y probaba DM, al menos coincidian.
  // DOS preguntas, y la etiqueta lo dice: un prestamo esta bien cuando cobraron
  // los dos. Cuando era una sola, 95 prestamos con uno y sin el otro pasaban
  // como correctos.
  { type: "all_loans",  label: "All Loans",
    glLabel: "division DM+RM (41309, 41307) · branch BM+Discount+LO+Brokered (41306, 41200, 41305, 41870)" },
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

/**
 * The channel a loan came in through, told apart at a glance.
 *
 * Banked and brokered are not two shades of the same thing: they earn through
 * different mechanisms, which is exactly why the All Loans list keeps only the
 * banked ones. Where both appear — B2B, 96 against 10 — the difference has to
 * be readable without reading, or the mixed list looks homogeneous.
 */
function ChannelChip({ c }: { c: string | null }) {
  if (!c?.trim()) return <span className="text-gray-300">—</span>;
  const brokered = c.trim() === "Brokered";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
      brokered ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-800"}`}>
      {c}
    </span>
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
            <th className="px-3 py-2 font-medium whitespace-nowrap">Loan Program</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Loan Info Channel</th>
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
                <td className="max-w-[150px] truncate px-3 py-1.5 text-gray-600" title={row.loan_program ?? undefined}>{row.loan_program ?? "—"}</td>
                <td className="px-3 py-1.5 whitespace-nowrap"><ChannelChip c={row.loan_info_channel} /></td>
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
  const [channelFilter, setChannelFilter] = useState<string[]>([]);

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

  /**
   * The channels actually present, from the rows themselves.
   *
   * Offered as a filter only when there is more than one, and that is the whole
   * point of reading it from the data: All Loans is narrowed to banked before it
   * reaches here, so a hardcoded pair of options would put a control on screen
   * that could only ever return everything or nothing. B2B carries both — 96
   * banked, 10 brokered — and there the control means something.
   */
  const channelOpts = !data ? [] :
    [...new Set(data.rows.map((r) => r.loan_info_channel).filter((c): c is string => !!c?.trim()))].sort();

  const visibleRows: ValidationRow[] = !data ? [] :
    data.rows.filter((r) => {
      const lnSearch = filterLoanNumber.trim().toLowerCase();
      if (lnSearch && !r.loan_number.toLowerCase().includes(lnSearch)) return false;
      if (channelFilter.length > 0 && !channelFilter.includes(r.loan_info_channel ?? "")) return false;
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
      // Both are columns on screen; the export was missing them, so a file
      // opened next to the table did not answer the same questions.
      loan_program: r.loan_program ?? "",
      loan_info_channel: r.loan_info_channel ?? "",
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
      { key: "loan_program",     label: "Loan Program" },
      { key: "loan_info_channel", label: "Loan Info Channel" },
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
          {channelOpts.length > 1 && (
            <ReportFilter
              label="Channel"
              options={channelOpts}
              selected={channelFilter}
              onChange={setChannelFilter}
            />
          )}
          {/* One channel and nothing to choose. Said instead of offered: a
              dropdown with a single option looks like a filter that is broken,
              and the reason this list has one is a decision, not an accident. */}
          {channelOpts.length === 1 && (
            <span title="This list is narrowed to banked loans: brokered loans do not earn margin the same way, so listing them as missing in accounting would report an absence that was never going to be there."
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500">
              {channelOpts[0]} only
            </span>
          )}
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


// ─── All Loans: Detail view ───────────────────────────────────────────────────

function DetailView({ rows }: { rows: ValidationRow[] }) {
  /**
   * ¿Viene lead_source del archivo o ya del espejo?
   *
   * Se lee de las propias filas, asi que el aviso se apaga solo el dia que el
   * endpoint cambie de origen. Una bandera en la pantalla habria que acordarse
   * de quitarla, y nadie se acuerda.
   */
  const fromFile = rows.some((r) => r.lead_source_origin === "loan_officials_file");

  // Ya vienen filtradas: el panel de arriba es el unico sitio donde se filtra.
  // Antes esta vista tenia DOS cajas propias en las cabeceras, asi que habia
  // dos mecanismos y los chips no sabian de aquellos.
  const visible = rows;

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
            {/* Identificacion primero, dinero despues, estado al final. El
                Status abria la tabla y era lo ultimo que se necesitaba para
                localizar una fila: primero se busca el prestamo, luego se mira
                que le paso. */}
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Year</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Month</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Number</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Borrower</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Officer</th>
            <th className="px-3 py-2 font-medium text-left">Branch</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Program</th>
            {/* El aviso sale del origen que trae la propia fila, no de una
                bandera: el dia que esta columna venga de Encompass, el asterisco
                desaparece solo. */}
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap"
                title={fromFile
                  ? "From the uploaded loan file, not from Encompass. 103 of 436 loans carry values Encompass does not use (Encompass Integration, B2B Strategy, Referral, External Referral, blank) — capture leftovers that will change when this column moves to the mirror."
                  : undefined}>
              Lead Source{fromFile && <span className="ml-0.5 text-amber-600">*</span>}
            </th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Channel</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Loan Amount</th>
            {/* TWO GROUPS, TWO COLUMNS, BOTH ALWAYS VISIBLE.
                No Division/Branch/Both switch on purpose: the job is to check
                in one pass that every branch was paid for its loans, and a
                switch would hide exactly the comparison you came to make.
                The per-account breakdown is not lost -- it lives in the title. */}
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-sky-50/70">
              Division margin
              <span className="block text-[10px] font-normal text-gray-400">DM + RM</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-sky-50/70">BPS</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-emerald-50/70">
              Branch margin
              <span className="block text-[10px] font-normal text-gray-400">BM + Discount + LO + Brokered</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-emerald-50/70">BPS</th>
            {/* Lo que cobra una PERSONA, no una cuenta contable. Separada de las
                dos de margen y en su propio tono por eso. */}
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-violet-50/70">
              LO commission
              <span className="block text-[10px] font-normal text-gray-400">Compensafe</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-violet-50/70">BPS</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Status</th>
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
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.year ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.month ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.loan_number}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.borrower_name ?? ""}>{row.borrower_name ?? "—"}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.loan_officer ?? ""}>{row.loan_officer ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.branch ?? "—"}</td>
                <td className="max-w-[150px] truncate px-3 py-1.5 text-gray-600" title={row.loan_program ?? undefined}>{row.loan_program ?? "—"}</td>
                <td className="max-w-[150px] truncate px-3 py-1.5 text-gray-600" title={row.lead_source ?? undefined}>{row.lead_source ?? "—"}</td>
                <td className="px-3 py-1.5 whitespace-nowrap"><ChannelChip c={row.loan_info_channel} /></td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-700 whitespace-nowrap">{fmtUSD(row.loan_amount)}</td>
                {/* Each group prints only where it has a booking. "No margin"
                    in amber rather than a dash: in a margin column a dash reads
                    as missing data, and this is an accounting fact. It is the
                    whole reason the two columns are separate -- 48 loans have
                    the left one and not the right, and 46 the other way. */}
                <td className={`px-3 py-1.5 text-right whitespace-nowrap bg-sky-50/40 ${row.division_received ? "" : "text-amber-700"}`}
                    title={row.division_received
                      ? `DM Margin ${row.dm_total ?? "—"} · RM Margin ${row.rm_total ?? "—"}`
                      : "No booking in DM Margin or RM Margin: the division was not paid for this loan."}>
                  {row.division_total == null ? "No margin" : fmtMov(row.division_total)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-sky-50/40">
                  {fmtBPS(row.bps)}
                </td>
                <td className={`px-3 py-1.5 text-right whitespace-nowrap bg-emerald-50/40 ${row.branch_received ? "" : "text-amber-700"}`}
                    title={row.branch_received
                      ? `BM Margin ${row.bm_total ?? "—"} · Discount Income ${row.discount_total ?? "—"} · LO Margin ${row.lo_margin_total ?? "—"} · Brokered Origination ${row.brokered_total ?? "—"}`
                      : "No booking in any branch margin account: the branch was not paid for this loan."}>
                  {row.branch_margin_total == null ? "No margin" : fmtMov(row.branch_margin_total)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-emerald-50/40">
                  {fmtBPS(row.branch_bps)}
                </td>
                {/* Null is not zero: no row in Compensafe means nobody knows
                    what was paid, and 0.00 would claim it was nothing. */}
                <td className="px-3 py-1.5 text-right whitespace-nowrap bg-violet-50/40">
                  {row.lo_commission == null
                    ? <span className="text-gray-300" title="No commission data for this loan">—</span>
                    : fmtMov(row.lo_commission)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-violet-50/40">
                  {fmtBPS(row.lo_commission_bps)}
                </td>
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

// ─── All Loans: filter controls ───────────────────────────────────────────────

type SetFilters = React.Dispatch<React.SetStateAction<LoanValidationFilters>>;

/** Un desplegable de faceta. Las opciones y los conteos llegan ya calculados. */
function Facet({ label, k, f, set, o, c, search }: {
  label: string;
  k: keyof LoanValidationFilters;
  f: LoanValidationFilters;
  set: SetFilters;
  o: Record<string, string[]>;
  c: Record<string, Record<string, number>>;
  search?: boolean;
}) {
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <ReportFilter
        label={label}
        options={o[k as string] ?? []}
        counts={c[k as string]}
        searchable={search}
        selected={f[k] as string[]}
        onChange={(v) => set((p) => ({ ...p, [k]: v }))}
      />
    </div>
  );
}

/** Caja de texto: para identificadores, donde un desplegable no ayuda. */
function TextFacet({ label, k, f, set }: {
  label: string; k: "loanNumber" | "borrower"; f: LoanValidationFilters; set: SetFilters;
}) {
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <input
        value={f[k]}
        onChange={(e) => set((p) => ({ ...p, [k]: e.target.value }))}
        placeholder="Contains…"
        className="h-7 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-xs placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
    </div>
  );
}

/**
 * Rango numerico, con "sin valor" como CASILLA APARTE y no como un valor del
 * rango.
 *
 * Un prestamo sin apunte y uno con un apunte de 0,00 son hallazgos distintos, y
 * un rango min=0 max=0 los mezclaria. Marcar la casilla desactiva el rango
 * porque preguntan cosas incompatibles: no se puede pedir "sin importe" y "entre
 * dos importes" a la vez.
 */
function RangeFacet({ label, k, f, set }: {
  label: string;
  k: "loanAmount" | "divisionMargin" | "branchMargin" | "loCommission";
  f: LoanValidationFilters;
  set: SetFilters;
}) {
  const r = f[k];
  const upd = (patch: Partial<RangeFilter>) => set((p) => ({ ...p, [k]: { ...p[k], ...patch } }));
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number" value={r.min} disabled={r.emptyOnly}
          onChange={(e) => upd({ min: e.target.value })}
          placeholder="min"
          className="h-7 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs placeholder-gray-300 disabled:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        <span className="text-gray-300">–</span>
        <input
          type="number" value={r.max} disabled={r.emptyOnly}
          onChange={(e) => upd({ max: e.target.value })}
          placeholder="max"
          className="h-7 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs placeholder-gray-300 disabled:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-600">
        <input
          type="checkbox" checked={r.emptyOnly}
          onChange={(e) => upd({ emptyOnly: e.target.checked, min: "", max: "" })}
          className="h-3 w-3 rounded border-gray-300 accent-blue-600"
        />
        No value
      </label>
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
  const [data, setData] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * Los catorce filtros en UN objeto, y el panel plegado por defecto.
   *
   * Antes eran tres sueltos en la barra -- Loan officer, Status y la caja de
   * numero -- y ya con tres no se veia cuales estaban puestos. Con catorce eso
   * deja de ser incomodo y pasa a ser una fuente de error: alguien lee un total
   * creyendo que es el total cuando lleva media tabla filtrada.
   *
   * Por eso los controles se pliegan y los ACTIVOS se quedan siempre fuera,
   * como chips. Se eligio esto frente al embudo por cabecera, que es mas
   * elegante y esconde justo el estado que importa.
   */
  const [filters, setFilters] = useState<LoanValidationFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  /**
   * Opciones y conteos del CONJUNTO COMPLETO, no de lo filtrado.
   *
   * Depende de `data` y de nada mas, asi que elegir una sucursal no vacia el
   * desplegable de programas: sin esto, filtrar por una cosa encierra al
   * usuario y le obliga a limpiar todo para volver. Misma decision que en
   * Metrics B2B.
   */
  const { options: facetOptions, counts: facetCounts } = useMemo(
    () => buildFacetOptions(data?.rows ?? []),
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    // La caja de numero de la barra de arriba sigue actuando, ademas de la del
    // panel: son dos caminos a lo mismo y el usuario puede usar cualquiera.
    const lnSearch = filterLoanNumber.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (lnSearch && !r.loan_number.toLowerCase().includes(lnSearch)) return false;
      return rowMatches(r, filters);
    });
  }, [data, filterLoanNumber, filters]);

  const chips = useMemo(() => activeChips(filters), [filters]);

  const matchedRows = filteredRows.filter((r) => r.status === "match");
  const loanCount = filteredRows.length;
  const amtRows = filteredRows.filter((r) => r.loan_amount != null);
  const avgLoanAmount = amtRows.length > 0 ? amtRows.reduce((s, r) => s + r.loan_amount!, 0) / amtRows.length : null;
  /**
   * Dos medias, no una. `bps` es el de DIVISION y `branch_bps` el de SUCURSAL,
   * y viven en escalas distintas -- mediana 65 contra 350 -- asi que una sola
   * tarjeta "Avg BPS" no podia decir cual estaba enseñando.
   */
  const bpsRows = matchedRows.filter((r) => r.bps != null);
  const avgBPS = bpsRows.length > 0 ? bpsRows.reduce((s, r) => s + r.bps!, 0) / bpsRows.length : null;
  const branchBpsRows = matchedRows.filter((r) => r.branch_bps != null);
  const avgBranchBPS = branchBpsRows.length > 0
    ? branchBpsRows.reduce((s, r) => s + r.branch_bps!, 0) / branchBpsRows.length
    : null;

  const showSurplus = !!data && data.surplus.length > 0 && filters.status.length === 0;

  function handleExport() {
    if (!data || filteredRows.length === 0) return;
    const today = todayISO();
    {
      // Sin un segundo filtrado: `filteredRows` ya es lo que se ve. El export
      // llevaba su propia copia de dos filtros y podia decir otra cosa que la
      // tabla de al lado.
      const exportRows = filteredRows
        .map((r) => ({
          // Mismo orden que la tabla: identificacion, dinero, estado.
          year:          r.year ?? "",
          month:         r.month ?? "",
          loan_number:   r.loan_number,
          borrower_name: r.borrower_name ?? "",
          loan_officer:  r.loan_officer ?? "",
          branch:        r.branch ?? "",
          loan_program:  r.loan_program ?? "",
          lead_source:   r.lead_source ?? "",
          channel:       r.loan_info_channel ?? "",
          loan_amount:   r.loan_amount ?? "",
          division_margin: r.division_total ?? "",
          division_bps:    r.bps ?? "",
          branch_margin:   r.branch_margin_total ?? "",
          branch_bps:      r.branch_bps ?? "",
          lo_commission:     r.lo_commission ?? "",
          lo_commission_bps: r.lo_commission_bps ?? "",
          dm_margin:       r.dm_total ?? "",
          rm_margin:       r.rm_total ?? "",
          bm_margin:       r.bm_total ?? "",
          discount_income: r.discount_total ?? "",
          lo_margin:       r.lo_margin_total ?? "",
          brokered_margin: r.brokered_total ?? "",
          status:        r.status === "missing" ? "Missing" : r.status === "exempt" ? "Branch exempt" : "Match",
        }));
      exportToXlsx(`loan-validation-all-loans-detail-${today}.xlsx`, exportRows, [
        { key: "year",          label: "Year" },
        { key: "month",         label: "Month" },
        { key: "loan_number",   label: "Loan Number" },
        { key: "borrower_name", label: "Borrower" },
        { key: "loan_officer",  label: "Loan Officer" },
        { key: "branch",        label: "Branch" },
        { key: "loan_program",  label: "Loan Program" },
        { key: "lead_source",   label: "Lead Source" },
        { key: "channel",       label: "Channel" },
        { key: "loan_amount",   label: "Loan Amount" },
        // Los tres grupos primero, que son lo que se viene a mirar; el desglose
        // por cuenta despues, para quien quiera reconstruir las sumas.
        { key: "division_margin",   label: "Division margin (DM+RM)" },
        { key: "division_bps",      label: "Division BPS" },
        { key: "branch_margin",     label: "Branch margin (BM+Discount+LO+Brokered)" },
        { key: "branch_bps",        label: "Branch BPS" },
        { key: "lo_commission",     label: "LO commission (Compensafe)" },
        { key: "lo_commission_bps", label: "LO commission BPS" },
        { key: "dm_margin",         label: "DM Margin (41309)" },
        { key: "rm_margin",         label: "RM Margin (41307)" },
        { key: "bm_margin",         label: "BM Margin (41306)" },
        { key: "discount_income",   label: "Discount Income (41200)" },
        { key: "lo_margin",         label: "LO Margin (41305)" },
        { key: "brokered_margin",   label: "Brokered Origination (41870)" },
        { key: "status",            label: "Status" },
      ]);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Filters: collapsed controls, permanent chips ──────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              chips.length > 0
                ? "border-sky-200 bg-sky-50 text-sky-900"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            <SlidersHorizontal size={13} />
            Filters{chips.length > 0 ? ` (${chips.length})` : ""}
            <ChevronDown size={13} className={`transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
          </button>

          {/* Los filtros ACTIVOS viven fuera del panel, siempre visibles.
              Plegar los controles esta bien; plegar el estado no. Un total
              leido sin saber que hay tres filtros puestos es el error que esto
              existe para evitar. */}
          {chips.map((c) => (
            <span key={c.key}
                  className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-900">
              {c.label}
              <button onClick={() => setFilters((f) => clearOne(f, c.key))}
                      aria-label={`Remove ${c.label}`}
                      className="ml-0.5 text-sky-400 hover:text-red-500">
                <X size={11} />
              </button>
            </span>
          ))}
          {chips.length > 0 && (
            <button onClick={() => setFilters(EMPTY_FILTERS)}
                    className="text-xs text-gray-400 underline hover:text-gray-600">
              Clear all
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

        {filtersOpen && (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 lg:grid-cols-4">
              <Facet label="Year"         k="year"         f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Month"        k="month"        f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Branch"       k="branch"       f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Loan officer" k="loanOfficer"  f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Loan program" k="loanProgram"  f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Lead source"  k="leadSource"   f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Channel"      k="channel"      f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Status"       k="status"       f={filters} set={setFilters} o={facetOptions} c={facetCounts} />

              <TextFacet label="Loan number" k="loanNumber" f={filters} set={setFilters} />
              <TextFacet label="Borrower"    k="borrower"   f={filters} set={setFilters} />

              <RangeFacet label="Loan amount"     k="loanAmount"     f={filters} set={setFilters} />
              <RangeFacet label="Division margin" k="divisionMargin" f={filters} set={setFilters} />
              <RangeFacet label="Branch margin"   k="branchMargin"   f={filters} set={setFilters} />
              <RangeFacet label="LO commission"   k="loCommission"   f={filters} set={setFilters} />
            </div>
            <p className="mt-3 text-[11px] text-gray-500">
              Dropdown options and counts come from every loaded loan, not from what is already
              filtered — so narrowing one column never empties another.{" "}
              <span className="font-medium text-gray-600">{NO_VALUE}</span> isolates the loans where
              the field is empty; for amounts, <span className="font-medium text-gray-600">no value</span>{" "}
              is a separate checkbox from a 0 — a loan with no booking and one booked at 0.00 are
              different findings.
            </p>
          </div>
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
          {/* Cuatro y no tres: "Avg BPS" a secas dejo de significar algo al
              separar los dos margenes. Uno ronda los 65 -- es un baremo -- y el
              otro los 350. Una sola tarjeta tendria que elegir cual esconde. */}
          <div className="grid grid-cols-4 gap-3">
            <MetricCard label="Loan Count" value={loanCount.toLocaleString()} />
            <MetricCard label="Avg Loan Amount" value={avgLoanAmount != null ? fmtUSD(avgLoanAmount) : "—"} />
            <MetricCard label="Avg division BPS" value={avgBPS != null ? fmtBPS(avgBPS) : "—"} />
            <MetricCard label="Avg branch BPS" value={avgBranchBPS != null ? fmtBPS(avgBranchBPS) : "—"} />
          </div>

          <DetailView rows={filteredRows} />

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
  /**
   * El año EN CURSO viene marcado, calculado de la fecha de hoy.
   *
   * No del ultimo año con datos, ni de una constante: las dos se vuelven
   * mentira sin que nadie las toque. Una constante caduca el 1 de enero -- es
   * el mismo fallo que el "diciembre" fijo de /start --, y "el ultimo con
   * datos" deja la pantalla mirando al año pasado justo en enero, que es cuando
   * mas importa ver que el nuevo empezo vacio.
   *
   * ⚠ SE SELECCIONA AUNQUE NO TENGA DATOS, y la pantalla lo dice. Caer en
   * silencio a otro año enseñaria cifras correctas de un periodo que nadie
   * pidio, que es peor que una pantalla vacia con su motivo.
   *
   * Se calcula en cada carga y no una vez: una pestaña abierta en Nochevieja
   * sigue en 2026 al dia siguiente.
   */
  const [selYears, setSelYears] = useState<string[]>([String(new Date().getFullYear())]);
  const [selBranches, setSelBranches] = useState<string[]>([]);
  const [filterLoanNumber, setFilterLoanNumber] = useState("");

  /**
   * The Branch filter of this tab, and only this tab.
   *
   * It used to be mergeWithGlobal(activeBranches, selBranches), which returns
   * the GLOBAL list whenever the local one is empty — so with every dropdown
   * here clear, a global branch filter was still reaching the endpoint. That was
   * harmless while `branch` narrowed the accounting side; it stopped being
   * harmless the moment it started narrowing the master list, because the
   * global filter names ACCOUNTING branches and loan_officials has none of them
   * in common with the usual choice: its branches are 150 276 701 702 703 707
   * 710 716 718 724 728 733 741 747 760 770 771 776 and Affinity — there is no
   * 700. Filtering the master by 700 returns nothing, which is exactly the
   * empty screen this produced.
   *
   * So the global accounting filter no longer feeds this screen at all. It has
   * nothing to act on here either: the transactions are matched by loan number
   * regardless of where they are booked.
   */
  const loanBranches = selBranches;
  const globalBranchIgnored = activeBranches.length > 0;

  /**
   * El año en curso SIEMPRE esta entre las opciones, tenga datos o no.
   *
   * `allYears` sale de lo que hay cargado, asi que el 1 de enero el año nuevo
   * no aparece: sin esto, el filtro vendria marcado con un año que el
   * desplegable no ofrece, y el usuario no podria ni volver a el tras
   * cambiarlo. El orden descendente pone el actual arriba, que es donde se
   * busca.
   */
  const currentYear = String(new Date().getFullYear());
  const yearOptions = useMemo(
    () => [...new Set([currentYear, ...allYears.map(String)])].sort((a, b) => Number(b) - Number(a)),
    [allYears, currentYear],
  );
  /** Un año elegido del que no hay ni una fila cargada. Se dice, no se corrige. */
  const yearsWithoutData = selYears.filter((y) => !allYears.map(String).includes(y));
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
        {globalBranchIgnored && (
          <span
            title="This screen filters by the branch that produced the loan; the global filter names accounting branches."
            className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] text-slate-600"
          >
            global branch filter ({activeBranches.join(", ")}) does not apply here
          </span>
        )}
        {/* El año elegido no tiene ni una fila. Se dice aqui, junto al filtro
            que lo causa, en vez de dejar una tabla vacia sin explicacion. */}
        {yearsWithoutData.length > 0 && (
          <span
            title="No loans have been loaded for this year yet. The filter is still set to it on purpose: silently falling back to another year would show correct figures for a period nobody asked for."
            className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-medium text-amber-800"
          >
            No data loaded for {yearsWithoutData.join(", ")}
          </span>
        )}
        {hasFilters && (
          <button
            // Clear devuelve el año en curso, no lo vacia: "sin año" no es un
            // estado que esta pantalla quiera ofrecer, y vaciarlo cargaria
            // todos los periodos de golpe.
            onClick={() => { setSelMonths([]); setSelYears([currentYear]); setSelBranches([]); setFilterLoanNumber(""); }}
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
          branches={loanBranches}
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
            branches={loanBranches}
            filterLoanNumber={filterLoanNumber}
          />
        ))
      )}
    </div>
  );
}
