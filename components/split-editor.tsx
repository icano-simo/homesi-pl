"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Plus, Trash2, AlertTriangle, Calendar } from "lucide-react";
import type { CostCenter } from "@/types";

const MONTH_OPTIONS = [
  { value: 1, label: "January"  }, { value: 2,  label: "February" },
  { value: 3, label: "March"    }, { value: 4,  label: "April"    },
  { value: 5, label: "May"      }, { value: 6,  label: "June"     },
  { value: 7, label: "July"     }, { value: 8,  label: "August"   },
  { value: 9, label: "September"}, { value: 10, label: "October"  },
  { value: 11, label: "November"}, { value: 12, label: "December" },
];
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

interface SplitRow {
  cost_center_id: string;
  percentage: string;
  is_operational: boolean;
}

interface SplitRowData {
  cost_center_id: string;
  percentage: number;
  is_operational: boolean;
}

interface VersionData {
  effective_from_year:  number | null;
  effective_from_month: number | null;
  splits: SplitRowData[];
}

interface SplitEditorProps {
  assignType:  "vendor" | "description3";
  assignValue: string;
  displayName: string;
  txCount:     number;
  costCenters: CostCenter[];
  onClose:     () => void;
  onSaved:     () => void;
}

function versionLabel(year: number | null, month: number | null): string {
  if (year == null) return "Initial";
  return `${MONTH_ABBR[(month ?? 1) - 1]} ${year}`;
}

function splitsToRows(splits: SplitRowData[]): SplitRow[] {
  if (!splits || splits.length === 0) {
    return [{ cost_center_id: "", percentage: "100", is_operational: true }];
  }
  return splits.map((s) => ({
    cost_center_id: s.cost_center_id,
    percentage:     String(s.percentage),
    is_operational: s.is_operational ?? true,
  }));
}

