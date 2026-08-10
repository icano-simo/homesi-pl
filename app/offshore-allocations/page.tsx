"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, AlertTriangle, Percent, Search, X, RotateCcw, ShieldCheck, Wand2, Trash2, Plus, DollarSign, MessageSquare } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { ReportFilter } from "@/components/report-filter";
import { SplitEditor } from "@/components/split-editor";
import { buildSplitsMap } from "@/lib/apply-splits";
import { useActiveBranches } from "@/components/branch-filter-provider";
import { SplitDisplay } from "@/components/split-display";
import { NotesLog } from "@/components/notes-log";
import type { SplitEntry } from "@/lib/apply-splits";
import type { CostCenter, EmployeeFeeConfig } from "@/types";
import type { OABlock, OAGroupRow } from "@/app/api/offshore-allocations/route";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function rowVisible(
  row: OAGroupRow,
  filterYears: string[],
  filterMonths: string[],
  filterBranches: string[],
  filterCategories: string[],
  filterPositions: string[],
  filterVendors: string[],
  search: string,
): boolean {
  if (filterYears.length > 0 && !filterYears.some((y) => row.years.includes(Number(y)))) return false;
  if (filterMonths.length > 0 && !filterMonths.some((m) => row.months.includes(m))) return false;
  if (filterBranches.length > 0 && !filterBranches.some((b) => row.branches.includes(b))) return false;
  if (filterCategories.length > 0 && !filterCategories.includes(row.category ?? "")) return false;
  if (filterPositions.length > 0 && !filterPositions.includes(row.position ?? "")) return false;
  if (filterVendors.length > 0 && !filterVendors.includes(row.vendor ?? "")) return false;
  if (search) {
    const q = search.toLowerCase();
    const match = [
      row.check_description_3,
      row.category,
      row.position,
      row.vendor,
      row.branch_allocation,
      ...row.branches,
      ...(row.raw_cd2s ?? []),
    ].some((v) => v?.toLowerCase().includes(q));
    if (!match) return false;
  }
  return true;
}

function BranchCell({ branches }: { branches: string[] }) {
  if (branches.length === 0) return <span className="text-gray-300">—</span>;
  if (branches.length === 1) return <span>{branches[0]}</span>;
  return <span title={branches.join(", ")}>{branches[0]} +{branches.length - 1}</span>;
}

function normGroupKey(assignType: string | null, groupKey: string): string {
  return assignType === "vendor" ? groupKey.trim().replace(/\s+/g, " ") : groupKey;
}

function rowMatchesCcFilter(
  row: OAGroupRow,
  filterCCs: string[],
  splitsMap: Map<string, SplitEntry[]>,
): boolean {
  if (filterCCs.length === 0) return true;
  const splits = row.assign_type && row.group_key
    ? splitsMap.get(`${row.assign_type}:${normGroupKey(row.assign_type, row.group_key)}`)
    : undefined;
  const hasSplits = splits && splits.length > 0;
  for (const cc of filterCCs) {
    if (cc === "Unassigned") {
      if (!hasSplits && row.cc_labels.length === 0) return true;
    } else {
      if (row.cc_labels.includes(cc)) return true;
      if (hasSplits && splits!.some((s) => s.cost_centers?.name === cc)) return true;
    }
  }
  return false;
}

