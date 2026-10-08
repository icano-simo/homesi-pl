"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Save, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { MONTH_NAMES } from "@/lib/constants";
import type { Branch, GLMapping, ManualEntryListRow } from "@/types";

// ─── GL Code autocomplete cell ────────────────────────────────────────────────

function GLCodeCell({
  value,
  glName,
  onChange,
  showError,
}: {
  value: string;
  glName: string;
  onChange: (gl_code: string, gl_name: string) => void;
  showError: boolean;
}) {
  const [inputVal, setInputVal] = useState(value ? `${value}${glName ? ` — ${glName}` : ""}` : "");
  const [results, setResults] = useState<GLMapping[]>([]);
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  // True when user typed something but tabbed/clicked away without selecting
  const [typedWithoutSelection, setTypedWithoutSelection] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputVal(value ? `${value}${glName ? ` — ${glName}` : ""}` : "");
    if (value) setTypedWithoutSelection(false); // Selection committed — clear the warning
  }, [value, glName]);

  function handleInput(q: string) {
    setInputVal(q);
    setTypedWithoutSelection(false); // User is typing again
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!q.trim()) { setResults([]); return; }
      setFetching(true);
      try {
        const res = await fetch(`/api/gl-mapping?q=${encodeURIComponent(q)}`);
        if (res.ok) setResults(await res.json());
      } finally { setFetching(false); }
    }, 200);
  }

  function handleSelect(gl: GLMapping) {
    onChange(gl.gl_code, gl.gl_name);
    setInputVal(`${gl.gl_code} — ${gl.gl_name}`);
    setTypedWithoutSelection(false);
    setOpen(false);
    setResults([]);
  }

  function handleBlur() {
    if (!inputVal.trim()) {
      onChange("", "");
      setTypedWithoutSelection(false);
    } else if (!value.trim()) {
      // User has text in the box but nothing was committed via the dropdown
      setTypedWithoutSelection(true);
    }
  }

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  const hasError = showError && !value;
  const hasWarning = typedWithoutSelection; // Typed but not selected — independent of showError

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputVal}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => { if (inputVal) setOpen(true); }}
        onBlur={handleBlur}
        placeholder="Search GL Code…"
        className={[
          "w-full rounded border px-2 py-1 text-xs text-gray-700 focus:outline-none min-w-[140px]",
          hasError || hasWarning
            ? "border-red-400 bg-red-50/40 focus:border-red-500"
            : "border-gray-200 focus:border-blue-400",
        ].join(" ")}
      />
      {hasWarning && !open && (
        <p className="absolute left-0 top-full mt-0.5 z-10 rounded bg-red-50 border border-red-200 px-1.5 py-0.5 text-[10px] text-red-600 whitespace-nowrap shadow-sm">
          Select an option from the dropdown
        </p>
      )}
      {hasError && !hasWarning && (
        <p className="absolute left-0 top-full mt-0.5 z-10 rounded bg-red-50 border border-red-200 px-1.5 py-0.5 text-[10px] text-red-600 whitespace-nowrap shadow-sm">
          Required
        </p>
      )}
      {open && (inputVal.length > 0) && (
        <div className="absolute z-50 top-full left-0 mt-0.5 w-72 rounded-lg border border-gray-200 bg-white shadow-lg max-h-52 overflow-y-auto">
          {fetching && <p className="px-3 py-2 text-xs text-gray-400">Searching…</p>}
          {!fetching && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No results for &ldquo;{inputVal}&rdquo;</p>
          )}
          {results.map((gl) => (
            <button
              key={gl.id}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(gl); }}
              className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-blue-50 text-xs"
            >
              <span className="font-mono text-gray-900 shrink-0">{gl.gl_code}</span>
              <span className="text-gray-500 truncate">{gl.gl_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Saved manual entries ─────────────────────────────────────────────────────

const fmtAmount = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const fmtCreated = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// Assigned by a person, not by a rule — deleting the entry takes that choice with it.
const isHandAssigned = (e: ManualEntryListRow) =>
  e.cost_center_status === "assigned" && (e.assignment_origin === "manual" || e.assignment_origin === "conflict_resolved");

function SavedEntries({ entries, loading, error, onDelete, deletingId }: {
  entries: ManualEntryListRow[];
  loading: boolean;
  error: string | null;
  onDelete: (e: ManualEntryListRow) => void;
  deletingId: string | null;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Your manual entries</h3>
        <p className="text-xs text-gray-500">
          Everything created from this screen, newest first. Addbacks and file uploads are not listed here.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          <AlertCircle size={15} className="shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-xs" style={{ minWidth: 900 }}>
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Branch</th>
              <th className="px-3 py-2 font-medium">GL Code</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
              <th className="px-3 py-2 font-medium">Period</th>
              <th className="px-3 py-2 font-medium">Cost Center</th>
              <th className="w-8 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && entries.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-4 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-4 text-center text-gray-400">No manual entries yet.</td></tr>
            )}
            {entries.map((e, i) => (
              <tr key={e.id} className={i % 2 ? "bg-gray-50/40" : ""}>
                <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{fmtCreated(e.created_at)}</td>
                <td className="px-3 py-1.5 text-gray-700">{e.branch ?? "—"}</td>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-gray-900">{e.gl_code ?? "—"}</span>
                  {e.gl_name && <span className="ml-1 text-gray-400">{e.gl_name}</span>}
                </td>
                <td className="px-3 py-1.5 text-gray-700">{e.check_description || <span className="text-gray-300">—</span>}</td>
                <td className={`px-3 py-1.5 text-right font-mono whitespace-nowrap ${(e.movement ?? 0) < 0 ? "text-red-600" : "text-gray-900"}`}>
                  {fmtAmount(e.movement)}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{[e.month, e.year].filter(Boolean).join(" ") || "—"}</td>
                <td className="px-3 py-1.5">
                  {e.cost_center_name ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-gray-700">{e.cost_center_name}</span>
                      {isHandAssigned(e) ? (
                        <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700" title="Assigned by hand — deleting this entry also removes that assignment">
                          assigned by hand
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400">by rule</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-gray-400">{e.cost_center_status === "conflict" ? "Conflict" : "Unassigned"}</span>
                  )}
                </td>
                <td className="px-1 py-1.5">
                  <button
                    onClick={() => onDelete(e)}
                    disabled={deletingId !== null}
                    title="Delete this entry"
                    className="rounded p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Row state ────────────────────────────────────────────────────────────────

interface ManualRow {
  id: string;
  gl_code: string;
  gl_name: string;
  branch: string;
  check_description: string;
  vendor: string;
  debit: string;
  credit: string;
  month: string;
  year: string;
}

function newRow(): ManualRow {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    gl_code: "",
    gl_name: "",
    branch: "",
    check_description: "",
    vendor: "",
    debit: "",
    credit: "",
    month: MONTH_NAMES[now.getMonth()],
    year: String(now.getFullYear()),
  };
}

// A row is ready to save when all truly required fields have a committed value.
function isComplete(r: ManualRow): boolean {
  return r.gl_code.trim() !== "" && r.branch !== "" && r.month !== "" && r.year !== "";
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ManualEntryPage() {
  const [rows, setRows] = useState<ManualRow[]>([newRow()]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; uploadId?: string } | null>(null);
  // Set to true on first save attempt — triggers per-field error indicators
  const [triedToSave, setTriedToSave] = useState(false);

  const [entries, setEntries] = useState<ManualEntryListRow[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/branches")
      .then((r) => r.json())
      .then(setBranches)
      .catch(console.error);
    loadEntries();
  }, []);

  async function loadEntries() {
    setEntriesLoading(true);
    try {
      const res = await fetch("/api/manual-entry");
      const json = await res.json();
      if (!res.ok) { setEntriesError(json.error ?? "Could not load manual entries"); return; }
      setEntries(json);
      setEntriesError(null);
    } catch (e) {
      setEntriesError(e instanceof Error ? e.message : String(e));
    } finally {
      setEntriesLoading(false);
    }
  }

  async function handleDeleteEntry(e: ManualEntryListRow) {
    const lines = [
      "Delete this manual entry?",
      "",
      `${e.check_description || "(no description)"} — ${fmtAmount(e.movement)}`,
      `Branch ${e.branch ?? "—"} · GL ${e.gl_code ?? "—"} · ${[e.month, e.year].filter(Boolean).join(" ")}`,
    ];
    if (isHandAssigned(e)) {
      lines.push("", `⚠ It has cost center "${e.cost_center_name}" assigned by hand. Deleting the entry removes that assignment too.`);
    }
    lines.push("", "This cannot be undone.");
    if (!confirm(lines.join("\n"))) return;

    setDeletingId(e.id);
    try {
      const res = await fetch(`/api/manual-entry/${e.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEntriesError(json.error ?? "Could not delete the entry");
        return;
      }
      setEntriesError(null);
      await loadEntries();
    } finally {
      setDeletingId(null);
    }
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.length > 1 ? prev.filter((r) => r.id !== id) : prev);
  }

  function updateRow(id: string, field: keyof ManualRow, value: string) {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, [field]: value } : r));
  }

  function updateGLCode(id: string, gl_code: string, gl_name: string) {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, gl_code, gl_name } : r));
  }

  async function handleSave() {
    setTriedToSave(true);

    // Diagnostic: log each row's field values and validation result to browser console.
    // Open DevTools → Console to see exactly which field is failing.
    for (const r of rows) {
      console.group(`[ManualEntry] Row ${r.id.slice(0, 8)}`);
      console.log("gl_code  :", JSON.stringify(r.gl_code),  "→", r.gl_code.trim() !== "" ? "✓" : "✗ FAILS (empty — must select from dropdown)");
      console.log("branch   :", JSON.stringify(r.branch),   "→", r.branch !== ""         ? "✓" : "✗ FAILS (empty — select a branch)");
      console.log("month    :", JSON.stringify(r.month),    "→", r.month !== ""           ? "✓" : "✗ FAILS (empty)");
      console.log("year     :", JSON.stringify(r.year),     "→", r.year !== ""            ? "✓" : "✗ FAILS (empty)");
      console.log("isComplete:", isComplete(r));
      console.groupEnd();
    }

    const validRows = rows.filter(isComplete);
    if (validRows.length === 0) {
      setResult({ ok: false, message: "Fill in the required fields (GL Code, Branch, Month, Year) for at least one row. Check the fields highlighted in red." });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const payload = validRows.map((r) => ({
        gl_code: r.gl_code.trim(),
        branch: r.branch,
        check_description: r.check_description.trim(),
        vendor: r.vendor.trim(),
        debit: parseFloat(r.debit) || 0,
        credit: parseFloat(r.credit) || 0,
        month: r.month,
        year: parseInt(r.year) || new Date().getFullYear(),
      }));
      const res = await fetch("/api/manual-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: json.error ?? "Failed to save" });
        return;
      }
      setResult({
        ok: true,
        message: `${json.rowCount} transaction${json.rowCount !== 1 ? "s" : ""} saved and processed by Cost Center Rules.`,
        uploadId: json.uploadId,
      });
      setRows([newRow()]);
      setTriedToSave(false);
      loadEntries();
    } finally {
      setSaving(false);
    }
  }

  const validCount = rows.filter(isComplete).length;

  return (
    <div className="space-y-5 max-w-screen-xl">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Manual Entry</h2>
          <p className="text-sm text-gray-500">
            Add transactions manually — enriched against GL Mapping and Branches, then evaluated by Cost Center Rules.
          </p>
        </div>
        <Link
          href="/transactions"
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 whitespace-nowrap"
        >
          <ExternalLink size={12} /> Transaction Review
        </Link>
      </div>

      {result && (
        <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
          result.ok
            ? "border-green-200 bg-green-50 text-green-700"
            : "border-red-200 bg-red-50 text-red-600"
        }`}>
          {result.ok ? <CheckCircle size={15} className="shrink-0" /> : <AlertCircle size={15} className="shrink-0" />}
          <span>{result.message}</span>
          {result.ok && (
            <Link
              href="/transactions"
              className="ml-auto text-xs text-green-600 underline hover:text-green-800 whitespace-nowrap"
            >
              View in Transaction Review →
            </Link>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-xs" style={{ minWidth: 900 }}>
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
              <th className="px-3 py-2 font-medium">
                GL Code <span className="text-red-400">*</span>
              </th>
              <th className="px-3 py-2 font-medium" style={{ width: 130 }}>
                Branch <span className="text-red-400">*</span>
              </th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium" style={{ width: 130 }}>Vendor</th>
              <th className="px-3 py-2 font-medium text-right" style={{ width: 100 }}>Debit</th>
              <th className="px-3 py-2 font-medium text-right" style={{ width: 100 }}>Credit</th>
              <th className="px-3 py-2 font-medium" style={{ width: 130 }}>
                Month <span className="text-red-400">*</span>
              </th>
              <th className="px-3 py-2 font-medium" style={{ width: 74 }}>
                Year <span className="text-red-400">*</span>
              </th>
              <th className="w-8 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row) => {
              const showErr = triedToSave;
              const missingBranch = showErr && !row.branch;
              const missingMonth  = showErr && !row.month;
              const missingYear   = showErr && !row.year;

              return (
                <tr key={row.id} className="hover:bg-gray-50/50 align-top">
                  {/* GL Code */}
                  <td className="px-2 py-1.5 min-w-[180px]">
                    <GLCodeCell
                      value={row.gl_code}
                      glName={row.gl_name}
                      onChange={(code, name) => updateGLCode(row.id, code, name)}
                      showError={showErr}
                    />
                  </td>

                  {/* Branch */}
                  <td className="px-2 py-1.5">
                    <div className="relative">
                      <select
                        value={row.branch}
                        onChange={(e) => updateRow(row.id, "branch", e.target.value)}
                        className={[
                          "w-full rounded border px-2 py-1 text-xs text-gray-700 focus:outline-none",
                          missingBranch
                            ? "border-red-400 bg-red-50/40 focus:border-red-500"
                            : "border-gray-200 focus:border-blue-400",
                        ].join(" ")}
                      >
                        <option value="">Select…</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.branch}>{b.branch}</option>
                        ))}
                      </select>
                      {missingBranch && (
                        <p className="mt-0.5 text-[10px] text-red-600">Required</p>
                      )}
                    </div>
                  </td>

                  {/* Description */}
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.check_description}
                      onChange={(e) => updateRow(row.id, "check_description", e.target.value)}
                      placeholder="Description"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
                    />
                  </td>

                  {/* Vendor */}
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.vendor}
                      onChange={(e) => updateRow(row.id, "vendor", e.target.value)}
                      placeholder="Vendor"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-blue-400 focus:outline-none"
                    />
                  </td>

                  {/* Debit */}
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      value={row.debit}
                      onChange={(e) => updateRow(row.id, "debit", e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-right text-gray-700 focus:border-blue-400 focus:outline-none"
                    />
                  </td>

                  {/* Credit */}
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      value={row.credit}
                      onChange={(e) => updateRow(row.id, "credit", e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className="w-full rounded border border-gray-200 px-2 py-1 text-xs text-right text-gray-700 focus:border-blue-400 focus:outline-none"
                    />
                  </td>

                  {/* Month */}
                  <td className="px-2 py-1.5">
                    <div>
                      <select
                        value={row.month}
                        onChange={(e) => updateRow(row.id, "month", e.target.value)}
                        className={[
                          "w-full rounded border px-2 py-1 text-xs text-gray-700 focus:outline-none",
                          missingMonth
                            ? "border-red-400 bg-red-50/40 focus:border-red-500"
                            : "border-gray-200 focus:border-blue-400",
                        ].join(" ")}
                      >
                        <option value="">Month…</option>
                        {MONTH_NAMES.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                      {missingMonth && (
                        <p className="mt-0.5 text-[10px] text-red-600">Required</p>
                      )}
                    </div>
                  </td>

                  {/* Year */}
                  <td className="px-2 py-1.5">
                    <div>
                      <input
                        type="number"
                        value={row.year}
                        onChange={(e) => updateRow(row.id, "year", e.target.value)}
                        placeholder={String(new Date().getFullYear())}
                        min="2000"
                        max="2099"
                        className={[
                          "w-full rounded border px-2 py-1 text-xs text-gray-700 focus:outline-none",
                          missingYear
                            ? "border-red-400 bg-red-50/40 focus:border-red-500"
                            : "border-gray-200 focus:border-blue-400",
                        ].join(" ")}
                      />
                      {missingYear && (
                        <p className="mt-0.5 text-[10px] text-red-600">Required</p>
                      )}
                    </div>
                  </td>

                  {/* Delete */}
                  <td className="px-1 py-1.5">
                    <button
                      onClick={() => removeRow(row.id)}
                      disabled={rows.length === 1}
                      title="Remove row"
                      className="rounded p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-0 disabled:pointer-events-none"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={addRow}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <Plus size={13} /> Add Row
        </button>

        <div className="flex items-center gap-3">
          {triedToSave && validCount < rows.length && (
            <span className="text-xs text-red-500">
              {rows.length - validCount} row{rows.length - validCount !== 1 ? "s" : ""} with missing required fields
            </span>
          )}
          {!triedToSave && validCount < rows.length && rows.length > 1 && (
            <span className="text-xs text-gray-400">
              {rows.length - validCount} row{rows.length - validCount !== 1 ? "s" : ""} incomplete — will be skipped
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            <Save size={13} />
            {saving ? "Saving…" : validCount > 0 ? `Save ${validCount} row${validCount !== 1 ? "s" : ""}` : "Save All"}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        <span className="text-red-400">*</span> Required. Movement = Credit − Debit. GL Code must be selected from the dropdown. Rows are processed through Cost Center Rules automatically.
      </p>

      <SavedEntries
        entries={entries}
        loading={entriesLoading}
        error={entriesError}
        onDelete={handleDeleteEntry}
        deletingId={deletingId}
      />
    </div>
  );
}
