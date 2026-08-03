"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronRight,
  RotateCcw, UserCheck, Layers, ClipboardList, Percent, Search, X,
} from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import { SplitEditor } from "@/components/split-editor";
import { buildSplitsMap } from "@/lib/apply-splits";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import { SplitDisplay } from "@/components/split-display";
import type { SplitEntry } from "@/lib/apply-splits";
import type { CostCenter, ConflictGroup, ResolvedConflictGroup, AssignmentGroup, AssignmentTx, ConflictTx, MatchedRuleProposal } from "@/types";

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function mvCls(n: number | null | undefined) {
  const v = n ?? 0;
  return v > 0 ? "text-green-700" : v < 0 ? "text-red-600" : "text-gray-400";
}

function branchParams(branches: string[]): string {
  if (branches.length === 0) return "";
  return "?" + branches.map((b) => `branch=${encodeURIComponent(b)}`).join("&");
}

type SearchableTx = {
  check_description?: string | null;
  check_description_2?: string | null;
  check_description_3?: string | null;
  vendor?: string | null;
  branch?: string | null;
  gl_name?: string | null;
};

function txMatchesSearch(tx: SearchableTx, q: string): boolean {
  const lq = q.toLowerCase();
  return [tx.check_description, tx.check_description_2, tx.check_description_3, tx.vendor, tx.branch, tx.gl_name]
    .some((v) => v?.toLowerCase().includes(lq));
}

function txMatchesCcFilter(
  tx: { cost_center_name?: string | null; vendor?: string | null; check_description_3?: string | null },
  ccFilter: string[],
  splitsMap: Map<string, SplitEntry[]>
): boolean {
  if (ccFilter.length === 0) return true;
  if (tx.cost_center_name && ccFilter.includes(tx.cost_center_name)) return true;
  const normVendor = tx.vendor?.trim().replace(/\s+/g, " ") || null;
  const splits =
    (normVendor ? splitsMap.get(`vendor:${normVendor}`) : undefined) ??
    (tx.check_description_3 ? splitsMap.get(`description3:${tx.check_description_3}`) : undefined);
  return splits?.some((s) => ccFilter.includes(s.cost_centers?.name ?? "")) ?? false;
}

function CD2Cell({ v }: { v: string | null | undefined }) {
  return v ? <span className="text-sky-700 truncate">{v}</span> : <span className="text-gray-300">—</span>;
}
function CD3Cell({ v }: { v: string | null | undefined }) {
  return v ? <span className="text-sky-600 truncate">{v}</span> : <span className="text-gray-300">—</span>;
}

// ─── Shared: assign multiple txs to a CC ─────────────────────────────────────

async function apiAssign(transactionIds: string[], costCenterId: string, is_operational = true): Promise<string | null> {
  const res = await fetch("/api/cost-center-assignment/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_ids: transactionIds, cost_center_id: costCenterId, is_operational }),
  });
  if (!res.ok) { const j = await res.json(); return j.error ?? "Unknown error"; }
  return null;
}

async function apiSetOperational(transactionIds: string[], isOperational: boolean): Promise<string | null> {
  const res = await fetch("/api/cost-center-assignment/set-operational", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_ids: transactionIds, is_operational: isOperational }),
  });
  if (!res.ok) { const j = await res.json(); return j.error ?? "Unknown error"; }
  return null;
}

function OpBadge({ isOp, busy, onToggle }: { isOp: boolean; busy?: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      title={isOp ? "Operational — click to set Non-Operational" : "Non-Operational — click to set Operational"}
      className={[
        "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none transition-colors disabled:opacity-50 whitespace-nowrap",
        isOp
          ? "bg-green-100 text-green-700 hover:bg-green-200"
          : "bg-gray-100 text-gray-500 hover:bg-gray-200",
      ].join(" ")}
    >
      {busy ? "…" : isOp ? "Op" : "Non-Op"}
    </button>
  );
}

// ─── Shared AssignTab ─────────────────────────────────────────────────────────

