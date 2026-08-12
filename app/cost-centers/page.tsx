"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Plus, Search, Trash2, RefreshCw, ChevronRight, Unlink, ArrowUpAZ, ArrowDownAZ, ChevronsUpDown } from "lucide-react";
import { useActiveBranches } from "@/components/branch-filter-provider";
import type { CostCenter } from "@/types";

type CCWithCount = CostCenter & { rule_count: number };

// ─── Color accents ────────────────────────────────────────────────────────────

const ACCENT_COLORS = [
  { dot: "bg-blue-300",    border: "border-l-blue-300",    text: "text-blue-700"    },
  { dot: "bg-indigo-300",  border: "border-l-indigo-300",  text: "text-indigo-700"  },
  { dot: "bg-violet-300",  border: "border-l-violet-300",  text: "text-violet-700"  },
  { dot: "bg-teal-300",    border: "border-l-teal-300",    text: "text-teal-700"    },
  { dot: "bg-amber-300",   border: "border-l-amber-300",   text: "text-amber-700"   },
  { dot: "bg-emerald-300", border: "border-l-emerald-300", text: "text-emerald-700" },
  { dot: "bg-rose-300",    border: "border-l-rose-300",    text: "text-rose-700"    },
  { dot: "bg-orange-300",  border: "border-l-orange-300",  text: "text-orange-700"  },
];

function ccColorIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % ACCENT_COLORS.length;
}

