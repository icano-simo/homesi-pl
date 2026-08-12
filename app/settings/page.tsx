"use client";

import { useState, useEffect } from "react";
import { Filter, CheckCircle } from "lucide-react";
import { useActiveBranches } from "@/components/branch-filter-provider";

export default function SettingsPage() {
  const { activeBranches, setActiveBranches, allBranches, isLoaded } = useActiveBranches();
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isLoaded) setLocalBranches(activeBranches);
  }, [isLoaded]); // intentionally only on mount-after-load

  const isAllBranches = localBranches.length === 0;

  function toggleBranch(b: string) {
    setSaved(false);
    setLocalBranches(prev =>
      prev.includes(b) ? prev.filter(x => x !== b) : [...prev, b]
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    await setActiveBranches(localBranches);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-gray-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Settings</h2>
        <p className="mt-1 text-sm text-gray-500">Global application configuration.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm divide-y divide-gray-100">
        {/* Section header */}
        <div className="px-6 py-4">
          <div className="flex items-center gap-2">
            <Filter size={15} className="text-gray-500" />
            <h3 className="font-semibold text-gray-800">Active Branch Filter</h3>
          </div>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            Restricts the entire application to specific branches. Applies automatically to all
            reports, the CC Assignment engine, and <strong className="text-gray-700">Re-apply All Rules</strong> —
            which will evaluate only the selected branches instead of all ~12 K rows, improving
            response time significantly. All other branch data remains intact in the database; only
            the default view is scoped.
          </p>
        </div>

        {/* Branch selector */}
        <div className="px-6 py-5 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isAllBranches}
              onChange={() => { setSaved(false); setLocalBranches([]); }}
              className="h-4 w-4 accent-blue-600 rounded"
            />
            <div>
              <span className="text-sm font-medium text-gray-800">All branches</span>
              <span className="ml-2 text-xs text-gray-400">(no restriction — see everything)</span>
            </div>
          </label>

          {allBranches.length > 0 ? (
            <div className="mt-3 space-y-2 pl-1 border-l-2 border-gray-100 ml-2">
              {allBranches.map(b => (
                <label key={b} className="flex items-center gap-3 cursor-pointer group pl-3">
                  <input
                    type="checkbox"
                    checked={localBranches.includes(b)}
                    onChange={() => toggleBranch(b)}
                    className="h-4 w-4 accent-blue-600 rounded"
                  />
                  <span className="text-sm font-mono text-gray-700 group-hover:text-gray-900">{b}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic pl-7">
              No branches found. Upload a P&amp;L file to populate branches.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center gap-4 bg-gray-50/50">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#e03535] disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <CheckCircle size={14} />
              Saved
            </span>
          )}
          {!isAllBranches && !saved && (
            <span className="text-xs text-gray-600 bg-gray-50 rounded px-2.5 py-1 border border-gray-200">
              Will filter to: {localBranches.join(", ")}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Settings are saved to the database and apply across all devices and sessions.
      </p>
    </div>
  );
}