function AssignTab({
  costCenters, endpoint, mode, branches, showAllocationButtons = false, glFilter, txSearch, ccFilter = [],
}: {
  costCenters: CostCenter[];
  endpoint: string;
  mode: "assign" | "override";
  branches: string[];
  showAllocationButtons?: boolean;
  glFilter: string[];
  txSearch: string;
  ccFilter?: string[];
}) {
  const [groups, setGroups] = useState<AssignmentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rowCc, setRowCc] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCcId, setBulkCcId] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [rowOp, setRowOp] = useState<Record<string, boolean>>({});
  const [bulkOp, setBulkOp] = useState(true);
  const [opBusy, setOpBusy] = useState<Set<string>>(new Set());

  // Allocation buttons state (only active when showAllocationButtons)
  const [allSplits, setAllSplits] = useState<SplitEntry[]>([]);
  const [editingTx, setEditingTx] = useState<AssignmentTx | null>(null);
  const [txUnassigning, setTxUnassigning] = useState<string | null>(null);
  const [txUnassignBusy, setTxUnassignBusy] = useState(false);
  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const fetches: Promise<void>[] = [
        fetch(`${endpoint}${branchParams(branches)}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d) setGroups(d); }),
      ];
      if (showAllocationButtons) {
        fetches.push(
          fetch("/api/cc-allocation-splits")
            .then((r) => r.ok ? r.json() : [])
            .then(setAllSplits)
        );
      }
      await Promise.all(fetches);
    } finally { setLoading(false); }
  }, [endpoint, branches, showAllocationButtons]);

  useEffect(() => { load(); }, [load]);

  // Single pass: computes visible groups AND per-group filtered transactions.
  // Render body reads from visibleTxsMap (O(1) lookup) instead of re-filtering on every render.
  const { visibleGroups, visibleTxsMap } = useMemo(() => {
    const visibleGroups: AssignmentGroup[] = [];
    const visibleTxsMap = new Map<string, AssignmentTx[]>();
    for (const g of groups) {
      if (glFilter.length > 0 && !glFilter.includes(g.gl_code)) continue;
      const txs = g.transactions.filter((tx) =>
        (!txSearch || txMatchesSearch(tx, txSearch)) &&
        txMatchesCcFilter(tx, ccFilter, splitsMap)
      );
      if (txs.length > 0) {
        visibleGroups.push(g);
        visibleTxsMap.set(g.gl_code, txs);
      }
    }
    return { visibleGroups, visibleTxsMap };
  }, [groups, glFilter, txSearch, ccFilter, splitsMap]);

  let totalCount = 0;
  for (const txs of visibleTxsMap.values()) totalCount += txs.length;

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const txs of visibleTxsMap.values()) txs.forEach((tx) => ids.add(tx.id));
    return ids;
  }, [visibleTxsMap]);

  const visibleSelected = useMemo(
    () => [...selected].filter((id) => allVisibleIds.has(id)),
    [selected, allVisibleIds]
  );

  function toggleGroup(key: string) {
    setCollapsed((prev) => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }
  function toggleRow(id: string) {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleGroupRows(visibleIds: string[]) {
    const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const s = new Set(prev);
      if (allSel) visibleIds.forEach((id) => s.delete(id));
      else visibleIds.forEach((id) => s.add(id));
      return s;
    });
  }

  async function handleToggleOp(txId: string, isOp: boolean) {
    setOpBusy((prev) => new Set([...prev, txId]));
    try {
      const err = await apiSetOperational([txId], isOp);
      if (err) { setMsg(`Error: ${err}`); return; }
      await load();
    } finally {
      setOpBusy((prev) => { const s = new Set(prev); s.delete(txId); return s; });
    }
  }

  async function handleBulkSetOp(isOp: boolean) {
    if (!visibleSelected.length) return;
    setSaving(true); setMsg("");
    try {
      const err = await apiSetOperational(visibleSelected, isOp);
      if (err) { setMsg(`Error: ${err}`); return; }
      setSelected(new Set());
      await load();
    } finally { setSaving(false); }
  }

  async function assign(txIds: string[], ccId: string, isOp = true) {
    if (!ccId || !txIds.length) return;
    setSaving(true); setMsg("");
    try {
      const err = await apiAssign(txIds, ccId, isOp);
      if (err) { setMsg(`Error: ${err}`); return; }
      setSelected(new Set()); setBulkCcId(""); setRowCc({}); setRowOp({}); setBulkOp(true);
      load();
    } finally { setSaving(false); }
  }

  const editNormVendor = editingTx?.vendor?.trim().replace(/\s+/g, " ") || null;
  const editAssignType: "vendor" | "description3" = editNormVendor ? "vendor" : "description3";
  const editAssignValue = editNormVendor ?? (editingTx?.check_description_3 ?? "");

  async function handleTxUnassign(txId: string) {
    setTxUnassignBusy(true);
    try {
      await fetch("/api/cost-center-assignment/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_ids: [txId] }),
      });
      setTxUnassigning(null);
      load();
    } finally { setTxUnassignBusy(false); }
  }

  if (loading) return (
    <div className="py-10 text-center text-gray-400">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
    </div>
  );

  if (totalCount === 0) return (
    <div className="rounded-xl border border-green-100 bg-green-50 px-6 py-8 text-center">
      <CheckCircle size={20} className="mx-auto mb-2 text-green-500" />
      <p className="text-sm font-medium text-green-700">
        {mode === "assign" ? "No unassigned transactions." : "No rule-assigned transactions."}
        {branches.length > 0 && " (within selected branches)"}
      </p>
    </div>
  );

  const actionLabel = mode === "assign" ? "Assign" : "Override";
  const bgBanner = mode === "assign" ? "border-gray-200 bg-gray-50" : "border-blue-100 bg-blue-50";
  const textBanner = mode === "assign" ? "text-gray-600" : "text-blue-700";

  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border ${bgBanner} px-4 py-3`}>
        <span className={`text-xs font-medium ${textBanner}`}>
          {totalCount} transaction{totalCount !== 1 ? "s" : ""}
          {visibleSelected.length > 0 && ` · ${visibleSelected.length} selected`}
        </span>
        {visibleSelected.length > 0 && (
          <>
            <button
              onClick={() => handleBulkSetOp(true)}
              disabled={saving}
              className="rounded-lg bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-200 disabled:opacity-40"
            >
              Set Operational
            </button>
            <button
              onClick={() => handleBulkSetOp(false)}
              disabled={saving}
              className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-40"
            >
              Set Non-Op
            </button>
            <span className="text-gray-300">|</span>
            <select
              value={bulkCcId}
              onChange={(e) => setBulkCcId(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
            >
              <option value="">{actionLabel} to…</option>
              {costCenters.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}
            </select>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={!bulkOp}
                onChange={(e) => setBulkOp(!e.target.checked)}
                className="h-3 w-3 accent-red-500"
              />
              <span className="text-[10px] text-gray-500">Non-Op</span>
            </label>
            <button
              onClick={() => assign(visibleSelected, bulkCcId, bulkOp)}
              disabled={!bulkCcId || saving}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {saving ? "Saving…" : `${actionLabel} ${visibleSelected.length}`}
            </button>
          </>
        )}
      </div>

      {msg && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{msg}</p>}

      {visibleGroups.map((group) => {
        const key = group.gl_code;
        const isCollapsed = collapsed.has(key);
        const visibleTxs = visibleTxsMap.get(key) ?? [];
        const visibleIds = visibleTxs.map((t) => t.id);
        const groupAllSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

        return (
          <div key={key} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div
              className="flex cursor-pointer items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2.5 hover:bg-gray-100"
              onClick={() => toggleGroup(key)}
            >
              <input
                type="checkbox" checked={groupAllSel}
                onChange={() => toggleGroupRows(visibleIds)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 accent-blue-600 rounded"
              />
              {isCollapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
              <span className="text-xs font-semibold font-mono text-gray-800">{group.gl_code}</span>
              <span className="text-xs text-gray-500">{group.gl_name}</span>
              <span className="ml-auto text-xs text-gray-400">{group.transactions.length} tx{(txSearch || ccFilter.length > 0) && visibleTxs.length !== group.transactions.length ? ` · ${visibleTxs.length} visible` : ""}</span>
            </div>

            {!isCollapsed && (
              <div className="overflow-auto max-h-[500px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-gray-400">
                    <th className="w-7 px-2 py-1" />
                    <th className="px-2 py-1 font-medium">Month</th>
                    <th className="px-2 py-1 font-medium">Branch</th>
                    <th className="px-2 py-1 font-medium">Description</th>
                    <th className="px-2 py-1 font-medium">Check Desc 2</th>
                    <th className="px-2 py-1 font-medium">Check Desc 3</th>
                    <th className="px-2 py-1 font-medium">Vendor</th>
                    <th className="px-2 py-1 text-right font-medium">Movement</th>
                    {mode === "override" && <th className="px-2 py-1 font-medium">Current CC</th>}
                    {mode === "override" && <th className="px-2 py-1 font-medium">Status</th>}
                    <th className="px-2 py-1 font-medium">{actionLabel} to</th>
                    <th className="w-8 px-1 py-1 text-center font-medium">Op</th>
                    <th className="w-14 px-2 py-1" />
                    {showAllocationButtons && <th className="px-2 py-1 font-medium">Allocation</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleTxs.map((tx: AssignmentTx) => {
                  const allocNorm = showAllocationButtons ? (tx.vendor?.trim().replace(/\s+/g, " ") || null) : null;
                  const allocValue = allocNorm ?? (showAllocationButtons ? (tx.check_description_3 ?? "") : "");
                  return (
                    <tr key={tx.id} className={`border-b border-gray-50 hover:bg-blue-50/20 ${selected.has(tx.id) ? "bg-blue-50/40" : ""}`}>
                      <td className="px-2 py-1">
                        <input
                          type="checkbox" checked={selected.has(tx.id)}
                          onChange={() => toggleRow(tx.id)}
                          className="h-3.5 w-3.5 accent-blue-600 rounded"
                        />
                      </td>
                      <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{tx.month ?? "—"}</td>
                      <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{tx.branch ?? "—"}</td>
                      <td className="max-w-[140px] truncate px-2 py-1 text-gray-600" title={tx.check_description ?? ""}>{tx.check_description ?? "—"}</td>
                      <td className="max-w-[90px] truncate px-2 py-1"><CD2Cell v={tx.check_description_2} /></td>
                      <td className="max-w-[90px] truncate px-2 py-1"><CD3Cell v={tx.check_description_3} /></td>
                      <td className="max-w-[100px] truncate px-2 py-1 text-gray-600" title={tx.vendor ?? ""}>{tx.vendor ?? "—"}</td>
                      <td className={`px-2 py-1 text-right font-mono whitespace-nowrap ${mvCls(tx.movement)}`}>{fmt(tx.movement)}</td>
                      {mode === "override" && (
                        <td className="px-2 py-1">
                          {tx.cost_center_name
                            ? <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 text-[10px] font-medium">{tx.cost_center_name}</span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                      )}
                      {mode === "override" && (
                        <td className="px-2 py-1">
                          <OpBadge
                            isOp={(tx.operational_pct ?? 100) > 0}
                            busy={opBusy.has(tx.id)}
                            onToggle={() => handleToggleOp(tx.id, (tx.operational_pct ?? 100) === 0)}
                          />
                        </td>
                      )}
                      <td className="px-2 py-1">
                        <select
                          value={rowCc[tx.id] ?? ""}
                          onChange={(e) => setRowCc((prev) => ({ ...prev, [tx.id]: e.target.value }))}
                          className="rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
                        >
                          <option value="">Choose…</option>
                          {costCenters.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1 text-center">
                        <label className="inline-flex items-center cursor-pointer" title={rowOp[tx.id] !== false ? "Operational" : "Non-Operational"}>
                          <input
                            type="checkbox"
                            checked={rowOp[tx.id] === false}
                            onChange={(e) => setRowOp((prev) => ({ ...prev, [tx.id]: !e.target.checked }))}
                            className="h-3 w-3 accent-red-500"
                          />
                        </label>
                      </td>
                      <td className="px-2 py-1">
                        <button
                          onClick={() => assign([tx.id], rowCc[tx.id] ?? "", rowOp[tx.id] ?? true)}
                          disabled={!rowCc[tx.id] || saving}
                          className="rounded-lg bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30"
                        >
                          {actionLabel}
                        </button>
                      </td>
                      {showAllocationButtons && (
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1.5">
                            {allocValue && (
                              <button
                                onClick={() => setEditingTx(tx)}
                                className="flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 whitespace-nowrap"
                              >
                                <Percent size={9} /> Edit alloc.
                              </button>
                            )}
                            {txUnassigning === tx.id ? (
                              <span className="flex items-center gap-1 text-[10px]">
                                <span className="text-red-600 font-medium">Remove?</span>
                                <button
                                  onClick={() => handleTxUnassign(tx.id)}
                                  disabled={txUnassignBusy}
                                  className="rounded px-1.5 py-0.5 bg-red-600 text-white text-[10px] hover:bg-red-700 disabled:opacity-40"
                                >Yes</button>
                                <button
                                  onClick={() => setTxUnassigning(null)}
                                  className="rounded px-1.5 py-0.5 border border-gray-200 text-gray-500 text-[10px] hover:bg-gray-50"
                                >No</button>
                              </span>
                            ) : (
                              <button
                                onClick={() => setTxUnassigning(tx.id)}
                                className="rounded border border-gray-100 px-1.5 py-0.5 text-[10px] text-red-400 hover:border-red-200 hover:text-red-600 whitespace-nowrap"
                              >Unassign</button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                </tbody>
              </table>
              </div>
            )}
          </div>
        );
      })}

      {showAllocationButtons && editingTx && (
        <SplitEditor
          assignType={editAssignType}
          assignValue={editAssignValue}
          displayName={editAssignValue}
          txCount={1}
          costCenters={costCenters}
          onClose={() => setEditingTx(null)}
          onSaved={() => { setEditingTx(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Unassigned / Assigned by Rule (wrappers) ─────────────────────────────────

function UnassignedTab({ costCenters, branches, glFilter, txSearch }: { costCenters: CostCenter[]; branches: string[]; glFilter: string[]; txSearch: string }) {
  return <AssignTab costCenters={costCenters} endpoint="/api/cost-center-assignment/unassigned" mode="assign" branches={branches} glFilter={glFilter} txSearch={txSearch} />;
}

function AssignedByRuleTab({ costCenters, branches, glFilter, txSearch, ccFilter }: { costCenters: CostCenter[]; branches: string[]; glFilter: string[]; txSearch: string; ccFilter: string[] }) {
  return <AssignTab costCenters={costCenters} endpoint="/api/cost-center-assignment/assigned-by-rule" mode="override" branches={branches} showAllocationButtons glFilter={glFilter} txSearch={txSearch} ccFilter={ccFilter} />;
}

// ─── Manual Assigned Tab ──────────────────────────────────────────────────────

function ManualTab({ branches, costCenters, glFilter, txSearch, ccFilter }: { branches: string[]; costCenters: CostCenter[]; glFilter: string[]; txSearch: string; ccFilter: string[] }) {
  const [groups, setGroups] = useState<AssignmentGroup[]>([]);
  const [allSplits, setAllSplits] = useState<SplitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingTx, setEditingTx] = useState<AssignmentTx | null>(null);
  const [unassigning, setUnassigning] = useState<string | null>(null);
  const [unassignBusy, setUnassignBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmUnassign, setConfirmUnassign] = useState(false);
  const [bulkReassignCcId, setBulkReassignCcId] = useState("");
  const [bulkOp, setBulkOp] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");
  const [unassignErr, setUnassignErr] = useState("");
  const [opBusy, setOpBusy] = useState<Set<string>>(new Set());

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groupsRes, splitsRes] = await Promise.all([
        fetch(`/api/cost-center-assignment/manual${branchParams(branches)}`),
        fetch("/api/cc-allocation-splits"),
      ]);
      if (groupsRes.ok) setGroups(await groupsRes.json());
      if (splitsRes.ok) setAllSplits(await splitsRes.json());
    } finally { setLoading(false); }
  }, [branches]);

  useEffect(() => { load(); }, [load]);

  const { visibleGroups, visibleTxsMap } = useMemo(() => {
    const visibleGroups: AssignmentGroup[] = [];
    const visibleTxsMap = new Map<string, AssignmentTx[]>();
    for (const g of groups) {
      if (glFilter.length > 0 && !glFilter.includes(g.gl_code)) continue;
      const txs = g.transactions.filter((tx) =>
        (!txSearch || txMatchesSearch(tx, txSearch)) &&
        txMatchesCcFilter(tx, ccFilter, splitsMap)
      );
      if (txs.length > 0) {
        visibleGroups.push(g);
        visibleTxsMap.set(g.gl_code, txs);
      }
    }
    return { visibleGroups, visibleTxsMap };
  }, [groups, glFilter, txSearch, ccFilter, splitsMap]);

  let totalCount = 0;
  for (const txs of visibleTxsMap.values()) totalCount += txs.length;

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const txs of visibleTxsMap.values()) txs.forEach((tx) => ids.add(tx.id));
    return ids;
  }, [visibleTxsMap]);

  const visibleSelected = useMemo(
    () => [...selected].filter((id) => allVisibleIds.has(id)),
    [selected, allVisibleIds]
  );

  function toggleGroup(key: string) {
    setCollapsed((prev) => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }
  function toggleRow(id: string) {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleGroupRows(visibleIds: string[]) {
    const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const s = new Set(prev);
      if (allSel) visibleIds.forEach((id) => s.delete(id));
      else visibleIds.forEach((id) => s.add(id));
      return s;
    });
  }

  async function handleToggleOp(txId: string, isOp: boolean) {
    setOpBusy((prev) => new Set([...prev, txId]));
    try {
      const err = await apiSetOperational([txId], isOp);
      if (err) { setBulkMsg(`Error: ${err}`); return; }
      await load();
    } finally {
      setOpBusy((prev) => { const s = new Set(prev); s.delete(txId); return s; });
    }
  }

  async function handleBulkSetOp(isOp: boolean) {
    if (!visibleSelected.length) return;
    setBulkBusy(true); setBulkMsg("");
    try {
      const err = await apiSetOperational(visibleSelected, isOp);
      if (err) { setBulkMsg(`Error: ${err}`); return; }
      setSelected(new Set());
      await load();
    } finally { setBulkBusy(false); }
  }

  async function handleBulkUnassign() {
    const ids = visibleSelected;
    if (!ids.length) return;
    setBulkBusy(true); setBulkMsg("");
    try {
      const res = await fetch("/api/cost-center-assignment/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_ids: ids }),
      });
      if (!res.ok) { const j = await res.json(); setBulkMsg(`Error: ${j.error ?? "Unknown error"}`); return; }
      setSelected(new Set()); setConfirmUnassign(false); await load();
    } finally { setBulkBusy(false); }
  }

  async function handleUnassignSingle(txId: string) {
    setUnassignBusy(true);
    setUnassignErr("");
    try {
      const res = await fetch("/api/cost-center-assignment/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_ids: [txId] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setUnassignErr(`Error: ${(j as { error?: string }).error ?? "Unknown error"}`);
        return;
      }
      setUnassigning(null);
      await load();
    } finally {
      setUnassignBusy(false);
    }
  }

  async function handleBulkReassign() {
    if (!bulkReassignCcId) return;
    const ids = visibleSelected;
    if (!ids.length) return;
    setBulkBusy(true); setBulkMsg("");
    try {
      const err = await apiAssign(ids, bulkReassignCcId, bulkOp);
      if (err) { setBulkMsg(`Error: ${err}`); return; }
      setSelected(new Set()); setBulkReassignCcId(""); setBulkOp(true); load();
    } finally { setBulkBusy(false); }
  }

  if (loading) return (
    <div className="py-10 text-center text-gray-400">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
    </div>
  );

  if (totalCount === 0) return (
    <p className="py-10 text-center text-sm text-gray-400">
      No manually assigned transactions{branches.length > 0 ? " in selected branches" : ""}.
    </p>
  );

  const editNormVendor = editingTx?.vendor?.trim().replace(/\s+/g, " ") || null;
  const editAssignType: "vendor" | "description3" = editNormVendor ? "vendor" : "description3";
  const editAssignValue = editNormVendor ?? (editingTx?.check_description_3 ?? "");

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">{totalCount} manually assigned transaction{totalCount !== 1 ? "s" : ""} — permanent, never re-evaluated by reapply.</p>

      {/* Bulk action bar */}
      {visibleSelected.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <span className="text-xs font-medium text-gray-600">{visibleSelected.length} selected</span>
          <button
            onClick={() => handleBulkSetOp(true)}
            disabled={bulkBusy}
            className="rounded-lg bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-200 disabled:opacity-40"
          >
            Set Operational
          </button>
          <button
            onClick={() => handleBulkSetOp(false)}
            disabled={bulkBusy}
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-40"
          >
            Set Non-Op
          </button>
          <span className="text-gray-300">|</span>
          {!confirmUnassign ? (
            <button
              onClick={() => setConfirmUnassign(true)}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Unassign selected
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-red-600 font-medium">Remove CC from {visibleSelected.length} tx?</span>
              <button onClick={handleBulkUnassign} disabled={bulkBusy}
                className="rounded px-2 py-0.5 bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-40">
                {bulkBusy ? "…" : "Yes"}
              </button>
              <button onClick={() => setConfirmUnassign(false)}
                className="rounded px-2 py-0.5 border border-gray-200 text-gray-500 text-xs hover:bg-gray-50">
                No
              </button>
            </span>
          )}
          <span className="text-gray-300">|</span>
          <select
            value={bulkReassignCcId}
            onChange={(e) => setBulkReassignCcId(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
          >
            <option value="">Reassign to…</option>
            {costCenters.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}
          </select>
          {bulkReassignCcId && (
            <>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={!bulkOp} onChange={(e) => setBulkOp(!e.target.checked)}
                  className="h-3 w-3 accent-red-500" />
                <span className="text-[10px] text-gray-500">Non-Op</span>
              </label>
              <button onClick={handleBulkReassign} disabled={bulkBusy}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40">
                {bulkBusy ? "Saving…" : `Reassign ${visibleSelected.length}`}
              </button>
            </>
          )}
        </div>
      )}

      {bulkMsg && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{bulkMsg}</p>}
      {unassignErr && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{unassignErr}</p>}

      {visibleGroups.map((group) => {
        const key = group.gl_code;
        const isCollapsed = collapsed.has(key);
        const visibleTxs = visibleTxsMap.get(key) ?? [];
        const visibleIds = visibleTxs.map((t) => t.id);
        const groupAllSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        return (
          <div key={key} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div
              className="flex cursor-pointer items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2.5 hover:bg-gray-100"
              onClick={() => toggleGroup(key)}
            >
              <input
                type="checkbox" checked={groupAllSel}
                onChange={() => toggleGroupRows(visibleIds)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 accent-blue-600 rounded"
              />
              {isCollapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
              <span className="text-xs font-semibold font-mono text-gray-800">{group.gl_code}</span>
              <span className="text-xs text-gray-500">{group.gl_name}</span>
              <span className="ml-auto text-xs text-gray-400">{group.transactions.length} tx{(txSearch || ccFilter.length > 0) && visibleTxs.length !== group.transactions.length ? ` · ${visibleTxs.length} visible` : ""}</span>
            </div>

            {!isCollapsed && (
              <div className="overflow-auto max-h-[500px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-gray-400">
                    <th className="w-7 px-2 py-1" />
                    <th className="px-3 py-1 font-medium">Month</th>
                    <th className="px-3 py-1 font-medium">Branch</th>
                    <th className="px-3 py-1 font-medium">Description</th>
                    <th className="px-3 py-1 font-medium">Check Desc 2</th>
                    <th className="px-3 py-1 font-medium">Check Desc 3</th>
                    <th className="px-3 py-1 font-medium">Vendor</th>
                    <th className="px-3 py-1 text-right font-medium">Movement</th>
                    <th className="px-3 py-1 font-medium">Assigned to</th>
                    <th className="px-3 py-1 font-medium text-gray-400" title="Date the CC assignment was last changed">Assigned</th>
                    <th className="px-3 py-1 font-medium">Status</th>
                    <th className="px-3 py-1 font-medium">Allocation</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTxs.map((tx: AssignmentTx) => {
                    const normVendor = tx.vendor?.trim().replace(/\s+/g, " ") || null;
                    const assignValue = normVendor ?? (tx.check_description_3 ?? "");
                    return (
                      <tr key={tx.id} className={`border-b border-gray-50 hover:bg-gray-50 ${selected.has(tx.id) ? "bg-blue-50/40" : ""}`}>
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={selected.has(tx.id)}
                            onChange={() => toggleRow(tx.id)}
                            className="h-3.5 w-3.5 accent-blue-600 rounded" />
                        </td>
                        <td className="px-3 py-1 text-gray-700 whitespace-nowrap">{tx.month ?? "—"}</td>
                        <td className="px-3 py-1 text-gray-700 whitespace-nowrap">{tx.branch ?? "—"}</td>
                        <td className="max-w-[160px] truncate px-3 py-1 text-gray-600" title={tx.check_description ?? ""}>{tx.check_description ?? "—"}</td>
                        <td className="max-w-[90px] truncate px-3 py-1"><CD2Cell v={tx.check_description_2} /></td>
                        <td className="max-w-[90px] truncate px-3 py-1"><CD3Cell v={tx.check_description_3} /></td>
                        <td className="max-w-[120px] truncate px-3 py-1 text-gray-600" title={tx.vendor ?? ""}>{tx.vendor ?? "—"}</td>
                        <td className={`px-3 py-1 text-right font-mono whitespace-nowrap ${mvCls(tx.movement)}`}>{fmt(tx.movement)}</td>
                        <td className="px-3 py-1">
                          {(() => {
                            const splits =
                              (normVendor ? splitsMap.get(`vendor:${normVendor}`) : undefined) ??
                              (tx.check_description_3 ? splitsMap.get(`description3:${tx.check_description_3}`) : undefined);
                            if (splits && splits.length > 0) {
                              return <SplitDisplay splits={splits} />;
                            }
                            return tx.cost_center_name
                              ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-800 text-[10px] font-medium">{tx.cost_center_name}</span>
                              : <span className="text-gray-400">—</span>;
                          })()}
                        </td>
                        <td
                          className="px-3 py-1 text-[10px] text-gray-400 whitespace-nowrap"
                          title={tx.updated_at ? `CC last assigned: ${new Date(tx.updated_at).toLocaleString()}` : undefined}
                        >
                          {tx.updated_at
                            ? new Date(tx.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                            : "—"}
                        </td>
                        <td className="px-3 py-1">
                          <OpBadge
                            isOp={(tx.operational_pct ?? 100) > 0}
                            busy={opBusy.has(tx.id)}
                            onToggle={() => handleToggleOp(tx.id, (tx.operational_pct ?? 100) === 0)}
                          />
                        </td>
                        <td className="px-3 py-1">
                          <div className="flex items-center gap-1.5">
                            {assignValue && (
                              <button
                                onClick={() => setEditingTx(tx)}
                                className="flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 whitespace-nowrap"
                              >
                                <Percent size={9} />
                                Edit alloc.
                              </button>
                            )}
                            {unassigning === tx.id ? (
                              <span className="flex items-center gap-1 text-[10px]">
                                <span className="text-red-600 font-medium">Remove?</span>
                                <button
                                  onClick={() => handleUnassignSingle(tx.id)}
                                  disabled={unassignBusy}
                                  className="rounded px-1.5 py-0.5 bg-red-600 text-white text-[10px] hover:bg-red-700 disabled:opacity-40"
                                >Yes</button>
                                <button
                                  onClick={() => setUnassigning(null)}
                                  className="rounded px-1.5 py-0.5 border border-gray-200 text-gray-500 text-[10px] hover:bg-gray-50"
                                >No</button>
                              </span>
                            ) : (
                              <button
                                onClick={() => setUnassigning(tx.id)}
                                title="Unassign this transaction"
                                className="rounded border border-gray-100 px-1.5 py-0.5 text-[10px] text-red-400 hover:border-red-200 hover:text-red-600 whitespace-nowrap"
                              >Unassign</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>
        );
      })}

      {editingTx && (
        <SplitEditor
          assignType={editAssignType}
          assignValue={editAssignValue}
          displayName={editAssignValue}
          txCount={1}
          costCenters={costCenters}
          onClose={() => setEditingTx(null)}
          onSaved={() => { setEditingTx(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Conflict detail cell ─────────────────────────────────────────────────────

function ConflictDetailCell({ tx }: { tx: ConflictTx }) {
  const typeColor = tx.conflict_type === "overassigned"
    ? "bg-red-50 border-red-200 text-red-700"
    : "bg-gray-50 border-gray-200 text-gray-600";
  const typeLabel = tx.conflict_type === "overassigned"
    ? `Overassigned (${tx.total_matched_percentage.toFixed(0)}%)`
    : `Underassigned (${tx.total_matched_percentage.toFixed(0)}%)`;

  return (
    <div className="space-y-1.5 min-w-[200px]">
      <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${typeColor}`}>
        {typeLabel}
      </span>
      {tx.matched_rules.map((mr: MatchedRuleProposal) => (
        <div key={mr.rule_id} className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5">
          <div className="flex items-center gap-1 mb-1">
            <Percent size={9} className="text-gray-400 shrink-0" />
            <span className="text-[10px] font-semibold text-gray-700 truncate">{mr.rule_name}</span>
            <span className="text-[10px] text-gray-400 ml-auto">{mr.rule_total_percentage}%</span>
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
            {mr.allocations.map((a) => (
              <span key={a.cost_center_id} className="text-[10px] text-gray-600 whitespace-nowrap">
                <span className="font-medium">{a.percentage}%</span> {a.cc_name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Conflict (Pending) Tab ───────────────────────────────────────────────────

function ConflictTab({ costCenters, branches, glFilter, txSearch }: { costCenters: CostCenter[]; branches: string[]; glFilter: string[]; txSearch: string }) {
  const [groups, setGroups] = useState<ConflictGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [rowAssign, setRowAssign] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCcId, setBulkCcId] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [rowOp, setRowOp] = useState<Record<string, boolean>>({});
  const [bulkOp, setBulkOp] = useState(true);
  const [conflictFilter, setConflictFilter] = useState<"all" | "underassigned" | "overassigned">("all");

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch(`/api/conflicts${branchParams(branches)}`);
      if (res.ok) setGroups(await res.json());
    } finally { setLoading(false); }
  }, [branches]);

  useEffect(() => { load(); }, [load]);

  const totalCount = groups.reduce((s, g) => s + g.transactions.length, 0);

  const filteredGroups: ConflictGroup[] = conflictFilter === "all"
    ? groups
    : groups.map((g) => ({
        ...g,
        transactions: g.transactions.filter((t) => t.conflict_type === conflictFilter),
      })).filter((g) => g.transactions.length > 0);

  const visibleGroups = useMemo(() =>
    filteredGroups.filter((g) =>
      (glFilter.length === 0 || glFilter.includes(g.gl_code)) &&
      (!txSearch || g.transactions.some((tx) => txMatchesSearch(tx, txSearch)))
    ), [filteredGroups, glFilter, txSearch]);

  const filteredCount = visibleGroups.reduce((s, g) => s + g.transactions.length, 0);

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    visibleGroups.forEach((g) => {
      const txs = txSearch ? g.transactions.filter((tx) => txMatchesSearch(tx, txSearch)) : g.transactions;
      txs.forEach((tx) => ids.add(tx.id));
    });
    return ids;
  }, [visibleGroups, txSearch]);

  const visibleSelected = useMemo(
    () => [...selected].filter((id) => allVisibleIds.has(id)),
    [selected, allVisibleIds]
  );

  const underCount = groups.reduce((s, g) => s + g.transactions.filter((t) => t.conflict_type === "underassigned").length, 0);
  const overCount = groups.reduce((s, g) => s + g.transactions.filter((t) => t.conflict_type === "overassigned").length, 0);

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }
  function toggleRow(id: string) {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleGroupRows(visibleIds: string[]) {
    const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const s = new Set(prev);
      if (allSel) visibleIds.forEach((id) => s.delete(id));
      else visibleIds.forEach((id) => s.add(id));
      return s;
    });
  }

  async function resolveRows(txIds: string[], ccId: string, is_operational = true) {
    if (!ccId) return;
    setSaving(true); setMsg("");
    try {
      const res = await fetch("/api/conflicts/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_ids: txIds, cost_center_id: ccId, is_operational }),
      });
      if (!res.ok) { const j = await res.json(); setMsg(`Error: ${j.error}`); return; }
      setSelected(new Set()); setBulkCcId(""); setRowAssign({}); setRowOp({}); setBulkOp(true); load();
    } finally { setSaving(false); }
  }

  if (loading) return (
    <div className="py-10 text-center text-gray-400">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
    </div>
  );
  if (totalCount === 0) return (
    <div className="rounded-xl border border-green-100 bg-green-50 px-6 py-8 text-center">
      <CheckCircle size={20} className="mx-auto mb-2 text-green-500" />
      <p className="text-sm font-medium text-green-700">
        No pending conflicts{branches.length > 0 ? " in selected branches" : ""}.
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Sub-filter: All / Underassigned / Overassigned */}
      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 w-fit">
        {(["all", "underassigned", "overassigned"] as const).map((f) => {
          const count = f === "all" ? totalCount : f === "underassigned" ? underCount : overCount;
          return (
            <button key={f} onClick={() => { setConflictFilter(f); setSelected(new Set()); }}
              className={[
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                conflictFilter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
              ].join(" ")}>
              {f === "all" ? "All" : f === "underassigned" ? "Underassigned" : "Overassigned"}{" "}
              <span className="ml-0.5 text-gray-400">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <AlertTriangle size={14} className="shrink-0 text-gray-400" />
        <span className="text-xs text-gray-700 font-medium">
          {filteredCount} conflict{filteredCount !== 1 ? "s" : ""}{visibleSelected.length > 0 && ` · ${visibleSelected.length} selected`}
        </span>
        {visibleSelected.length > 0 && (
          <>
            <select value={bulkCcId} onChange={(e) => setBulkCcId(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none">
              <option value="">Assign to…</option>
              {costCenters.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}
            </select>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={!bulkOp}
                onChange={(e) => setBulkOp(!e.target.checked)}
                className="h-3 w-3 accent-red-500"
              />
              <span className="text-[10px] text-gray-600">Non-Op</span>
            </label>
            <button onClick={() => resolveRows(visibleSelected, bulkCcId, bulkOp)} disabled={!bulkCcId || saving}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40">
              {saving ? "Saving…" : `Assign ${visibleSelected.length}`}
            </button>
          </>
        )}
      </div>

      {msg && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{msg}</p>}

      {visibleGroups.map((group) => {
        const key = group.gl_code;
        const isCollapsed = collapsedGroups.has(key);
        const visibleTxs = txSearch
          ? group.transactions.filter((tx) => txMatchesSearch(tx, txSearch))
          : group.transactions;
        const visibleIds = visibleTxs.map((t) => t.id);
        const groupAllSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        return (
          <div key={key} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex cursor-pointer items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2.5 hover:bg-gray-100"
              onClick={() => toggleGroup(key)}>
              <input type="checkbox" checked={groupAllSel} onChange={() => toggleGroupRows(visibleIds)}
                onClick={(e) => e.stopPropagation()} className="h-3.5 w-3.5 accent-blue-600 rounded" />
              {isCollapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
              <span className="text-xs font-semibold font-mono text-gray-800">{group.gl_code}</span>
              <span className="text-xs text-gray-500">{group.gl_name}</span>
              <span className="ml-auto text-xs text-gray-500 font-medium">{group.transactions.length} conflict{group.transactions.length !== 1 ? "s" : ""}{txSearch && visibleTxs.length !== group.transactions.length ? ` · ${visibleTxs.length} visible` : ""}</span>
            </div>
            {!isCollapsed && (
              <div className="overflow-auto max-h-[500px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-gray-400">
                    <th className="w-7 px-2 py-1" />
                    <th className="px-2 py-1 font-medium">Month</th>
                    <th className="px-2 py-1 font-medium">Branch</th>
                    <th className="px-2 py-1 font-medium">Description</th>
                    <th className="px-2 py-1 font-medium">Check Desc 2</th>
                    <th className="px-2 py-1 font-medium">Check Desc 3</th>
                    <th className="px-2 py-1 font-medium">Vendor</th>
                    <th className="px-2 py-1 text-right font-medium">Movement</th>
                    <th className="px-2 py-1 font-medium">Conflict Details</th>
                    <th className="px-2 py-1 font-medium">Assign to</th>
                    <th className="w-8 px-1 py-1 text-center font-medium">Op</th>
                    <th className="w-14 px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {visibleTxs.map((tx) => (
                    <tr key={tx.id} className={`border-b border-gray-50 hover:bg-gray-50 ${selected.has(tx.id) ? "bg-blue-50/40" : ""}`}>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={selected.has(tx.id)} onChange={() => toggleRow(tx.id)}
                          className="h-3.5 w-3.5 accent-blue-600 rounded" />
                      </td>
                      <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{tx.month ?? "—"}</td>
                      <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{tx.branch ?? "—"}</td>
                      <td className="max-w-[130px] truncate px-2 py-1 text-gray-600" title={tx.check_description ?? ""}>{tx.check_description ?? "—"}</td>
                      <td className="max-w-[90px] truncate px-2 py-1"><CD2Cell v={tx.check_description_2} /></td>
                      <td className="max-w-[90px] truncate px-2 py-1"><CD3Cell v={tx.check_description_3} /></td>
                      <td className="max-w-[100px] truncate px-2 py-1 text-gray-600" title={tx.vendor ?? ""}>{tx.vendor ?? "—"}</td>
                      <td className={`px-2 py-1 text-right font-mono whitespace-nowrap ${mvCls(tx.movement)}`}>{fmt(tx.movement)}</td>
                      <td className="px-2 py-1">
                        <ConflictDetailCell tx={tx} />
                      </td>
                      <td className="px-2 py-1">
                        <select value={rowAssign[tx.id] ?? ""} onChange={(e) => setRowAssign((prev) => ({ ...prev, [tx.id]: e.target.value }))}
                          className="rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none">
                          <option value="">Choose…</option>
                          {costCenters.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1 text-center">
                        <label className="inline-flex items-center cursor-pointer" title={rowOp[tx.id] !== false ? "Operational" : "Non-Operational"}>
                          <input
                            type="checkbox"
                            checked={rowOp[tx.id] === false}
                            onChange={(e) => setRowOp((prev) => ({ ...prev, [tx.id]: !e.target.checked }))}
                            className="h-3 w-3 accent-red-500"
                          />
                        </label>
                      </td>
                      <td className="px-2 py-1">
                        <button onClick={() => resolveRows([tx.id], rowAssign[tx.id] ?? "", rowOp[tx.id] ?? true)}
                          disabled={!rowAssign[tx.id] || saving}
                          className="rounded-lg bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30">
                          Assign
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Conflict Resolved Tab ────────────────────────────────────────────────────

function ConflictResolvedTab({
  costCenters, branches, glFilter, txSearch, ccFilter,
}: {
  costCenters: CostCenter[];
  branches: string[];
  glFilter: string[];
  txSearch: string;
  ccFilter: string[];
}) {
  const [groups, setGroups] = useState<ResolvedConflictGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [reopening, setReopening] = useState<string | null>(null);
  const [rowCcId, setRowCcId] = useState<Record<string, string>>({});
  const [rowOpResolved, setRowOpResolved] = useState<Record<string, boolean>>({});
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [opBusy, setOpBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch(`/api/conflicts/resolved${branchParams(branches)}`);
      if (res.ok) {
        const data = await res.json() as ResolvedConflictGroup[];
        setGroups(data);
        const initial: Record<string, string> = {};
        for (const g of data) for (const tx of g.transactions) {
          if (tx.cost_center_id) initial[tx.id] = tx.cost_center_id;
        }
        setRowCcId(initial);
      }
    } finally { setLoading(false); }
  }, [branches]);

  useEffect(() => { load(); }, [load]);

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }

  async function handleReopen(txId: string) {
    setReopening(txId); setMsg("");
    try {
      const res = await fetch("/api/conflicts/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: txId }),
      });
      if (!res.ok) { const j = await res.json(); setMsg(`Error: ${j.error}`); return; }
      load();
    } finally { setReopening(null); }
  }

  async function handleReassign(txId: string, ccId: string, is_operational = true) {
    if (!ccId) return;
    setReassigning(txId); setMsg("");
    try {
      const res = await fetch("/api/conflicts/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: txId, cost_center_id: ccId, is_operational }),
      });
      if (!res.ok) { const j = await res.json(); setMsg(`Error: ${j.error}`); return; }
      load();
    } finally { setReassigning(null); }
  }

  async function handleToggleOp(txId: string, isOp: boolean) {
    setOpBusy((prev) => new Set([...prev, txId]));
    try {
      const err = await apiSetOperational([txId], isOp);
      if (err) { setMsg(`Error: ${err}`); return; }
      await load();
    } finally {
      setOpBusy((prev) => { const s = new Set(prev); s.delete(txId); return s; });
    }
  }

  async function handleBulkSetOp(isOp: boolean) {
    if (!visibleSelected.length) return;
    setBulkBusy(true); setMsg("");
    try {
      const err = await apiSetOperational(visibleSelected, isOp);
      if (err) { setMsg(`Error: ${err}`); return; }
      setSelected(new Set());
      await load();
    } finally { setBulkBusy(false); }
  }

  function toggleRow(id: string) {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleGroupRows(visibleIds: string[]) {
    const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const s = new Set(prev);
      if (allSel) visibleIds.forEach((id) => s.delete(id));
      else visibleIds.forEach((id) => s.add(id));
      return s;
    });
  }

  const allGroupsCount = groups.reduce((s, g) => s + g.transactions.length, 0);

  const { visibleGroups, visibleTxsMap } = useMemo(() => {
    const visibleGroups: ResolvedConflictGroup[] = [];
    const visibleTxsMap = new Map<string, ResolvedConflictGroup["transactions"]>();
    for (const g of groups) {
      if (glFilter.length > 0 && !glFilter.includes(g.gl_code)) continue;
      const txs = g.transactions.filter((tx) =>
        (!txSearch || txMatchesSearch(tx, txSearch)) &&
        (ccFilter.length === 0 || (tx.resolved_cc?.name != null && ccFilter.includes(tx.resolved_cc.name)))
      );
      if (txs.length > 0) {
        visibleGroups.push(g);
        visibleTxsMap.set(g.gl_code, txs);
      }
    }
    return { visibleGroups, visibleTxsMap };
  }, [groups, glFilter, txSearch, ccFilter]);

  let totalCount = 0;
  for (const txs of visibleTxsMap.values()) totalCount += txs.length;

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const txs of visibleTxsMap.values()) txs.forEach((tx) => ids.add(tx.id));
    return ids;
  }, [visibleTxsMap]);

  const visibleSelected = useMemo(
    () => [...selected].filter((id) => allVisibleIds.has(id)),
    [selected, allVisibleIds]
  );

  if (loading) return (
    <div className="py-10 text-center text-gray-400">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
    </div>
  );
  if (allGroupsCount === 0) return (
    <p className="py-10 text-center text-sm text-gray-400">
      No resolved conflicts{branches.length > 0 ? " in selected branches" : ""}.
    </p>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <span className="text-xs font-medium text-gray-600">
          {totalCount} resolved conflict{totalCount !== 1 ? "s" : ""}
          {visibleSelected.length > 0 && ` · ${visibleSelected.length} selected`}
        </span>
        {visibleSelected.length > 0 && (
          <>
            <button
              onClick={() => handleBulkSetOp(true)}
              disabled={bulkBusy}
              className="rounded-lg bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-200 disabled:opacity-40"
            >
              Set Operational
            </button>
            <button
              onClick={() => handleBulkSetOp(false)}
              disabled={bulkBusy}
              className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-40"
            >
              Set Non-Op
            </button>
          </>
        )}
      </div>
      {msg && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{msg}</p>}

      {visibleGroups.map((group) => {
        const key = group.gl_code;
        const isCollapsed = collapsedGroups.has(key);
        const visibleTxs = visibleTxsMap.get(key) ?? [];
        const visibleIds = visibleTxs.map((t) => t.id);
        const groupAllSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        return (
          <div key={key} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex cursor-pointer items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2.5 hover:bg-gray-100"
              onClick={() => toggleGroup(key)}>
              <input
                type="checkbox" checked={groupAllSel}
                onChange={() => toggleGroupRows(visibleIds)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 accent-blue-600 rounded"
              />
              {isCollapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
              <span className="text-xs font-semibold font-mono text-gray-800">{group.gl_code}</span>
              <span className="text-xs text-gray-500">{group.gl_name}</span>
              <span className="ml-auto text-xs text-gray-400">{group.transactions.length} resolved{(txSearch || ccFilter.length > 0) && visibleTxs.length !== group.transactions.length ? ` · ${visibleTxs.length} visible` : ""}</span>
            </div>

            {!isCollapsed && (
              <div className="overflow-auto max-h-[500px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-gray-400">
                    <th className="w-7 px-2 py-1" />
                    <th className="px-3 py-1 font-medium">Month</th>
                    <th className="px-3 py-1 font-medium">Branch</th>
                    <th className="px-3 py-1 font-medium">Description</th>
                    <th className="px-3 py-1 font-medium">Check Desc 2</th>
                    <th className="px-3 py-1 font-medium">Check Desc 3</th>
                    <th className="px-3 py-1 font-medium">Vendor</th>
                    <th className="px-3 py-1 text-right font-medium">Movement</th>
                    <th className="px-3 py-1 font-medium">Was conflicting</th>
                    <th className="px-3 py-1 font-medium">Assigned CC</th>
                    <th className="px-3 py-1 font-medium">Status</th>
                    <th className="px-3 py-1 font-medium">Resolved at</th>
                    <th className="px-3 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {visibleTxs.map((tx) => {
                    const currentCcId = rowCcId[tx.id] ?? tx.cost_center_id ?? "";
                    const resolvedCcId = tx.cost_center_id ?? "";
                    const isDirty = currentCcId !== resolvedCcId && currentCcId !== "";

                    return (
                      <tr key={tx.id} className={`border-b border-gray-50 hover:bg-gray-50 ${selected.has(tx.id) ? "bg-blue-50/40" : ""}`}>
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={selected.has(tx.id)}
                            onChange={() => toggleRow(tx.id)}
                            className="h-3.5 w-3.5 accent-blue-600 rounded" />
                        </td>
                        <td className="px-3 py-1 text-gray-700 whitespace-nowrap">{tx.month ?? "—"}</td>
                        <td className="px-3 py-1 text-gray-700 whitespace-nowrap">{tx.branch ?? "—"}</td>
                        <td className="max-w-[120px] truncate px-3 py-1 text-gray-600" title={tx.check_description ?? ""}>{tx.check_description ?? "—"}</td>
                        <td className="max-w-[80px] truncate px-3 py-1"><CD2Cell v={tx.check_description_2} /></td>
                        <td className="max-w-[80px] truncate px-3 py-1"><CD3Cell v={tx.check_description_3} /></td>
                        <td className="max-w-[90px] truncate px-3 py-1 text-gray-600" title={tx.vendor ?? ""}>{tx.vendor ?? "—"}</td>
                        <td className={`px-3 py-1 text-right font-mono whitespace-nowrap ${mvCls(tx.movement)}`}>{fmt(tx.movement)}</td>
                        <td className="px-3 py-1">
                          {tx.matched_rules.length > 0 ? (
                            <div className="space-y-0.5">
                              {tx.matched_rules.map((mr) => (
                                <div key={mr.rule_id} className="text-[10px] text-gray-700">
                                  <span className="font-medium">{mr.rule_name}</span>
                                  <span className="text-gray-400 ml-1">({mr.rule_total_percentage}%)</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[10px] text-gray-400">Legacy snapshot</span>
                          )}
                        </td>
                        <td className="px-3 py-1">
                          <div className="flex items-center gap-1.5">
                            <select
                              value={currentCcId}
                              onChange={(e) => setRowCcId((prev) => ({ ...prev, [tx.id]: e.target.value }))}
                              className="rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none max-w-[130px]"
                              disabled={reassigning === tx.id}
                            >
                              <option value="">Choose…</option>
                              {costCenters.map((cc) => (
                                <option key={cc.id} value={cc.id}>{cc.name}</option>
                              ))}
                            </select>
                            {isDirty && (
                              <>
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={!(rowOpResolved[tx.id] ?? true)}
                                    onChange={(e) => setRowOpResolved((prev) => ({ ...prev, [tx.id]: !e.target.checked }))}
                                    className="h-3 w-3 accent-red-500"
                                  />
                                  <span className="text-[10px] text-gray-400">Non-Op</span>
                                </label>
                                <button
                                  onClick={() => handleReassign(tx.id, currentCcId, rowOpResolved[tx.id] ?? true)}
                                  disabled={reassigning === tx.id}
                                  className="rounded-lg bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
                                >
                                  {reassigning === tx.id ? "…" : "Save"}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-1">
                          <OpBadge
                            isOp={(tx.operational_pct ?? 100) > 0}
                            busy={opBusy.has(tx.id)}
                            onToggle={() => handleToggleOp(tx.id, (tx.operational_pct ?? 100) === 0)}
                          />
                        </td>
                        <td className="px-3 py-1 text-gray-400 whitespace-nowrap">
                          {tx.resolved_at ? new Date(tx.resolved_at).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-3 py-1">
                          <button
                            onClick={() => handleReopen(tx.id)}
                            disabled={reopening === tx.id}
                            title="Reopen conflict"
                            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-gray-500 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                          >
                            <RotateCcw size={11} /> Reopen
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = "unassigned" | "assigned-by-rule" | "manual" | "conflict" | "conflict-resolved";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "unassigned",        label: "Unassigned",        icon: AlertTriangle },
  { id: "assigned-by-rule",  label: "Assigned by Rule",  icon: Layers },
  { id: "manual",            label: "Manual Assigned",   icon: UserCheck },
  { id: "conflict",          label: "Conflict",          icon: AlertTriangle },
  { id: "conflict-resolved", label: "Conflict Resolved", icon: ClipboardList },
];

export default function CCAssignmentPage() {
  const { activeBranches } = useActiveBranches();
  const [tab, setTab] = useState<Tab>("unassigned");
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [glFilter, setGlFilter] = useState<string[]>([]);
  const [allGlCodes, setAllGlCodes] = useState<string[]>([]);
  const [ccFilter, setCcFilter] = useState<string[]>([]);
  const [txSearch, setTxSearch] = useState("");
  // Effective branches = intersection of global filter and local selection.
  // useMemo ensures this produces a stable reference when inputs haven't changed,
  // preventing the child tabs' useCallback/useEffect from re-firing unnecessarily.
  const effectiveBranches = useMemo(
    () => mergeWithGlobal(activeBranches, branches),
    [activeBranches, branches]
  );

  useEffect(() => {
    fetch("/api/cost-centers")
      .then((r) => r.json())
      .then((data: CostCenter[]) => setCostCenters(data))
      .catch(console.error);

    fetch("/api/transactions/filter-options")
      .then((r) => r.json())
      .then((d: { branch: string[]; gl_code: string[] }) => {
        setAllBranches(d.branch ?? []);
        setAllGlCodes(d.gl_code ?? []);
      })
      .catch(console.error);
  }, []);

  const hasFilters = branches.length > 0 || glFilter.length > 0 || ccFilter.length > 0 || txSearch !== "";
  const ccFilterOptions = costCenters.map((cc) => cc.name);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Cost Center Assignment</h2>
        <p className="text-sm text-gray-500">Assign, override, and resolve cost center conflicts.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ReportFilter label="Branch" options={allBranches} selected={branches} onChange={setBranches} />
        <ReportFilter label="GL Code" options={allGlCodes} selected={glFilter} onChange={setGlFilter} />
        {["assigned-by-rule", "manual", "conflict-resolved"].includes(tab) && (
          <ReportFilter label="Cost Center" options={ccFilterOptions} selected={ccFilter} onChange={setCcFilter} />
        )}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={txSearch}
            onChange={(e) => setTxSearch(e.target.value)}
            placeholder="Search transactions…"
            className="h-8 rounded-lg border border-gray-200 bg-white pl-8 pr-8 text-xs text-gray-700 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none w-52"
          />
          {txSearch && (
            <button onClick={() => setTxSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={12} />
            </button>
          )}
        </div>
        {hasFilters && (
          <button
            onClick={() => { setBranches([]); setGlFilter([]); setCcFilter([]); setTxSearch(""); }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 w-fit flex-wrap">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={[
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.id
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700",
              ].join(" ")}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "unassigned"        && <UnassignedTab costCenters={costCenters} branches={effectiveBranches} glFilter={glFilter} txSearch={txSearch} />}
      {tab === "assigned-by-rule"  && <AssignedByRuleTab costCenters={costCenters} branches={effectiveBranches} glFilter={glFilter} txSearch={txSearch} ccFilter={ccFilter} />}
      {tab === "manual"            && <ManualTab branches={effectiveBranches} costCenters={costCenters} glFilter={glFilter} txSearch={txSearch} ccFilter={ccFilter} />}
      {tab === "conflict"          && <ConflictTab costCenters={costCenters} branches={effectiveBranches} glFilter={glFilter} txSearch={txSearch} />}
      {tab === "conflict-resolved" && <ConflictResolvedTab costCenters={costCenters} branches={effectiveBranches} glFilter={glFilter} txSearch={txSearch} ccFilter={ccFilter} />}
    </div>
  );
}