function CCCell({ row, splitsMap }: { row: OAGroupRow; splitsMap: Map<string, SplitEntry[]> }) {
  const splits = row.assign_type && row.group_key
    ? splitsMap.get(`${row.assign_type}:${normGroupKey(row.assign_type, row.group_key)}`)
    : undefined;

  const hasSplits = splits && splits.length > 0;
  const hasLabels = row.cc_labels.length > 0;

  return (
    <>
      {hasSplits ? (
        <SplitDisplay splits={splits} />
      ) : hasLabels ? (
        <span className="inline-flex flex-wrap gap-1">
          {row.cc_labels.map((name) => (
            <span key={name} className="rounded bg-green-50 px-1.5 py-0.5 font-medium text-green-700">
              {name}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-gray-300 text-[11px]">Unassigned</span>
      )}
      {row.tx_count_unassigned > 0 && (hasSplits || hasLabels) && (
        <span className="ml-1 text-gray-400 text-[10px]">
          ({row.tx_count_unassigned} unassigned)
        </span>
      )}
    </>
  );
}

// ─── Bulk split dialog ────────────────────────────────────────────────────────

interface BulkSplitRow { cost_center_id: string; percentage: string; is_operational: boolean; }

function BulkSplitDialog({
  selectedRows, costCenters, onClose, onSaved,
}: {
  selectedRows: OAGroupRow[];
  costCenters: CostCenter[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep]         = useState<"edit" | "confirm">("edit");
  const [splitRows, setSplitRows] = useState<BulkSplitRow[]>([
    { cost_center_id: "", percentage: "100", is_operational: true },
  ]);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const assignable = selectedRows.filter((r) => r.assign_type !== null);
  const skipped    = selectedRows.length - assignable.length;

  const parsed = splitRows.map((r) => ({ ...r, pct: parseFloat(r.percentage) || 0 }));
  const sum    = parsed.reduce((s, r) => s + r.pct, 0);
  const sumOk  = Math.abs(sum - 100) < 0.01;
  const ccIds  = splitRows.map((r) => r.cost_center_id).filter(Boolean);
  const hasDups = ccIds.length !== new Set(ccIds).size;
  const canProceed = sumOk && splitRows.every((r) => r.cost_center_id) && !hasDups && assignable.length > 0;

  function setField(idx: number, field: keyof BulkSplitRow, value: string | boolean) {
    setSplitRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }

  async function handleConfirm() {
    setSaving(true); setErrMsg("");
    try {
      const targets = assignable.map((r) => ({
        assign_type:  r.assign_type!,
        assign_value: r.group_key,
      }));
      const res = await fetch("/api/cc-allocation-splits/bulk", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          targets,
          splits: parsed.map((r) => ({
            cost_center_id: r.cost_center_id,
            percentage:     r.pct,
            is_operational: r.is_operational,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) { setErrMsg(json.error ?? "Failed"); setStep("edit"); return; }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const sumLabel =
    sum === 0  ? "Enter percentages — must total 100%"
    : sumOk    ? "✓ Total: 100%"
    : sum > 100 ? `Exceeds 100% by ${(sum - 100).toFixed(3)}%`
    :             `${(100 - sum).toFixed(3)}% remaining`;
  const sumColor  = sum === 0 ? "text-gray-400" : sumOk ? "text-green-700" : sum > 100 ? "text-red-600" : "text-gray-600";
  const sumBorder = sumOk ? "border-green-200 bg-green-50" : sum > 100 ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Bulk Cost Center Allocation</h3>
            <p className="mt-0.5 text-sm text-gray-600">
              {assignable.length} row{assignable.length !== 1 ? "s" : ""} will be updated
              {skipped > 0 && (
                <span className="ml-1 text-gray-400">({skipped} skipped — no assignment key)</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-600 mt-0.5">
            <X size={18} />
          </button>
        </div>

        {step === "edit" ? (
          <>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-[1fr_6rem_5rem_1.5rem] gap-2 px-0.5">
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Cost Center</span>
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide text-right">%</span>
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide text-center">Type</span>
                <span />
              </div>

              <div className="space-y-2">
                {splitRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_6rem_5rem_1.5rem] gap-2 items-center">
                    <select
                      value={row.cost_center_id}
                      onChange={(e) => setField(idx, "cost_center_id", e.target.value)}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none w-full"
                    >
                      <option value="">Select…</option>
                      {costCenters.map((cc) => (
                        <option key={cc.id} value={cc.id}>{cc.name}</option>
                      ))}
                    </select>
                    <div className="relative">
                      <input
                        type="number" min="0.001" max="100" step="0.001"
                        value={row.percentage}
                        onChange={(e) => setField(idx, "percentage", e.target.value)}
                        placeholder="0"
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pr-6 text-sm text-right text-gray-700 focus:border-blue-400 focus:outline-none"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setField(idx, "is_operational", !row.is_operational)}
                      className={`text-[10px] rounded px-1.5 py-1 font-medium border transition-colors ${
                        row.is_operational
                          ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                          : "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                      }`}
                    >
                      {row.is_operational ? "Op" : "Non-Op"}
                    </button>
                    <button
                      onClick={() => setSplitRows((prev) => prev.filter((_, i) => i !== idx))}
                      disabled={splitRows.length <= 1}
                      className="text-gray-300 hover:text-red-500 disabled:opacity-0 disabled:pointer-events-none"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={() => setSplitRows((prev) => [...prev, { cost_center_id: "", percentage: "", is_operational: true }])}
                className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                <Plus size={13} /> Add cost center
              </button>

              <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${sumBorder}`}>
                <span className={`text-xs font-medium ${sumColor}`}>{sumLabel}</span>
                {splitRows.length === 1 && !sumOk && (
                  <button
                    onClick={() => setField(0, "percentage", "100")}
                    className="text-xs text-blue-500 hover:text-blue-700 underline shrink-0 ml-2"
                  >
                    Set 100%
                  </button>
                )}
              </div>

              {hasDups && <p className="text-xs text-red-600">Each cost center can only appear once.</p>}
              {errMsg && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{errMsg}</p>}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
              <p className="text-[11px] text-gray-400">Existing allocations will be overwritten</p>
              <div className="flex gap-2">
                <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canProceed}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Review &amp; Apply →
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4">
              <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
                <p className="text-sm font-semibold text-amber-900">
                  Apply this allocation to {assignable.length} row{assignable.length !== 1 ? "s" : ""}?
                </p>
                <p className="mt-0.5 text-xs text-amber-700">
                  Any existing allocation for these rows will be overwritten.
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Allocation to apply</p>
                {parsed.map((s, i) => {
                  const cc = costCenters.find((c) => c.id === s.cost_center_id);
                  return (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-gray-700">{cc?.name ?? s.cost_center_id}</span>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] rounded px-1.5 py-0.5 font-medium border ${
                          s.is_operational
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-red-200 bg-red-50 text-red-600"
                        }`}>
                          {s.is_operational ? "Op" : "Non-Op"}
                        </span>
                        <span className="font-mono font-medium text-gray-900 w-14 text-right">{s.pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1">
                <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                  Rows ({assignable.length})
                </p>
                <div className="max-h-40 overflow-auto space-y-0.5 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                  {assignable.map((r) => (
                    <div key={r.group_key} className="flex items-center gap-2 text-xs text-gray-600">
                      <span className="shrink-0 text-gray-300">·</span>
                      <span className="truncate">{r.check_description_3 ?? r.group_key}</span>
                      <span className="shrink-0 text-gray-400">({r.tx_count} tx)</span>
                    </div>
                  ))}
                </div>
              </div>

              {errMsg && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{errMsg}</p>}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
              <button
                onClick={() => setStep("edit")}
                disabled={saving}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                ← Back
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  disabled={saving}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving && (
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  )}
                  {saving
                    ? "Applying…"
                    : `Apply to ${assignable.length} row${assignable.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Bulk fee dialog ──────────────────────────────────────────────────────────

function BulkFeeDialog({
  employees,
  onClose,
  onApply,
}: {
  employees: string[];
  onClose: () => void;
  onApply: (not_recoverable: boolean, fee_amount: number | null) => void;
}) {
  const [notRecoverable, setNotRecoverable] = useState(true);
  const [feeInput, setFeeInput] = useState("");

  const parsedFee   = parseFloat(feeInput);
  const feeAmount   = isNaN(parsedFee) || parsedFee <= 0 ? null : parsedFee;
  const canApply    = !notRecoverable || feeAmount !== null;
  const fmtFee      = feeAmount
    ? `$${feeAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  const n           = employees.length;

  const summaryText = notRecoverable && fmtFee
    ? `This will mark ${n} employee${n !== 1 ? "s" : ""} as Not Recoverable with a fee of ${fmtFee} each. Employee fee lines will be generated for all existing historical months. Continue?`
    : notRecoverable && !fmtFee
    ? `Enter a valid fee amount to proceed (${n} employee${n !== 1 ? "s" : ""} selected).`
    : `This will remove the Not Recoverable flag from ${n} employee${n !== 1 ? "s" : ""}. No new fee lines will be generated.`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="text-base font-semibold text-gray-900">Bulk — Not Recoverable</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Not Recoverable toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={notRecoverable}
              onChange={(e) => setNotRecoverable(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
            />
            <span className="text-sm font-medium text-gray-800">Mark as Not Recoverable to Branches</span>
          </label>

          {/* Fee amount */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Fee Amount (same for all selected employees)
            </label>
            <div className="relative flex items-center">
              <span className="absolute left-3 text-sm text-gray-400 pointer-events-none">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                disabled={!notRecoverable}
                value={feeInput}
                onChange={(e) => setFeeInput(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full rounded-lg border border-gray-200 pl-7 pr-3 py-2 text-sm font-mono text-right text-gray-700
                           disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed
                           focus:border-orange-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Live summary / confirmation text */}
          <div className={[
            "rounded-lg border px-4 py-3 text-xs",
            notRecoverable && fmtFee
              ? "border-orange-200 bg-orange-50 text-orange-800"
              : notRecoverable
              ? "border-gray-200 bg-gray-50 text-gray-500"
              : "border-red-100 bg-red-50 text-red-700",
          ].join(" ")}>
            {summaryText}
          </div>

          {/* Employee list preview */}
          <div className="max-h-32 overflow-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-600 space-y-0.5">
            {employees.map((emp) => (
              <div key={emp} className="truncate">{emp}</div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            disabled={!canApply}
            onClick={() => { if (canApply) onApply(notRecoverable, feeAmount); }}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Apply to {n} employee{n !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fee cells (Not Recoverable checkbox + Fee Amount input) ─────────────────
// Only rendered inside Roster Offshore rows when global branch filter = "700".

function FeeCells({
  employee,
  config,
  saving,
  onFeeChange,
}: {
  employee: string;
  config: EmployeeFeeConfig | undefined;
  saving: boolean;
  onFeeChange: (employee: string, not_recoverable: boolean, fee_amount: number | null) => void;
}) {
  const [feeInput, setFeeInput] = useState(config?.fee_amount?.toString() ?? "");
  const prevAmountRef = useRef(config?.fee_amount);

  // Sync input when a save completes and changes fee_amount
  useEffect(() => {
    if (prevAmountRef.current !== config?.fee_amount) {
      prevAmountRef.current = config?.fee_amount;
      setFeeInput(config?.fee_amount?.toString() ?? "");
    }
  }, [config?.fee_amount]);

  const notRecoverable = config?.not_recoverable ?? false;

  return (
    <>
      <td className="px-3 py-2 whitespace-nowrap">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={notRecoverable}
            onChange={(e) =>
              onFeeChange(employee, e.target.checked, config?.fee_amount ?? null)
            }
            className="h-3.5 w-3.5 rounded border-gray-300 text-orange-600 focus:ring-orange-500 cursor-pointer"
          />
          {saving && (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-orange-500" />
          )}
          {notRecoverable && !saving && (
            <span className="rounded bg-orange-100 px-1 py-0.5 text-[9px] font-semibold text-orange-700">
              ON
            </span>
          )}
        </label>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="relative flex items-center">
          <span className="absolute left-2 text-[10px] text-gray-400 pointer-events-none">$</span>
          <input
            type="number"
            step="0.01"
            min="0"
            disabled={!notRecoverable}
            value={feeInput}
            onChange={(e) => setFeeInput(e.target.value)}
            onBlur={() => {
              const parsed = parseFloat(feeInput);
              const amount = isNaN(parsed) || parsed <= 0 ? null : parsed;
              if (amount !== (config?.fee_amount ?? null)) {
                onFeeChange(employee, notRecoverable, amount);
              }
            }}
            placeholder="0.00"
            className="w-24 rounded border border-gray-200 pl-5 pr-2 py-1 text-xs text-right font-mono text-gray-700
                       disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed
                       focus:border-orange-400 focus:outline-none"
          />
        </div>
      </td>
    </>
  );
}

// ─── Block table ──────────────────────────────────────────────────────────────

interface BlockTableProps {
  block: OABlock;
  costCenters: CostCenter[];
  filterYears: string[];
  filterMonths: string[];
  filterBranches: string[];
  filterCategories: string[];
  filterPositions: string[];
  filterVendors: string[];
  filterCCs: string[];
  search: string;
  splitsMap: Map<string, SplitEntry[]>;
  selected: Set<string>;
  onToggle: (keys: string[], checked: boolean) => void;
  unassigning: string | null;
  unassignBusy: boolean;
  onEditAllocation: (row: OAGroupRow) => void;
  onOpenNotes: (row: OAGroupRow) => void;
  onUnassign: (row: OAGroupRow) => void;
  onUnassignConfirm: (row: OAGroupRow) => void;
  onUnassignCancel: () => void;
  // Employee Fee columns — only rendered for Roster blocks when global branch = "700"
  showFeeColumns: boolean;
  feeConfigs: Map<string, EmployeeFeeConfig>;
  feeSaving: Set<string>;
  onFeeChange: (employee: string, not_recoverable: boolean, fee_amount: number | null) => void;
}

function BlockTable({
  block, costCenters, filterYears, filterMonths, filterBranches,
  filterCategories, filterPositions, filterVendors, filterCCs, search,
  splitsMap, selected, onToggle,
  unassigning, unassignBusy, onEditAllocation, onOpenNotes, onUnassign, onUnassignConfirm, onUnassignCancel,
  showFeeColumns, feeConfigs, feeSaving, onFeeChange,
}: BlockTableProps) {
  const visibleRows = useMemo(
    () => block.rows.filter(
      (r) =>
        rowVisible(r, filterYears, filterMonths, filterBranches, filterCategories, filterPositions, filterVendors, search) &&
        rowMatchesCcFilter(r, filterCCs, splitsMap),
    ),
    [block.rows, filterYears, filterMonths, filterBranches, filterCategories, filterPositions, filterVendors, filterCCs, search, splitsMap],
  );

  if (visibleRows.length === 0) return null;

  const blockAllSelected  = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.group_key));
  const blockSomeSelected = visibleRows.some((r) => selected.has(r.group_key));

  const isRoster = block.block_type === "roster";
  const isOther  = block.block_type === "other";

  const headerBg   = isOther ? "bg-gray-50"  : "bg-blue-50";
  const headerText = isOther ? "text-gray-700" : "text-blue-800";

  // Suppress unused costCenters lint (passed down for future use)
  void costCenters;

  return (
    <div className={[
      "rounded-xl border bg-white shadow-sm overflow-hidden",
      "border-gray-200",
    ].join(" ")}>
      <div className={`px-4 py-2.5 border-b border-gray-200 flex items-center justify-between ${headerBg}`}>
        <span className={`text-sm font-semibold flex items-center gap-2 ${headerText}`}>
          {isOther && <AlertTriangle size={14} className="text-gray-400" />}
          {block.block_key}
        </span>
        <span className="text-xs text-gray-400">{visibleRows.length} rows</span>
      </div>

      {isOther && (
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-[11px] text-gray-600">
          These transactions have an unexpected or missing Check Description 2 value. Review the source file for formatting errors.
        </div>
      )}

      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="px-2 py-2 w-8">
                <input
                  type="checkbox"
                  checked={blockAllSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = blockSomeSelected && !blockAllSelected;
                  }}
                  onChange={(e) => onToggle(visibleRows.map((r) => r.group_key), e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  title="Select all visible in this block"
                />
              </th>
              {isOther && <th className="px-3 py-2 font-medium whitespace-nowrap">Check Desc 2 (raw)</th>}
              <th className="px-3 py-2 font-medium whitespace-nowrap">Description 3</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Branch</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Category</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Position</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Vendor</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Branch Allocation</th>
              {showFeeColumns && (
                <>
                  <th className="px-3 py-2 font-medium whitespace-nowrap text-orange-700">
                    Not Recoverable
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap text-orange-700">
                    <span className="flex items-center gap-1"><DollarSign size={10} />Fee Amount</span>
                  </th>
                </>
              )}
              <th className="px-3 py-2 font-medium whitespace-nowrap">Cost Center</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap min-w-[140px]">Allocation</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const canAssign = row.assign_type !== null;
              const isSelected = selected.has(row.group_key);
              return (
                <tr
                  key={row.group_key}
                  className={`border-b border-gray-50 hover:bg-gray-50 align-middle ${isSelected ? "bg-blue-50/40" : ""}`}
                >
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => onToggle([row.group_key], e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                  </td>
                  {isOther && (
                    <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap max-w-[180px] truncate"
                        title={row.raw_cd2s?.join(", ")}>
                      {row.raw_cd2s && row.raw_cd2s.length > 0
                        ? row.raw_cd2s.length === 1
                          ? row.raw_cd2s[0]
                          : `${row.raw_cd2s[0]} +${row.raw_cd2s.length - 1}`
                        : <span className="text-gray-300">(empty)</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap max-w-[180px] truncate">
                    {row.check_description_3 ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    <BranchCell branches={row.branches} />
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {row.category ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap max-w-[140px] truncate">
                    {row.position ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap max-w-[140px] truncate">
                    {row.vendor ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {row.branch_allocation ?? <span className="text-gray-300">—</span>}
                  </td>
                  {showFeeColumns && (
                    row.check_description_3
                      ? <FeeCells
                          employee={row.check_description_3}
                          config={feeConfigs.get(row.check_description_3)}
                          saving={feeSaving.has(row.check_description_3)}
                          onFeeChange={onFeeChange}
                        />
                      : <><td /><td /></>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <CCCell row={row} splitsMap={splitsMap} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {canAssign ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => onEditAllocation(row)}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 whitespace-nowrap"
                        >
                          <Percent size={10} />
                          Edit allocation
                          <span className="text-gray-400 font-normal">({row.tx_count} tx)</span>
                        </button>
                        {/* Change history for this employee or vendor — the
                            "why" behind an allocation that was edited. */}
                        <button
                          onClick={() => onOpenNotes(row)}
                          title="Notes for this employee/vendor"
                          className="flex items-center rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-500 hover:border-blue-300 hover:text-blue-700"
                        >
                          <MessageSquare size={11} />
                        </button>
                        {/* Unassign — only when a split is already defined */}
                        {splitsMap.get(`${row.assign_type}:${normGroupKey(row.assign_type, row.group_key)}`) && (
                          unassigning === row.group_key ? (
                            <span className="flex items-center gap-1 text-[11px]">
                              <span className="text-red-600 font-medium">Remove?</span>
                              <button
                                onClick={() => onUnassignConfirm(row)}
                                disabled={unassignBusy}
                                className="rounded px-1.5 py-0.5 bg-red-600 text-white text-[10px] hover:bg-red-700 disabled:opacity-40"
                              >
                                Yes
                              </button>
                              <button
                                onClick={onUnassignCancel}
                                className="rounded px-1.5 py-0.5 border border-gray-200 text-gray-500 text-[10px] hover:bg-gray-50"
                              >
                                No
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => onUnassign(row)}
                              title="Remove this allocation"
                              className="rounded-lg border border-gray-100 px-2 py-1 text-[11px] text-red-400 hover:border-red-200 hover:text-red-600 whitespace-nowrap"
                            >
                              Unassign
                            </button>
                          )
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300 text-[11px]" title="No vendor or description key to assign by">
                        — ({row.tx_count} tx)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OffshoreAllocationsPage() {
  const { activeBranches } = useActiveBranches();
  const [blocks, setBlocks]           = useState<OABlock[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [allSplits, setAllSplits]     = useState<SplitEntry[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");

  // Employee fee config state — only shown when global branch filter = "700"
  const [feeConfigs, setFeeConfigs] = useState<Map<string, EmployeeFeeConfig>>(new Map());
  const [feeSaving, setFeeSaving]   = useState<Set<string>>(new Set());
  const [feeGenBanner, setFeeGenBanner] = useState<{ employees: number; months: number; transactions: number } | null>(null);
  const [resyncBusy,   setResyncBusy]   = useState(false);
  const [resyncBanner, setResyncBanner] = useState<{ synced: number; skipped: number; total: number } | null>(null);

  // Fee columns visible only when exactly branch "700" is the global filter
  const showFeeColumns = activeBranches.length === 1 && activeBranches[0] === "700";

  const [filterYears, setFilterYears]           = useState<string[]>([]);
  const [filterMonths, setFilterMonths]         = useState<string[]>([]);
  const [filterBranches, setFilterBranches]     = useState<string[]>([]);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterPositions, setFilterPositions]   = useState<string[]>([]);
  const [filterVendors, setFilterVendors]       = useState<string[]>([]);
  const [filterCCs, setFilterCCs]               = useState<string[]>([]);
  const [search, setSearch]                     = useState("");

  const [editingRow, setEditingRow]       = useState<OAGroupRow | null>(null);
  const [notesRow,   setNotesRow]         = useState<OAGroupRow | null>(null);
  const [unassigning, setUnassigning]     = useState<string | null>(null); // group_key being confirmed
  const [unassignBusy, setUnassignBusy]   = useState(false);
  const [selected, setSelected]           = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing]     = useState(false);
  const [bulkFeeEditing, setBulkFeeEditing] = useState(false);

  // Re-evaluate with Rules state
  const [reevalCount,   setReevalCount]   = useState<number | null>(null);
  const [reevalDialog,  setReevalDialog]  = useState(false);
  const [reevalRunning, setReevalRunning] = useState(false);
  const [reevalResult,  setReevalResult]  = useState<{
    processed: number; assigned: number; conflicts: number; unassigned: number;
  } | null>(null);

  // Apply Existing Assignments state
  const [applyCount,   setApplyCount]   = useState<number | null>(null);
  const [applyDialog,  setApplyDialog]  = useState(false);
  const [applyRunning, setApplyRunning] = useState(false);
  const [applyResult,  setApplyResult]  = useState<{
    assigned: number; breakdown: { key: string; count: number }[];
  } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams();
      activeBranches.forEach(b => p.append("branch", b));
      const [blocksRes, ccRes, splitsRes] = await Promise.all([
        fetch(`/api/offshore-allocations${activeBranches.length > 0 ? `?${p}` : ""}`),
        fetch("/api/cost-centers"),
        fetch("/api/cc-allocation-splits"),
      ]);
      if (!blocksRes.ok) {
        const j = await blocksRes.json();
        setError(j.error ?? "Failed to load offshore allocations");
        return;
      }
      const [b, cc, splits] = await Promise.all([
        blocksRes.json(), ccRes.json(), splitsRes.json(),
      ]) as [OABlock[], CostCenter[], SplitEntry[]];
      setBlocks(b);
      setCostCenters(cc);
      setAllSplits(splits);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeBranches]);

  const loadReevalCount = useCallback(async () => {
    const res = await fetch("/api/offshore-allocations/reevaluate-manual");
    if (res.ok) { const j = await res.json(); setReevalCount(j.count ?? 0); }
  }, []);

  const loadApplyCount = useCallback(async () => {
    const res = await fetch("/api/offshore-allocations/apply-existing");
    if (res.ok) { const j = await res.json(); setApplyCount(j.count ?? 0); }
  }, []);

  const loadFeeConfigs = useCallback(async () => {
    const res = await fetch("/api/employee-fee-config");
    if (!res.ok) return;
    const data: EmployeeFeeConfig[] = await res.json();
    const m = new Map<string, EmployeeFeeConfig>();
    for (const cfg of data) m.set(cfg.check_description_3, cfg);
    setFeeConfigs(m);
  }, []);

  const handleResyncCostSplits = useCallback(async () => {
    setResyncBusy(true);
    setResyncBanner(null);
    try {
      const res = await fetch("/api/employee-fee-config/resync-cost-splits", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { synced: number; skipped: number; total: number };
      setResyncBanner(data);
      if (data.synced > 0) fetchData();
    } catch (e) {
      console.error("resync-cost-splits", e);
    } finally {
      setResyncBusy(false);
    }
  }, [fetchData]);

  const handleFeeChange = useCallback(async (
    employee: string,
    not_recoverable: boolean,
    fee_amount: number | null,
  ) => {
    // Optimistic update
    setFeeConfigs((prev) => {
      const next = new Map(prev);
      const ex = next.get(employee);
      next.set(employee, {
        id:                  ex?.id ?? "",
        check_description_3: employee,
        not_recoverable,
        fee_amount,
        created_at:  ex?.created_at ?? "",
        updated_at:  new Date().toISOString(),
      });
      return next;
    });
    setFeeSaving((prev) => { const n = new Set(prev); n.add(employee); return n; });
    try {
      const res = await fetch("/api/employee-fee-config", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ check_description_3: employee, not_recoverable, fee_amount }),
      });
      if (!res.ok) return;
      const saved: EmployeeFeeConfig = await res.json();
      setFeeConfigs((prev) => { const n = new Map(prev); n.set(employee, saved); return n; });

      // Trigger initial generation of historical months when activating not_recoverable + fee
      if (not_recoverable && fee_amount && fee_amount > 0) {
        const genRes = await fetch("/api/employee-fee-config/generate", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ employeeName: employee }),
        });
        if (genRes.ok) {
          const result = await genRes.json() as { employees_processed: number; new_months: number; transactions_inserted: number };
          if (result.transactions_inserted > 0) {
            setFeeGenBanner({
              employees:    result.employees_processed,
              months:       result.new_months,
              transactions: result.transactions_inserted,
            });
          }
        }
      }
    } finally {
      setFeeSaving((prev) => { const n = new Set(prev); n.delete(employee); return n; });
    }
  }, []);

  // Employees in Roster blocks that are currently selected (for bulk fee action)
  const rosterEmployeesSelected = useMemo(() => {
    const rosterRows = blocks
      .filter((b) => b.block_type === "roster")
      .flatMap((b) => b.rows);
    return rosterRows
      .filter((r) => selected.has(r.group_key) && r.check_description_3)
      .map((r) => r.check_description_3 as string);
  }, [blocks, selected]);

  // Bulk fee: save N employees in parallel, then one generate call
  const handleBulkFeeApply = useCallback(async (
    employees: string[],
    not_recoverable: boolean,
    fee_amount: number | null,
  ) => {
    setBulkFeeEditing(false);

    // Optimistic update + mark saving
    setFeeSaving((prev) => { const n = new Set(prev); employees.forEach((e) => n.add(e)); return n; });
    setFeeConfigs((prev) => {
      const next = new Map(prev);
      for (const emp of employees) {
        const ex = next.get(emp);
        next.set(emp, {
          id:                  ex?.id ?? "",
          check_description_3: emp,
          not_recoverable,
          fee_amount,
          created_at:  ex?.created_at ?? "",
          updated_at:  new Date().toISOString(),
        });
      }
      return next;
    });

    try {
      // Save all configs in parallel
      const saveResults = await Promise.all(
        employees.map((emp) =>
          fetch("/api/employee-fee-config", {
            method:  "PATCH",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ check_description_3: emp, not_recoverable, fee_amount }),
          }).then((r) => r.ok ? r.json() as Promise<EmployeeFeeConfig> : null),
        ),
      );

      // Update local state with confirmed saved values
      setFeeConfigs((prev) => {
        const next = new Map(prev);
        for (const saved of saveResults) {
          if (saved) next.set(saved.check_description_3, saved);
        }
        return next;
      });

      // One generate call processes all not_recoverable employees at once
      if (not_recoverable && fee_amount && fee_amount > 0) {
        const genRes = await fetch("/api/employee-fee-config/generate", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({}), // no employeeName → process all
        });
        if (genRes.ok) {
          const result = await genRes.json() as { employees_processed: number; new_months: number; transactions_inserted: number };
          if (result.transactions_inserted > 0) {
            setFeeGenBanner({
              employees:    result.employees_processed,
              months:       result.new_months,
              transactions: result.transactions_inserted,
            });
          }
        }
      }
    } finally {
      setFeeSaving((prev) => { const n = new Set(prev); employees.forEach((e) => n.delete(e)); return n; });
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { loadReevalCount(); }, [loadReevalCount]);
  useEffect(() => { loadApplyCount(); }, [loadApplyCount]);
  useEffect(() => { loadFeeConfigs(); }, [loadFeeConfigs]);

  async function handleApplyExisting() {
    setApplyRunning(true);
    setApplyResult(null);
    try {
      const res = await fetch("/api/offshore-allocations/apply-existing", { method: "POST" });
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Apply failed"); return; }
      const result = await res.json();
      setApplyResult(result);
      setApplyDialog(false);
      await Promise.all([fetchData(), loadApplyCount()]);
    } finally {
      setApplyRunning(false);
    }
  }

  async function handleReeval() {
    setReevalRunning(true);
    setReevalResult(null);
    try {
      const res = await fetch("/api/offshore-allocations/reevaluate-manual", { method: "POST" });
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Re-evaluation failed"); return; }
      const result = await res.json();
      setReevalResult(result);
      setReevalDialog(false);
      await Promise.all([fetchData(), loadReevalCount()]);
    } finally {
      setReevalRunning(false);
    }
  }

  const allYears = useMemo(() => {
    const s = new Set<number>();
    blocks.forEach((b) => b.rows.forEach((r) => r.years.forEach((y) => s.add(y))));
    return [...s].sort((a, b) => a - b).map(String);
  }, [blocks]);

  const allMonths = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => r.months.forEach((m) => s.add(m))));
    return MONTH_ORDER.filter((m) => s.has(m));
  }, [blocks]);

  const allBranches = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => r.branches.forEach((br) => s.add(br))));
    return [...s].sort();
  }, [blocks]);

  const allCategories = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => { if (r.category) s.add(r.category); }));
    return [...s].sort();
  }, [blocks]);

  const allPositions = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => { if (r.position) s.add(r.position); }));
    return [...s].sort();
  }, [blocks]);

  const allVendors = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => { if (r.vendor) s.add(r.vendor); }));
    return [...s].sort();
  }, [blocks]);

  const totalTx = useMemo(
    () => blocks.reduce((sum, b) => sum + b.rows.reduce((s, r) => s + r.tx_count, 0), 0),
    [blocks],
  );

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const allCostCenters = useMemo(() => {
    const s = new Set<string>();
    blocks.forEach((b) => b.rows.forEach((r) => r.cc_labels.forEach((name) => s.add(name))));
    for (const entries of splitsMap.values()) {
      for (const e of entries) {
        if (e.cost_centers?.name) s.add(e.cost_centers.name);
      }
    }
    return ["Unassigned", ...[...s].sort()];
  }, [blocks, splitsMap]);

  // All group_keys currently visible across all blocks (respects every active filter)
  const allVisibleKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const block of blocks) {
      for (const row of block.rows) {
        if (
          rowVisible(row, filterYears, filterMonths, filterBranches, filterCategories, filterPositions, filterVendors, search) &&
          rowMatchesCcFilter(row, filterCCs, splitsMap)
        ) {
          keys.add(row.group_key);
        }
      }
    }
    return keys;
  }, [blocks, filterYears, filterMonths, filterBranches, filterCategories, filterPositions, filterVendors, filterCCs, search, splitsMap]);

  // OAGroupRow objects for currently selected keys (for bulk dialog)
  const selectedRows = useMemo(() => {
    const rowMap = new Map<string, OAGroupRow>();
    for (const block of blocks) {
      for (const row of block.rows) rowMap.set(row.group_key, row);
    }
    return [...selected].map((k) => rowMap.get(k)).filter((r): r is OAGroupRow => r !== undefined);
  }, [blocks, selected]);

  const globalAllSelected  = allVisibleKeys.size > 0 && [...allVisibleKeys].every((k) => selected.has(k));
  const globalSomeSelected = [...allVisibleKeys].some((k) => selected.has(k));
  const selectAllRef       = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = globalSomeSelected && !globalAllSelected;
    }
  }, [globalSomeSelected, globalAllSelected]);

  const handleToggle = useCallback((keys: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) checked ? next.add(k) : next.delete(k);
      return next;
    });
  }, []);

  function handleSelectAll() {
    if (globalAllSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        allVisibleKeys.forEach((k) => next.delete(k));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        allVisibleKeys.forEach((k) => next.add(k));
        return next;
      });
    }
  }

  const hasFilters = filterYears.length > 0 || filterMonths.length > 0 || filterBranches.length > 0
    || filterCategories.length > 0 || filterPositions.length > 0 || filterVendors.length > 0
    || filterCCs.length > 0 || search.length > 0;

  function handleExport() {
    const visibleRows = blocks.flatMap((block) =>
      block.rows
        .filter((r) =>
          rowVisible(r, filterYears, filterMonths, filterBranches, filterCategories, filterPositions, filterVendors, search) &&
          rowMatchesCcFilter(r, filterCCs, splitsMap)
        )
        .map((r) => ({
          block:               block.block_key,
          check_description_3: r.check_description_3 ?? "",
          branches:            r.branches.join(", "),
          years:               r.years.join(", "),
          months:              r.months.join(", "),
          category:            r.category ?? "",
          position:            r.position ?? "",
          vendor:              r.vendor ?? "",
          branch_allocation:   r.branch_allocation ?? "",
          cc_labels:           r.cc_labels.join(", "),
          tx_count:            r.tx_count,
          tx_count_unassigned: r.tx_count_unassigned,
        }))
    );
    downloadCSV("offshore_allocations.csv", visibleRows, [
      { key: "block",               label: "Block" },
      { key: "check_description_3", label: "Description 3" },
      { key: "branches",            label: "Branches" },
      { key: "years",               label: "Years" },
      { key: "months",              label: "Months" },
      { key: "category",            label: "Category" },
      { key: "position",            label: "Position" },
      { key: "vendor",              label: "Vendor" },
      { key: "branch_allocation",   label: "Branch Allocation" },
      { key: "cc_labels",           label: "Cost Centers" },
      { key: "tx_count",            label: "Total Tx" },
      { key: "tx_count_unassigned", label: "Unassigned Tx" },
    ]);
  }

  return (
    <div className="flex flex-col gap-5 h-[calc(100vh-32px)]">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Offshore Allocations</h2>
          <p className="text-sm text-gray-500">
            {loading ? "Loading…" : `${totalTx.toLocaleString()} transactions`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!loading && blocks.length > 0 && (
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
            title={applyCount === 0 ? "No unassigned OA transactions matching existing assignments" : undefined}
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
          {showFeeColumns && (
            <button
              onClick={handleResyncCostSplits}
              disabled={resyncBusy}
              title="Backfill split assignments for existing unassigned Employee Fee Cost lines (GL 90002)"
              className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-700 hover:bg-orange-100 disabled:opacity-40 disabled:cursor-default"
            >
              <RefreshCw size={14} className={resyncBusy ? "animate-spin" : ""} />
              Resync Cost Splits
            </button>
          )}
          <button
            onClick={() => { setReevalResult(null); setReevalDialog(true); }}
            disabled={loading || reevalCount === 0}
            title={reevalCount === 0 ? "No manually assigned OA transactions to re-evaluate" : undefined}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-default"
          >
            <RotateCcw size={14} />
            Re-evaluate with Rules
            {reevalCount !== null && reevalCount > 0 && (
              <span className="ml-0.5 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700">
                {reevalCount}
              </span>
            )}
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <ReportFilter label="Year"         options={allYears}        selected={filterYears}      onChange={setFilterYears} />
          <ReportFilter label="Month"        options={allMonths}       selected={filterMonths}     onChange={setFilterMonths} />
          <ReportFilter label="Branch"       options={allBranches}     selected={filterBranches}   onChange={setFilterBranches} />
          <ReportFilter label="Category"     options={allCategories}   selected={filterCategories} onChange={setFilterCategories} />
          <ReportFilter label="Position"     options={allPositions}    selected={filterPositions}  onChange={setFilterPositions} />
          <ReportFilter label="Vendor"       options={allVendors}      selected={filterVendors}    onChange={setFilterVendors} />
          <ReportFilter label="Cost Center"  options={allCostCenters}  selected={filterCCs}        onChange={setFilterCCs} />
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search description, vendor, position…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white pl-7 pr-7 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none min-w-[260px]"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={12} />
              </button>
            )}
          </div>
          {hasFilters && (
            <button
              onClick={() => { setFilterYears([]); setFilterMonths([]); setFilterBranches([]); setFilterCategories([]); setFilterPositions([]); setFilterVendors([]); setFilterCCs([]); setSearch(""); }}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              Clear all
            </button>
          )}
        </div>
        {hasFilters && (
          <span className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-0.5 border border-gray-200 w-fit">
            Filters affect display only — allocations apply globally to all historical data
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 shrink-0">
          {error}
        </p>
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

      {reevalResult && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="shrink-0 text-gray-600" />
            <span className="text-sm text-gray-800">
              Re-evaluated <strong>{reevalResult.processed}</strong> transaction{reevalResult.processed !== 1 ? "s" : ""} —{" "}
              <strong>{reevalResult.assigned}</strong> assigned by rule,{" "}
              <strong>{reevalResult.conflicts}</strong> conflict{reevalResult.conflicts !== 1 ? "s" : ""},{" "}
              <strong>{reevalResult.unassigned}</strong> unassigned.
            </span>
          </div>
          <button onClick={() => setReevalResult(null)} className="ml-3 text-gray-400 hover:text-gray-600">
            <X size={14} />
          </button>
        </div>
      )}

      {feeGenBanner && (
        <div className="flex items-center justify-between rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <DollarSign size={15} className="shrink-0 text-orange-600" />
            <span className="text-sm text-orange-800">
              Employee fee lines generated:{" "}
              <strong>{feeGenBanner.employees}</strong> employee{feeGenBanner.employees !== 1 ? "s" : ""} ×{" "}
              <strong>{feeGenBanner.months}</strong> month{feeGenBanner.months !== 1 ? "s" : ""} ={" "}
              <strong>{feeGenBanner.transactions}</strong> transactions
            </span>
          </div>
          <button onClick={() => setFeeGenBanner(null)} className="ml-3 text-orange-400 hover:text-orange-600">
            <X size={14} />
          </button>
        </div>
      )}

      {resyncBanner && (
        <div className="flex items-center justify-between rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <RefreshCw size={15} className="shrink-0 text-orange-600" />
            <span className="text-sm text-orange-800">
              Cost split resync:{" "}
              <strong>{resyncBanner.synced}</strong> line{resyncBanner.synced !== 1 ? "s" : ""} assigned
              {resyncBanner.skipped > 0 && (
                <>, <strong>{resyncBanner.skipped}</strong> left unassigned (no split configured for those employees)</>
              )}
              {resyncBanner.total > 0 && resyncBanner.synced === resyncBanner.total && (
                <> — all {resyncBanner.total} resolved</>
              )}
              {resyncBanner.total === 0 && <> — nothing to resync</>}
            </span>
          </div>
          <button onClick={() => setResyncBanner(null)} className="ml-3 text-orange-400 hover:text-orange-600">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Selection / bulk action bar */}
      {!loading && blocks.length > 0 && (
        <div className="flex items-center gap-3 shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={globalAllSelected}
              onChange={handleSelectAll}
              className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-600 select-none">
              {allVisibleKeys.size} visible row{allVisibleKeys.size !== 1 ? "s" : ""}
            </span>
          </label>
          {selected.size > 0 && (
            <>
              <span className="h-3 w-px bg-gray-300" />
              <span className="text-xs font-semibold text-blue-700">
                {selected.size} selected
              </span>
              <button
                onClick={() => setBulkEditing(true)}
                className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
              >
                <Percent size={11} /> Assign Cost Centers
              </button>
              {showFeeColumns && rosterEmployeesSelected.length > 0 && (
                <button
                  onClick={() => setBulkFeeEditing(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                >
                  <DollarSign size={11} />
                  Set Not Recoverable
                  <span className="rounded-full bg-orange-200 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800">
                    {rosterEmployeesSelected.length}
                  </span>
                </button>
              )}
              <button
                onClick={() => setSelected(new Set())}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Blocks */}
      <div className="flex-1 min-h-0 overflow-auto space-y-5 pb-4">
        {loading ? (
          <div className="py-12 text-center text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
            <p className="mt-2 text-xs">Loading…</p>
          </div>
        ) : blocks.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-400">
            No offshore allocation transactions found. Upload an Offshore Allocations file to get started.
          </p>
        ) : (
          blocks.map((block) => (
            <BlockTable
              key={block.block_key}
              block={block}
              costCenters={costCenters}
              filterYears={filterYears}
              filterMonths={filterMonths}
              filterBranches={filterBranches}
              filterCategories={filterCategories}
              filterPositions={filterPositions}
              filterVendors={filterVendors}
              filterCCs={filterCCs}
              search={search}
              splitsMap={splitsMap}
              selected={selected}
              onToggle={handleToggle}
              unassigning={unassigning}
              unassignBusy={unassignBusy}
              onEditAllocation={setEditingRow}
              onOpenNotes={setNotesRow}
              onUnassign={(row) => setUnassigning(row.group_key)}
              onUnassignConfirm={async (row) => {
                if (!row.assign_type) return;
                setUnassignBusy(true);
                await fetch(
                  `/api/cc-allocation-splits?type=${encodeURIComponent(row.assign_type)}&value=${encodeURIComponent(row.group_key)}`,
                  { method: "DELETE" }
                );
                setUnassignBusy(false);
                setUnassigning(null);
                fetchData();
              }}
              onUnassignCancel={() => setUnassigning(null)}
              showFeeColumns={showFeeColumns && block.block_type === "roster"}
              feeConfigs={feeConfigs}
              feeSaving={feeSaving}
              onFeeChange={handleFeeChange}
            />
          ))
        )}
      </div>

      {/* Re-evaluate with Rules confirmation dialog */}
      {reevalDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
              <RotateCcw size={18} className="mt-0.5 shrink-0 text-gray-600" />
              <div>
                <h3 className="text-base font-semibold text-gray-900">Re-evaluate with Rules</h3>
                <p className="mt-1 text-sm text-gray-600">
                  This will re-evaluate{" "}
                  <span className="font-semibold text-gray-900">{reevalCount}</span>{" "}
                  manually assigned Offshore Allocations transaction{reevalCount !== 1 ? "s" : ""} against
                  all current rules. Their current manual assignments may be overwritten.
                </p>
                <p className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  The global Re-apply All Rules continues to skip manual OA assignments — this is the
                  only place where they can be re-evaluated.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <button
                onClick={() => setReevalDialog(false)}
                disabled={reevalRunning}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleReeval}
                disabled={reevalRunning}
                className="flex items-center gap-2 rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {reevalRunning && (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                )}
                {reevalRunning
                  ? "Re-evaluating…"
                  : `Re-evaluate ${reevalCount} transaction${reevalCount !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}

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
                  unassigned Offshore Allocations transaction{applyCount !== 1 ? "s" : ""} matching
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
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
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
      {editingRow && editingRow.assign_type && (
        <SplitEditor
          assignType={editingRow.assign_type}
          assignValue={editingRow.group_key}
          displayName={editingRow.check_description_3 ?? editingRow.group_key}
          txCount={editingRow.tx_count}
          costCenters={costCenters}
          onClose={() => setEditingRow(null)}
          onSaved={() => {
            setEditingRow(null);
            fetchData();
          }}
        />
      )}

      {/* Per-employee / per-vendor note log. Anchored by the same
          (assign_type, assign_value) pair cc_allocation_splits uses, so a note
          stays attached to the entity whose allocation it explains. */}
      {notesRow && notesRow.assign_type && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={() => setNotesRow(null)} aria-hidden />
          <aside
            role="dialog"
            aria-label="Entity notes"
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {notesRow.assign_type === "vendor" ? "Vendor notes" : "Employee notes"}
                </p>
                <p className="mt-0.5 truncate text-sm font-bold text-[#001A40]">
                  {notesRow.check_description_3 ?? notesRow.group_key}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">{notesRow.tx_count} transactions</p>
              </div>
              <button
                onClick={() => setNotesRow(null)}
                aria-label="Close"
                className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <NotesLog
                level={notesRow.assign_type === "vendor" ? "vendor" : "description3"}
                scope={{
                  assign_type:  notesRow.assign_type,
                  assign_value: normGroupKey(notesRow.assign_type, notesRow.group_key),
                }}
                entityLabel={notesRow.check_description_3 ?? notesRow.group_key}
                emptyMessage="No notes yet — record why an allocation changed."
              />
            </div>
          </aside>
        </>
      )}

      {/* Bulk split dialog */}
      {bulkEditing && (
        <BulkSplitDialog
          selectedRows={selectedRows}
          costCenters={costCenters}
          onClose={() => setBulkEditing(false)}
          onSaved={() => {
            setBulkEditing(false);
            setSelected(new Set());
            fetchData();
          }}
        />
      )}

      {/* Bulk fee dialog */}
      {bulkFeeEditing && (
        <BulkFeeDialog
          employees={rosterEmployeesSelected}
          onClose={() => setBulkFeeEditing(false)}
          onApply={(not_recoverable, fee_amount) => {
            setSelected(new Set());
            handleBulkFeeApply(rosterEmployeesSelected, not_recoverable, fee_amount);
          }}
        />
      )}
    </div>
  );
}