export function SplitEditor({
  assignType, assignValue, displayName, txCount, costCenters, onClose, onSaved,
}: SplitEditorProps) {
  const [versions, setVersions]         = useState<VersionData[]>([]);
  const [activeIdx, setActiveIdx]       = useState(0);
  const [rows, setRows]                 = useState<SplitRow[]>([{ cost_center_id: "", percentage: "100", is_operational: true }]);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [errMsg, setErrMsg]             = useState("");
  const [ruleConflict, setRuleConflict] = useState<{ rule_id: string; rule_name: string } | null>(null);
  const [conflictPending, setConflictPending] = useState(false);

  // New version form
  const [isAddingVersion, setIsAddingVersion] = useState(false);
  const [newYear,  setNewYear]  = useState(String(new Date().getFullYear()));
  const [newMonth, setNewMonth] = useState("1");

  // Delete confirm
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  const [deletingVersion,  setDeletingVersion]  = useState(false);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    const splitsUrl   = `/api/cc-allocation-splits?type=${encodeURIComponent(assignType)}&value=${encodeURIComponent(assignValue)}&include_rule=true`;
    const conflictUrl = `/api/cc-allocation-splits/conflict-check?type=${encodeURIComponent(assignType)}&value=${encodeURIComponent(assignValue)}`;
    try {
      const [splitsRes, conflictRes] = await Promise.all([
        fetch(splitsUrl).then((r) => r.json()),
        fetch(conflictUrl).then((r) => r.json()),
      ]);
      const loaded = ((splitsRes as { versions?: VersionData[] }).versions ?? []);
      setVersions(loaded);
      setActiveIdx(0);
      setRows(splitsToRows(loaded[0]?.splits ?? []));
      const cd = conflictRes as { rule_conflict: { rule_id: string; rule_name: string } | null };
      setRuleConflict(cd.rule_conflict ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [assignType, assignValue]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  function selectVersion(idx: number) {
    if (idx === activeIdx) return;
    setActiveIdx(idx);
    setRows(splitsToRows(versions[idx]?.splits ?? []));
    setIsAddingVersion(false);
    setConfirmDeleteIdx(null);
    setErrMsg("");
  }

  function startAddVersion() {
    setIsAddingVersion(true);
    setNewYear(String(new Date().getFullYear()));
    setNewMonth("1");
    setConfirmDeleteIdx(null);
  }

  function commitNewVersion() {
    const y = Number(newYear);
    const m = Number(newMonth);
    if (!y || y < 2000 || y > 2100 || !m || m < 1 || m > 12) return;
    // Pre-populate splits from the current latest version
    const baseSplits = versions[0]?.splits ?? [];
    const newVer: VersionData = { effective_from_year: y, effective_from_month: m, splits: baseSplits };
    const updated = [newVer, ...versions];
    setVersions(updated);
    setActiveIdx(0);
    setRows(splitsToRows(baseSplits));
    setIsAddingVersion(false);
    setErrMsg("");
  }

  async function handleDeleteVersion(idx: number) {
    const v = versions[idx];
    if (!v) return;
    setDeletingVersion(true);
    try {
      const yearParam  = v.effective_from_year  ?? 0;
      const monthParam = v.effective_from_month ?? 0;
      const res = await fetch(
        `/api/cc-allocation-splits?type=${encodeURIComponent(assignType)}&value=${encodeURIComponent(assignValue)}&year=${yearParam}&month=${monthParam}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok) { setErrMsg(json.error ?? "Delete failed"); return; }
      setConfirmDeleteIdx(null);
      await loadVersions();
    } catch (e) {
      setErrMsg(String(e));
    } finally {
      setDeletingVersion(false);
    }
  }

  const parsedRows = rows.map((r) => ({ ...r, pct: parseFloat(r.percentage) || 0 }));
  const sum   = parsedRows.reduce((s, r) => s + r.pct, 0);
  const sumOk = Math.abs(sum - 100) < 0.01;
  const canSave = sumOk && rows.every((r) => r.cost_center_id) && !saving && !loading;

  function setRowField(idx: number, field: keyof SplitRow, value: string) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }
  function addRow()              { setRows((prev) => [...prev, { cost_center_id: "", percentage: "", is_operational: true }]); }
  function removeRow(idx: number){ setRows((prev) => prev.filter((_, i) => i !== idx)); }

  async function handleSave() {
    if (ruleConflict && !conflictPending) { setConflictPending(true); return; }
    const activeVersion = versions[activeIdx]; // undefined = initial version not yet in DB
    setSaving(true); setErrMsg("");
    try {
      const res = await fetch("/api/cc-allocation-splits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assign_type:          assignType,
          assign_value:         assignValue,
          effective_from_year:  activeVersion?.effective_from_year  ?? null,
          effective_from_month: activeVersion?.effective_from_month ?? null,
          splits: parsedRows.map((r) => ({
            cost_center_id: r.cost_center_id,
            percentage:     r.pct,
            is_operational: r.is_operational,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) { setErrMsg(json.error ?? "Save failed"); return; }
      onSaved();
    } catch (e) {
      setErrMsg(String(e));
    } finally {
      setSaving(false);
      setConflictPending(false);
    }
  }

  const sumLabel =
    sum === 0   ? "Enter percentages — must total 100%"
    : sumOk     ? "✓ Total: 100%"
    : sum > 100 ? `Exceeds 100% by ${(sum - 100).toFixed(3)}% — reduce before saving`
    :              `${(100 - sum).toFixed(3)}% remaining  (total: ${sum.toFixed(3)}%)`;

  const sumColor  = sum === 0 ? "text-gray-400" : sumOk ? "text-green-700" : sum > 100 ? "text-red-600" : "text-gray-600";
  const sumBorder = sumOk ? "border-green-200 bg-green-50" : sum > 100 ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50";

  const ccIds = rows.map((r) => r.cost_center_id).filter(Boolean);
  const hasDuplicateCCs = ccIds.length !== new Set(ccIds).size;
  const activeVersion = versions[activeIdx];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-xl">

        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="min-w-0 pr-4">
            <h3 className="text-base font-semibold text-gray-900">Cost Center Allocation</h3>
            <p className="mt-0.5 text-sm text-gray-600 truncate" title={displayName}>{displayName}</p>
            <p className="text-xs text-gray-400">
              {txCount.toLocaleString()} transaction{txCount !== 1 ? "s" : ""} will be updated globally
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-600 mt-0.5">
            <X size={18} />
          </button>
        </div>

        {/* Version tab bar — shown when multiple versions exist or while adding */}
        {!loading && (versions.length > 0 || isAddingVersion) && (
          <div className="border-b border-gray-100 px-5 py-2 flex items-center gap-1.5 flex-wrap">
            {versions.map((v, i) => (
              <button
                key={`${v.effective_from_year ?? 0}-${v.effective_from_month ?? 0}`}
                onClick={() => selectVersion(i)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  i === activeIdx && !isAddingVersion
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {versionLabel(v.effective_from_year, v.effective_from_month)}
              </button>
            ))}
            {!isAddingVersion && (
              <button
                onClick={startAddVersion}
                className="shrink-0 flex items-center gap-0.5 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors"
              >
                <Plus size={11} /> Version
              </button>
            )}
          </div>
        )}

        {/* New version sub-form */}
        {isAddingVersion && (
          <div className="border-b border-gray-100 bg-blue-50 px-5 py-3 flex items-center gap-2 flex-wrap">
            <Calendar size={13} className="text-blue-500 shrink-0" />
            <span className="text-xs font-medium text-blue-700 shrink-0">Effective from:</span>
            <select
              value={newMonth}
              onChange={(e) => setNewMonth(e.target.value)}
              className="rounded border border-blue-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
            >
              {MONTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <input
              type="number" min="2000" max="2100"
              value={newYear}
              onChange={(e) => setNewYear(e.target.value)}
              className="w-20 rounded border border-blue-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
              placeholder="YYYY"
            />
            <button
              onClick={commitNewVersion}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Create
            </button>
            <button
              onClick={() => setIsAddingVersion(false)}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Body */}
        <div className="p-5 space-y-3">
          {loading ? (
            <div className="py-8 text-center text-gray-400">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
            </div>
          ) : (
            <>
              {/* Version caption */}
              <p className="text-[11px] text-gray-400">
                {(activeVersion?.effective_from_year == null)
                  ? "Initial version — applies from the beginning"
                  : `In effect from ${versionLabel(activeVersion.effective_from_year, activeVersion.effective_from_month)}`}
                {versions.length === 0 && !isAddingVersion && (
                  <>
                    {" · "}
                    <button onClick={startAddVersion} className="text-blue-500 hover:text-blue-700 underline">
                      Add a version
                    </button>
                  </>
                )}
              </p>

              {/* Column labels */}
              <div className="grid grid-cols-[1fr_6rem_5rem_1.5rem] gap-2 px-0.5">
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Cost Center</span>
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide text-right">%</span>
                <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide text-center">Type</span>
                <span />
              </div>

              {/* Rows */}
              <div className="space-y-2">
                {rows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_6rem_5rem_1.5rem] gap-2 items-center">
                    <select
                      value={row.cost_center_id}
                      onChange={(e) => setRowField(idx, "cost_center_id", e.target.value)}
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
                        onChange={(e) => setRowField(idx, "percentage", e.target.value)}
                        placeholder="0"
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pr-6 text-sm text-right text-gray-700 focus:border-blue-400 focus:outline-none"
                      />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.map((r, i) => i === idx ? { ...r, is_operational: !r.is_operational } : r))}
                      className={`text-[10px] rounded px-1.5 py-1 font-medium border transition-colors ${
                        row.is_operational
                          ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                          : "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                      }`}
                    >
                      {row.is_operational ? "Op" : "Non-Op"}
                    </button>
                    <button
                      onClick={() => removeRow(idx)}
                      disabled={rows.length <= 1}
                      className="text-gray-300 hover:text-red-500 disabled:opacity-0 disabled:pointer-events-none"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add row */}
              <button
                onClick={addRow}
                className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                <Plus size={13} /> Add cost center
              </button>

              {/* Sum indicator */}
              <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${sumBorder}`}>
                <span className={`text-xs font-medium ${sumColor}`}>{sumLabel}</span>
                {rows.length === 1 && !sumOk && (
                  <button
                    onClick={() => setRowField(0, "percentage", "100")}
                    className="text-xs text-blue-500 hover:text-blue-700 underline shrink-0 ml-2"
                  >
                    Set 100%
                  </button>
                )}
              </div>

              {hasDuplicateCCs && (
                <p className="text-xs text-red-600">Each cost center can only appear once.</p>
              )}

              {/* Delete version confirm */}
              {confirmDeleteIdx !== null && (
                <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2.5">
                  <p className="text-xs font-medium text-red-800">
                    Delete the &ldquo;{versionLabel(
                      versions[confirmDeleteIdx]?.effective_from_year ?? null,
                      versions[confirmDeleteIdx]?.effective_from_month ?? null,
                    )}&rdquo; version?
                  </p>
                  <p className="mt-0.5 text-xs text-red-700">
                    Affected transactions will be reassigned to the previous version (or unassigned if none).
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => handleDeleteVersion(confirmDeleteIdx)}
                      disabled={deletingVersion}
                      className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deletingVersion ? "Deleting…" : "Confirm delete"}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteIdx(null)}
                      className="rounded border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {errMsg && (
                <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{errMsg}</p>
              )}
            </>
          )}
        </div>

        {/* Conflict warning */}
        {conflictPending && ruleConflict && (
          <div className="mx-5 mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-900">Rule conflict detected</p>
                <p className="mt-0.5 text-xs text-amber-800">
                  <strong>{displayName}</strong> is already captured by the rule{" "}
                  <strong>&ldquo;{ruleConflict.rule_name}&rdquo;</strong>. Saving a manual split here will
                  override what the rule defines — the manual split takes priority in all reports.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save anyway"}
                  </button>
                  <button
                    onClick={() => setConflictPending(false)}
                    className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
          <p className="text-[11px] text-gray-400">Assignments apply to all historical data</p>
          <div className="flex gap-2 items-center">
            {versions.length > 1 && confirmDeleteIdx === null && (
              <button
                onClick={() => setConfirmDeleteIdx(activeIdx)}
                title={`Delete "${versionLabel(activeVersion?.effective_from_year ?? null, activeVersion?.effective_from_month ?? null)}" version`}
                className="rounded-lg border border-red-200 px-2.5 py-2 text-red-500 hover:bg-red-50 hover:border-red-300"
              >
                <Trash2 size={13} />
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || hasDuplicateCCs || conflictPending}
              title={!sumOk ? "Percentages must total 100% before saving" : undefined}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : "Save allocation"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
