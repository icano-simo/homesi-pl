"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, RefreshCw, X, AlertTriangle } from "lucide-react";
import { CC_FIELDS, operatorsForField, defaultOperator, getFieldKind, defaultValue } from "@/lib/cost-center-constants";
import type { SplitRuleWithDetails, SplitRuleCondition, SplitRuleAllocation } from "@/types";

// ─── Local draft types ─────────────────────────────────────────────────────────

type DraftCondition = {
  key: string;
  sequence: number;
  logic_connector: "AND" | "OR" | null;
  field: string;
  operator: string;
  value: string;
  opens_group: boolean;
  closes_group: boolean;
};

type DraftAllocation = {
  key: string;
  cost_center_id: string;
  percentage: string;
};

type CCOption = { id: string; name: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function blankCondition(seq: number): DraftCondition {
  const field = CC_FIELDS[0].value;
  return {
    key: uid(),
    sequence: seq,
    logic_connector: seq === 1 ? null : "AND",
    field,
    operator: defaultOperator(field),
    value: defaultValue(field),
    opens_group: false,
    closes_group: false,
  };
}

function blankAllocation(): DraftAllocation {
  return { key: uid(), cost_center_id: "", percentage: "" };
}

function sumPct(allocations: DraftAllocation[]): number {
  return allocations.reduce((s, a) => s + (Number(a.percentage) || 0), 0);
}

function conditionSummary(conditions: SplitRuleCondition[]): string {
  if (conditions.length === 0) return "No conditions";
  const sorted = [...conditions].sort((a, b) => a.sequence - b.sequence);
  let out = "";
  sorted.forEach((c, i) => {
    const connector = i === 0 ? "" : ` ${c.logic_connector ?? "AND"} `;
    out += connector;
    if (c.opens_group) out += "(";
    out += `${c.field} ${c.operator} "${c.value}"`;
    if (c.closes_group) out += ")";
  });
  return out;
}

function validateParens(conditions: DraftCondition[]): string | null {
  let depth = 0;
  const sorted = [...conditions].sort((a, b) => a.sequence - b.sequence);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.opens_group) depth++;
    if (c.closes_group) {
      depth--;
      if (depth < 0) return `Condition ${i + 1} closes a parenthesis that was never opened`;
    }
  }
  if (depth > 0) return `${depth} opening parenthes${depth > 1 ? "es" : "is"} never closed`;
  return null;
}

function allocationSummary(allocations: SplitRuleAllocation[], ccNames: Map<string, string>): string {
  if (allocations.length === 0) return "No allocations";
  return allocations
    .slice()
    .sort((a, b) => a.display_order - b.display_order)
    .map((a) => `${ccNames.get(a.cost_center_id) ?? a.cost_center_id} ${a.percentage}%`)
    .join(" · ");
}

// ─── Conditions editor ────────────────────────────────────────────────────────

function ConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: DraftCondition[];
  onChange: (next: DraftCondition[]) => void;
}) {
  function addCondition() {
    onChange([...conditions, blankCondition(conditions.length + 1)]);
  }

  function updateCondition(key: string, patch: Partial<DraftCondition>) {
    onChange(conditions.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeCondition(key: string) {
    const filtered = conditions.filter((c) => c.key !== key);
    onChange(filtered.map((c, i) => ({ ...c, sequence: i + 1 })));
  }

  return (
    <div className="space-y-2">
      {conditions.map((cond, idx) => {
        const ops = operatorsForField(cond.field);
        return (
          <div key={cond.key} className="flex items-center gap-2 flex-wrap">
            {/* ( toggle — opens parenthesis before this condition */}
            <button
              onClick={() => updateCondition(cond.key, { opens_group: !cond.opens_group })}
              title="Insert ( before this condition"
              className={`shrink-0 w-5 text-center text-xs py-0.5 rounded font-mono transition-colors ${
                cond.opens_group
                  ? "text-blue-600 bg-blue-100 border border-blue-300"
                  : "text-gray-300 hover:text-blue-500 hover:bg-blue-50 border border-transparent"
              }`}
            >
              (
            </button>
            {idx === 0 ? (
              <span className="text-xs text-gray-400 w-10 shrink-0">WHERE</span>
            ) : (
              <select
                value={cond.logic_connector ?? "AND"}
                onChange={(e) =>
                  updateCondition(cond.key, { logic_connector: e.target.value as "AND" | "OR" })
                }
                className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-1 py-0.5 w-14 shrink-0"
              >
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
            )}
            <select
              value={cond.field}
              onChange={(e) => {
                const field = e.target.value;
                updateCondition(cond.key, { field, operator: defaultOperator(field), value: defaultValue(field) });
              }}
              className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-1 py-0.5 min-w-[110px]"
            >
              {CC_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select
              value={cond.operator}
              onChange={(e) => updateCondition(cond.key, { operator: e.target.value })}
              className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-1 py-0.5 min-w-[120px]"
            >
              {ops.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {getFieldKind(cond.field) === "boolean" ? (
              <select
                value={cond.value}
                onChange={(e) => updateCondition(cond.key, { value: e.target.value })}
                className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-1 py-0.5 min-w-[80px]"
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            ) : (
              <input
                type="text"
                value={cond.value}
                onChange={(e) => updateCondition(cond.key, { value: e.target.value })}
                placeholder="value"
                className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-2 py-0.5 min-w-[100px] flex-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            )}
            {/* ) toggle — closes parenthesis after this condition */}
            <button
              onClick={() => updateCondition(cond.key, { closes_group: !cond.closes_group })}
              title="Insert ) after this condition"
              className={`shrink-0 w-5 text-center text-xs py-0.5 rounded font-mono transition-colors ${
                cond.closes_group
                  ? "text-blue-600 bg-blue-100 border border-blue-300"
                  : "text-gray-300 hover:text-blue-500 hover:bg-blue-50 border border-transparent"
              }`}
            >
              )
            </button>
            <button
              onClick={() => removeCondition(cond.key)}
              className="text-gray-400 hover:text-red-500 shrink-0"
              title="Remove condition"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <button
        onClick={addCondition}
        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 mt-1"
      >
        <Plus size={12} /> Add condition
      </button>
    </div>
  );
}

// ─── Allocations editor ───────────────────────────────────────────────────────

function AllocationsEditor({
  allocations,
  costCenters,
  onChange,
}: {
  allocations: DraftAllocation[];
  costCenters: CCOption[];
  onChange: (next: DraftAllocation[]) => void;
}) {
  const total = sumPct(allocations);
  const remaining = +(100 - total).toFixed(2);

  function addRow() {
    onChange([...allocations, blankAllocation()]);
  }

  function updateRow(key: string, patch: Partial<DraftAllocation>) {
    onChange(allocations.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }

  function removeRow(key: string) {
    onChange(allocations.filter((a) => a.key !== key));
  }

  return (
    <div className="space-y-2">
      {allocations.map((alloc) => {
        const pctNum = Number(alloc.percentage);
        const pctInvalid = !alloc.percentage || pctNum <= 0;
        return (
          <div key={alloc.key} className="flex items-center gap-2">
            <select
              value={alloc.cost_center_id}
              onChange={(e) => updateRow(alloc.key, { cost_center_id: e.target.value })}
              className="text-xs border border-gray-300 bg-white text-gray-800 rounded px-1 py-0.5 flex-1"
            >
              <option value="">— select cost center —</option>
              {costCenters.map((cc) => (
                <option key={cc.id} value={cc.id}>{cc.name}</option>
              ))}
            </select>
            <div className="flex items-center gap-1 shrink-0">
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={alloc.percentage}
                onChange={(e) => updateRow(alloc.key, { percentage: e.target.value })}
                placeholder="0"
                className={`text-xs border rounded px-2 py-0.5 w-20 text-right ${
                  pctInvalid
                    ? "border-red-400 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-gray-800"
                }`}
              />
              <span className="text-xs text-gray-500">%</span>
            </div>
            <button
              onClick={() => removeRow(alloc.key)}
              className="text-gray-400 hover:text-red-500 shrink-0"
              title="Remove this allocation"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <div className="flex items-center justify-between">
        <button
          onClick={addRow}
          className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
        >
          <Plus size={12} /> Add allocation
        </button>
        <span
          className={`text-xs ${
            Math.abs(total - 100) < 0.01
              ? "text-green-600"
              : total > 100
              ? "text-red-600"
              : "text-gray-500"
          }`}
        >
          {total.toFixed(2)}% / 100%
          {Math.abs(total - 100) > 0.01 && remaining > 0 && ` (${remaining}% remaining)`}
        </span>
      </div>
    </div>
  );
}

// ─── Rule form (create or edit) ───────────────────────────────────────────────

function RuleForm({
  initial,
  costCenters,
  onSave,
  onCancel,
}: {
  initial?: SplitRuleWithDetails;
  costCenters: CCOption[];
  onSave: (rule: SplitRuleWithDetails) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [isOperational, setIsOperational] = useState(initial?.is_operational ?? true);
  const [conditions, setConditions] = useState<DraftCondition[]>(() => {
    if (!initial || initial.conditions.length === 0) return [blankCondition(1)];
    return initial.conditions
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((c) => ({ ...c, key: uid() }));
  });
  const [allocations, setAllocations] = useState<DraftAllocation[]>(() => {
    if (!initial || initial.allocations.length === 0) return [blankAllocation()];
    return initial.allocations
      .slice()
      .sort((a, b) => a.display_order - b.display_order)
      .map((a) => ({ key: uid(), cost_center_id: a.cost_center_id, percentage: String(a.percentage) }));
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function sanitizeApiError(raw: string | undefined): string {
    if (!raw) return "Save failed";
    if (raw.includes("check constraint") || raw.includes("percentage_check"))
      return "One or more allocation percentages are invalid — ensure all rows are greater than 0% and sum to 100%.";
    if (raw.includes("violates"))
      return "A database constraint was violated. Check that all fields are filled in correctly.";
    return raw;
  }

  async function handleSave() {
    setErr("");
    if (!name.trim()) { setErr("Name is required"); return; }
    if (allocations.length === 0) { setErr("At least one allocation is required"); return; }
    if (allocations.some((a) => !a.cost_center_id)) { setErr("All allocations need a cost center selected"); return; }
    if (allocations.some((a) => !a.percentage || Number(a.percentage) <= 0)) {
      setErr("Remove empty rows or assign a percentage greater than 0 to each allocation");
      return;
    }
    const total = sumPct(allocations);
    if (Math.abs(total - 100) > 0.01) { setErr(`Allocations must sum to 100% (currently ${total.toFixed(2)}%)`); return; }
    if (conditions.some((c) => !c.value.trim())) { setErr("All conditions need a value"); return; }
    const parenErr = validateParens(conditions);
    if (parenErr) { setErr(parenErr); return; }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        conditions: conditions.map((c, i) => ({
          sequence: i + 1,
          logic_connector: i === 0 ? null : c.logic_connector,
          field: c.field,
          operator: c.operator,
          value: c.value,
          opens_group: c.opens_group,
          closes_group: c.closes_group,
        })),
        allocations: allocations.map((a, i) => ({
          cost_center_id: a.cost_center_id,
          percentage: Number(a.percentage),
          display_order: i,
        })),
      };

      if (initial) {
        const [patchRes, condRes, allocRes] = await Promise.all([
          fetch(`/api/split-rules/${initial.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: payload.name, description: payload.description, is_operational: isOperational }),
          }),
          fetch(`/api/split-rules/${initial.id}/conditions`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload.conditions),
          }),
          fetch(`/api/split-rules/${initial.id}/allocations`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload.allocations),
          }),
        ]);
        if (!patchRes.ok || !condRes.ok || !allocRes.ok) {
          const j = await (!patchRes.ok ? patchRes : !condRes.ok ? condRes : allocRes)
            .json()
            .catch(() => ({}));
          setErr(sanitizeApiError(j.error));
          return;
        }
        const getRes = await fetch(`/api/split-rules/${initial.id}`);
        const updated = await getRes.json();
        onSave(updated);
      } else {
        const res = await fetch("/api/split-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, is_operational: isOperational }),
        });
        const json = await res.json();
        if (!res.ok) { setErr(sanitizeApiError(json.error)); return; }
        onSave(json as SplitRuleWithDetails);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4 shadow-sm">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Margin Ops Split"
            className="w-full text-sm border border-gray-300 bg-white text-gray-900 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className="w-full text-sm border border-gray-300 bg-white text-gray-900 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-600">Classification:</span>
        <button
          type="button"
          onClick={() => setIsOperational(!isOperational)}
          className={`text-xs px-3 py-1 rounded-lg border font-medium transition-colors ${
            isOperational
              ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
              : "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
          }`}
        >
          {isOperational ? "Operational" : "Non-Operational"}
        </button>
        <span className="text-[11px] text-gray-400">— affects all transactions matched by this rule</span>
      </div>

      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">
          Conditions
          <span className="ml-2 font-normal text-gray-400">— use ( ) button to group conditions with parentheses</span>
        </div>
        <ConditionsEditor conditions={conditions} onChange={setConditions} />
      </div>

      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">
          CC Allocations <span className="font-normal text-gray-400">(must sum to 100%)</span>
        </div>
        <AllocationsEditor allocations={allocations} costCenters={costCenters} onChange={setAllocations} />
      </div>

      {err && <p className="text-xs text-red-600">{err}</p>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded"
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create rule"}
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-800 px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Rule row (collapsed / expanded) ─────────────────────────────────────────

function RuleRow({
  rule,
  ccNames,
  costCenters,
  vendorManualSplits,
  onUpdate,
  onDelete,
}: {
  rule: SplitRuleWithDetails;
  ccNames: Map<string, string>;
  costCenters: CCOption[];
  vendorManualSplits: Set<string>; // normalized (lowercase) vendor names with active manual splits
  onUpdate: (updated: SplitRuleWithDetails) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Option C: detect vendor conditions that have active manual splits
  const manualOverrides: string[] = [];
  if (vendorManualSplits.size > 0) {
    for (const cond of rule.conditions) {
      if (cond.field !== "vendor") continue;
      const cv = cond.value.toLowerCase();
      for (const vendorKey of vendorManualSplits) {
        let matches = false;
        switch (cond.operator) {
          case "equals":      matches = vendorKey === cv; break;
          case "contains":    matches = vendorKey.includes(cv); break;
          case "starts_with": matches = vendorKey.startsWith(cv); break;
          case "ends_with":   matches = vendorKey.endsWith(cv); break;
        }
        if (matches) { manualOverrides.push(cond.value); break; }
      }
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete rule "${rule.name}"? Transactions matched by this rule will be re-evaluated.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/split-rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "Delete failed");
        return;
      }
      onDelete(rule.id);
    } finally {
      setDeleting(false);
    }
  }

  if (editing) {
    return (
      <RuleForm
        initial={rule}
        costCenters={costCenters}
        onSave={(updated) => { onUpdate(updated); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const sorted = rule.conditions.slice().sort((a, b) => a.sequence - b.sequence);

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 group"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="text-gray-400 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">{rule.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              rule.is_operational ? "bg-green-100 text-green-700" : "bg-red-50 text-red-600"
            }`}>
              {rule.is_operational ? "Op" : "Non-Op"}
            </span>
            <span className="text-xs text-gray-400">
              {rule.conditions.length} condition{rule.conditions.length !== 1 ? "s" : ""}
            </span>
            {manualOverrides.length > 0 && (
              <span
                title={`Manual vendor split active for: ${manualOverrides.join(", ")} — this manual split takes priority over the rule in reports`}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 cursor-default"
              >
                <AlertTriangle size={10} />
                Manual override
              </span>
            )}
          </div>
          {rule.description && (
            <p className="text-xs text-gray-500 truncate">{rule.description}</p>
          )}
          <p className="text-xs text-blue-600 truncate mt-0.5">
            {allocationSummary(rule.allocations, ccNames)}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100"
          >
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            disabled={deleting}
            className="text-gray-400 hover:text-red-500 disabled:opacity-40 p-1 rounded hover:bg-gray-100"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1.5">Conditions</div>
            {rule.conditions.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No conditions — will match all transactions</p>
            ) : (
              <div className="space-y-0.5">
                {sorted.map((c, i) => (
                  <div key={c.id} className="text-xs flex items-center gap-1.5 py-0.5">
                    <span className="font-mono text-gray-400 w-8 shrink-0">
                      {i === 0 ? "IF" : c.logic_connector ?? "AND"}
                    </span>
                    {c.opens_group && <span className="font-mono text-blue-600 shrink-0">(</span>}
                    <span className="text-blue-600">{c.field}</span>
                    <span className="text-gray-400">{c.operator}</span>
                    <span className="text-gray-900">"{c.value}"</span>
                    {c.closes_group && <span className="font-mono text-blue-600 shrink-0">)</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1.5">Allocations</div>
            <div className="space-y-1">
              {rule.allocations
                .slice()
                .sort((a, b) => a.display_order - b.display_order)
                .map((a) => (
                  <div key={a.id} className="text-xs flex items-center gap-2">
                    <span className="font-medium text-gray-900 w-12 text-right shrink-0">
                      {a.percentage}%
                    </span>
                    <span className="text-blue-600">{ccNames.get(a.cost_center_id) ?? a.cost_center_id}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SplitRulesPage() {
  const [rules, setRules] = useState<SplitRuleWithDetails[]>([]);
  const [costCenters, setCostCenters] = useState<CCOption[]>([]);
  const [vendorManualSplits, setVendorManualSplits] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [reapplyMsg, setReapplyMsg] = useState("");

  const ccNames = new Map(costCenters.map((cc) => [cc.id, cc.name]));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, ccsRes, splitsRes] = await Promise.all([
        fetch("/api/split-rules"),
        fetch("/api/cost-centers"),
        fetch("/api/cc-allocation-splits"),
      ]);
      const [rulesData, ccsData, splitsData] = await Promise.all([
        rulesRes.json(), ccsRes.json(), splitsRes.json(),
      ]);
      setRules(Array.isArray(rulesData) ? rulesData : []);
      setCostCenters(Array.isArray(ccsData) ? ccsData : []);
      // Build a set of normalized (lowercase) vendor names that have active manual splits
      const vendorKeys = new Set<string>();
      if (Array.isArray(splitsData)) {
        for (const s of splitsData as { assign_type: string; assign_value: string }[]) {
          if (s.assign_type === "vendor") {
            vendorKeys.add(s.assign_value.trim().replace(/\s+/g, " ").toLowerCase());
          }
        }
      }
      setVendorManualSplits(vendorKeys);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleReapply() {
    if (!confirm("Re-apply all cost center + split rules to all non-manual transactions? This may take a few seconds.")) return;
    setReapplying(true);
    setReapplyMsg("");
    try {
      const settingsRes = await fetch("/api/app-settings");
      const settings = await settingsRes.json().catch(() => ({}));
      const branches: string[] = Array.isArray(settings?.active_branches) ? settings.active_branches : [];

      const res = await fetch("/api/cost-centers/reapply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branches }),
      });
      const json = await res.json();
      if (!res.ok) {
        setReapplyMsg(`Error: ${json.error ?? "Unknown error"}`);
      } else {
        const p = Number(json.processed ?? 0).toLocaleString();
        const a = Number(json.assigned ?? 0).toLocaleString();
        const u = Number(json.unassigned ?? 0).toLocaleString();
        const c = Number(json.conflicts ?? 0).toLocaleString();
        const branchLabel = branches.length > 0 ? ` (branches: ${branches.join(", ")})` : " (all branches)";
        setReapplyMsg(`Done${branchLabel} — ${p} processed: ${a} assigned, ${u} unassigned, ${c} conflicts.`);
      }
    } catch (err) {
      setReapplyMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReapplying(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rules</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Create and manage the rules that assign transactions to cost centers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReapply}
            disabled={reapplying}
            className="flex items-center gap-1.5 text-sm bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 px-3 py-1.5 rounded border border-gray-200 shadow-sm"
          >
            <RefreshCw size={14} className={reapplying ? "animate-spin" : ""} />
            {reapplying ? "Applying…" : "Re-apply All Rules"}
          </button>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded shadow-sm"
            >
              <Plus size={14} /> Add Rule
            </button>
          )}
        </div>
      </div>

      {reapplyMsg && (
        <div
          className={`text-sm px-3 py-2 rounded border ${
            reapplyMsg.startsWith("Error")
              ? "bg-red-50 text-red-600 border-red-200"
              : "bg-green-50 text-green-700 border-green-200"
          }`}
        >
          {reapplyMsg}
        </div>
      )}

      {creating && (
        <RuleForm
          costCenters={costCenters}
          onSave={(newRule) => {
            setRules((prev) => [newRule, ...prev]);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : rules.length === 0 && !creating ? (
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-10 text-center shadow-sm">
          <p className="text-sm text-gray-500">No rules yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Create a rule to automatically split a transaction across multiple cost centers.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              ccNames={ccNames}
              costCenters={costCenters}
              vendorManualSplits={vendorManualSplits}
              onUpdate={(updated) =>
                setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
              }
              onDelete={(id) => setRules((prev) => prev.filter((r) => r.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