export function useCCColor(id: string) {
  return ACCENT_COLORS[ccColorIndex(id)];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CostCentersPage() {
  const { activeBranches } = useActiveBranches();
  const [records, setRecords] = useState<CCWithCount[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState("");
  const [deleteErrId, setDeleteErrId] = useState<string | null>(null);
  const [deleteOk, setDeleteOk] = useState("");
  const [reapplying, setReapplying] = useState(false);
  const [reapplyMsg, setReapplyMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cost-centers");
      setRecords(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const [nameSort, setNameSort] = useState<"asc" | "desc" | null>(null);

  const filtered = records.filter(
    (r) =>
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      (r.description ?? "").toLowerCase().includes(query.toLowerCase())
  );

  const sorted = nameSort
    ? [...filtered].sort((a, b) => {
        const dir = nameSort === "asc" ? 1 : -1;
        return dir * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      })
    : filtered;

  async function handleAdd() {
    if (!newName.trim()) { setSaveErr("Name is required"); return; }
    setSaving(true);
    setSaveErr("");
    try {
      const res = await fetch("/api/cost-centers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok) { setSaveErr(json.error ?? "Failed to save"); return; }
      setAdding(false);
      setNewName("");
      setNewDesc("");
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Any rule-assigned transactions will be re-evaluated against the remaining rules.`)) return;
    setDeletingId(id);
    setDeleteErr("");
    setDeleteErrId(null);
    setDeleteOk("");
    try {
      const res = await fetch(`/api/cost-centers/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteErr(j.error ?? `Failed to delete "${name}".`);
        setDeleteErrId(id);
        return;
      }
      setRecords((p) => p.filter((r) => r.id !== id));
      const parts: string[] = [];
      if ((j.reevaluated ?? 0) > 0)
        parts.push(
          `${j.reevaluated} direct transaction${j.reevaluated !== 1 ? "s" : ""} re-evaluated ` +
          `(${j.reassigned ?? 0} reassigned, ${j.unassigned ?? 0} unassigned, ${j.conflicts ?? 0} conflicts)`
        );
      if ((j.conflict_reevaluated ?? 0) > 0)
        parts.push(
          `${j.conflict_reevaluated} conflict transaction${j.conflict_reevaluated !== 1 ? "s" : ""} re-evaluated ` +
          `(${j.conflict_reassigned ?? 0} resolved, ${j.conflict_unassigned ?? 0} unassigned, ${j.conflict_still_conflicting ?? 0} still conflicting)`
        );
      setDeleteOk(
        `"${name}" deleted.${parts.length > 0 ? " " + parts.join("; ") + "." : ""}`
      );
    } catch (err) {
      setDeleteErr(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleReapply() {
    const scopeMsg = activeBranches.length > 0
      ? ` (restricted to: ${activeBranches.join(", ")})`
      : " (all branches)";
    if (!confirm(`Re-apply all rules to transactions${scopeMsg}? This may take a few seconds.`)) return;
    setReapplying(true);
    setReapplyMsg("");
    try {
      const res = await fetch("/api/cost-centers/reapply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branches: activeBranches }),
      });
      let json: Record<string, unknown>;
      try {
        json = await res.json();
      } catch {
        setReapplyMsg("Error: server returned a non-JSON response. Check the server console.");
        return;
      }
      if (!res.ok) {
        setReapplyMsg(`Error: ${json.error ?? "Unknown server error"}`);
      } else {
        const p = Number(json.processed ?? 0).toLocaleString();
        const a = Number(json.assigned ?? 0).toLocaleString();
        const u = Number(json.unassigned ?? 0).toLocaleString();
        const c = Number(json.conflicts ?? 0).toLocaleString();
        setReapplyMsg(`Done — ${p} processed: ${a} assigned, ${u} unassigned, ${c} conflicts.`);
      }
    } catch (err) {
      setReapplyMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReapplying(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Cost Centers</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            View your cost centers and the rules that apply to each.{" "}
            <Link href="/split-rules" className="text-blue-600 hover:underline">
              Go to Rules
            </Link>{" "}
            to create or edit rules.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleReapply}
            disabled={reapplying}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={reapplying ? "animate-spin" : ""} />
            Re-apply Rules
          </button>
          <button
            onClick={() => { setAdding(true); setSaveErr(""); }}
            className="flex items-center gap-1.5 rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#e03535]"
          >
            <Plus size={14} /> Add Cost Center
          </button>
        </div>
      </div>

      {reapplyMsg && (
        <p className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
          {reapplyMsg}
        </p>
      )}

      {deleteOk && (
        <p className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {deleteOk}
        </p>
      )}

      {deleteErr && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 space-y-1">
          <p>{deleteErr}</p>
          {deleteErrId && (
            <p className="text-xs">
              <Link
                href={`/cost-centers/${deleteErrId}`}
                className="inline-flex items-center gap-1 font-medium underline hover:text-red-900"
              >
                <Unlink size={11} /> Open cost center → Unassign all
              </Link>{" "}
              to clear transactions before deleting.
            </p>
          )}
        </div>
      )}

      {/* Add form */}
      {adding && (
        <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-800">New Cost Center</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500">Name *</label>
              <input
                autoFocus type="text" value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="e.g. Margin"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Description</label>
              <input
                type="text" value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
          </div>
          {saveErr && <p className="text-xs text-red-600">{saveErr}</p>}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving}
              className="rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#e03535] disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => { setAdding(false); setNewName(""); setNewDesc(""); setSaveErr(""); }}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search cost centers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-4 text-sm focus:border-blue-400 focus:outline-none"
        />
      </div>

      {/* List */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-10 text-center text-gray-400">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">No cost centers found.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    Cost Center
                    <button
                      onClick={() => setNameSort(d => d === null ? "asc" : d === "asc" ? "desc" : null)}
                      title={nameSort === null ? "Sort A→Z" : nameSort === "asc" ? "Sort Z→A" : "Clear sort"}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-blue-600"
                    >
                      {nameSort === "asc"  ? <ArrowUpAZ   size={13} className="text-blue-500" /> :
                       nameSort === "desc" ? <ArrowDownAZ size={13} className="text-blue-500" /> :
                                             <ChevronsUpDown size={13} />}
                    </button>
                  </span>
                </th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium text-center">Matching Rules</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((cc) => {
                const color = ACCENT_COLORS[ccColorIndex(cc.id)];
                return (
                  <tr
                    key={cc.id}
                    className="border-b border-gray-50 hover:bg-gray-50/80 cursor-pointer"
                    onClick={() => (window.location.href = `/cost-centers/${cc.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${color.dot} shrink-0`} />
                        <Link
                          href={`/cost-centers/${cc.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-gray-800 hover:text-blue-700"
                        >
                          {cc.name}
                        </Link>
                      </div>
                    </td>
                    <td className="max-w-[300px] truncate px-4 py-3 text-gray-500">
                      {cc.description ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600">
                      {cc.rule_count > 0 ? (
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${color.dot} bg-opacity-30 ${color.text}`}>
                          {cc.rule_count}
                        </span>
                      ) : (
                        <span className="text-gray-300">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/cost-centers/${cc.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-0.5 text-gray-400 hover:text-blue-600"
                          title="View rules"
                        >
                          <ChevronRight size={14} />
                        </Link>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(cc.id, cc.name); }}
                          disabled={deletingId === cc.id}
                          className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                          title="Delete cost center"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
