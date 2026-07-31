"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, AlertTriangle, Download, Search, X, Pencil, Trash2, ChevronsUpDown, ArrowUpAZ, ArrowDownAZ } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { ColumnFilter } from "@/components/column-filter";
import { buildSplitsMap } from "@/lib/apply-splits";
import { SplitDisplay } from "@/components/split-display";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import { MONTH_NAMES } from "@/lib/constants";
import type { SplitEntry } from "@/lib/apply-splits";
import type { PLTransaction, FilterOptionsResponse, TransactionTotals, Branch, GLMapping } from "@/types";

// ─── Virtual scroll constants ─────────────────────────────────────────────────

const ROW_H = 38;
const OVERSCAN = 25;

// ─── Server-side filter state (sent to API) ───────────────────────────────────

type ServerFilters = {
  month: string[]; year: string[]; gl_code: string[]; gl_name: string[];
  branch: string[]; vendor: string[]; ref_numb: string[];
  cost_center: string[]; source: string[];
  description: string;
  check_description_2: string[]; check_description_3: string[];
  movement_min: string; movement_max: string;
};

// ─── Client-side filter state (applied in browser, no re-fetch) ───────────────

type LoanNumStatus = "all" | "has_loan" | "no_loan" | "incomplete";

type ClientFilters = {
  loan_number_status: LoanNumStatus;
  loan_tags: string[];
};

const LOAN_TAG_OPTIONS = ["B2B", "Processing", "On Demand", "Affinity", "Recruitment"];

const TAG_KEY_MAP: Record<string, keyof PLTransaction> = {
  "B2B": "b2b",
  "Processing": "processing",
  "On Demand": "support_on_demand",
  "Affinity": "affinity",
  "Recruitment": "recruitment",
};

const emptyServer = (): ServerFilters => ({
  month: [], year: [], gl_code: [], gl_name: [], branch: [], vendor: [],
  ref_numb: [], cost_center: [], source: [],
  description: "",
  check_description_2: [], check_description_3: [],
  movement_min: "", movement_max: "",
});

const emptyClient = (): ClientFilters => ({ loan_number_status: "all", loan_tags: [] });

type CCRef = { id: string; name: string };

function buildParams(uploadId: string, f: ServerFilters, ccList: CCRef[], globalBranches: string[] = []): URLSearchParams {
  const p = new URLSearchParams({ all: "true" });
  if (uploadId) p.set("uploadId", uploadId);
  const effectiveBranches = mergeWithGlobal(globalBranches, f.branch);
  f.month.forEach((v) => p.append("month", v));
  f.year.forEach((v) => p.append("year", v));
  f.gl_code.forEach((v) => p.append("gl_code", v));
  f.gl_name.forEach((v) => p.append("gl_name", v));
  effectiveBranches.forEach((v) => p.append("branch", v));
  f.vendor.forEach((v) => p.append("vendor", v));
  f.ref_numb.forEach((v) => p.append("ref_numb", v));
  f.check_description_2.forEach((v) => p.append("check_description_2", v));
  f.check_description_3.forEach((v) => p.append("check_description_3", v));
  if (f.description) p.set("description", f.description);
  if (f.movement_min) p.set("movement_min", f.movement_min);
  if (f.movement_max) p.set("movement_max", f.movement_max);
  for (const val of f.cost_center) {
    if (val === "Unassigned") p.append("cc_status", "unassigned");
    else if (val === "Conflict") p.append("cc_status", "conflict");
    else { const cc = ccList.find((c) => c.name === val); if (cc) p.append("cost_center_id", cc.id); }
  }
  for (const val of f.source) {
    if (val === "Original") p.append("source", "original");
    else if (val === "Addback") p.append("source", "addback");
    else if (val === "Offshore") p.append("source", "offshore_allocations");
    else if (val === "Manual Entry") p.append("source", "manual_entry");
    else if (val === "Employee Fee") p.append("source", "employee_fee");
  }
  return p;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(v: unknown): string {
  const n = Number(v);
  if (v == null || v === "" || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function mvColor(v: unknown): string {
  return (Number(v) || 0) >= 0 ? "text-green-700" : "text-red-700";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TotalCard({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${colorClass}`}>{fmt(value)}</p>
    </div>
  );
}

function TH({ label, children, className = "" }: { label?: string; children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-2 py-2.5 font-medium text-left ${className}`}>
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap">{label}{children}</span>
    </th>
  );
}

// ─── Manual Entry edit modal ──────────────────────────────────────────────────

function ManualEntryGLAutocomplete({
  value,
  glName,
  onChange,
}: {
  value: string;
  glName: string;
  onChange: (gl_code: string, gl_name: string) => void;
}) {
  const [inputVal, setInputVal] = useState(value ? `${value}${glName ? ` — ${glName}` : ""}` : "");
  const [results, setResults] = useState<GLMapping[]>([]);
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputVal(value ? `${value}${glName ? ` — ${glName}` : ""}` : "");
  }, [value, glName]);

  function handleInput(q: string) {
    setInputVal(q);
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
    setOpen(false);
    setResults([]);
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputVal}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={() => { if (inputVal) setOpen(true); }}
        placeholder="Search GL Code…"
        className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
      />
      {open && inputVal.length > 0 && (
        <div className="absolute z-[60] top-full left-0 mt-0.5 w-80 rounded-lg border border-gray-200 bg-white shadow-lg max-h-52 overflow-y-auto">
          {fetching && <p className="px-3 py-2 text-xs text-gray-400">Searching…</p>}
          {!fetching && results.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">No results</p>}
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

function ManualEntryEditModal({
  tx,
  onClose,
  onSaved,
}: {
  tx: PLTransaction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [glCode, setGlCode] = useState(tx.gl_code ?? "");
  const [glName, setGlName] = useState(tx.gl_name ?? "");
  const [branch, setBranch] = useState(tx.branch ?? "");
  const [description, setDescription] = useState(tx.check_description ?? "");
  const [vendor, setVendor] = useState(tx.vendor ?? "");
  const [debit, setDebit] = useState(String(tx.debit ?? ""));
  const [credit, setCredit] = useState(String(tx.credit ?? ""));
  const [month, setMonth] = useState(tx.month ?? "");
  const [year, setYear] = useState(String(tx.year ?? new Date().getFullYear()));
  const [branches, setBranches] = useState<Branch[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/branches").then((r) => r.json()).then(setBranches).catch(() => {});
  }, []);

  async function handleSave() {
    if (!glCode || !branch) { setErr("GL Code and Branch are required."); return; }
    setSaving(true); setErr("");
    try {
      const res = await fetch(`/api/manual-entry/${tx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gl_code: glCode,
          branch,
          check_description: description,
          vendor,
          debit: parseFloat(debit) || 0,
          credit: parseFloat(credit) || 0,
          month,
          year: parseInt(year) || new Date().getFullYear(),
        }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json.error ?? "Failed to save"); return; }
      onSaved();
    } finally { setSaving(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Edit Manual Entry</h3>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">GL Code *</label>
            <ManualEntryGLAutocomplete value={glCode} glName={glName} onChange={(code, name) => { setGlCode(code); setGlName(name); }} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Branch *</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none">
              <option value="">Select…</option>
              {branches.map((b) => <option key={b.id} value={b.branch}>{b.branch}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Vendor</label>
            <input type="text" value={vendor} onChange={(e) => setVendor(e.target.value)}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Debit</label>
            <input type="number" value={debit} onChange={(e) => setDebit(e.target.value)} min="0" step="0.01"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-right text-gray-700 focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Credit</label>
            <input type="number" value={credit} onChange={(e) => setCredit(e.target.value)} min="0" step="0.01"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-right text-gray-700 focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Month</label>
            <select value={month} onChange={(e) => setMonth(e.target.value)}
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none">
              <option value="">Month…</option>
              {MONTH_NAMES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Year</label>
            <input type="number" value={year} onChange={(e) => setYear(e.target.value)} min="2000" max="2099"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none" />
          </div>
        </div>

        {err && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{err}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CCCell({ tx, splitsMap }: { tx: PLTransaction; splitsMap: Map<string, SplitEntry[]> }) {
  if (tx.cost_center_status === "conflict")
    return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">Conflict</span>;

  const normVendor = tx.vendor?.trim().replace(/\s+/g, " ");
  const splits =
    (normVendor ? splitsMap.get(`vendor:${normVendor}`) : undefined) ??
    (tx.check_description_3 ? splitsMap.get(`description3:${tx.check_description_3}`) : undefined);

  if (splits && splits.length > 0) {
    return <SplitDisplay splits={splits} compact fallback={<span className="text-gray-300">—</span>} />;
  }

  if (tx.cost_center_status === "assigned" && tx.cost_centers?.name)
    return <span className="text-gray-700 truncate">{tx.cost_centers.name}</span>;
  return <span className="text-gray-300">—</span>;
}

const LOAN_TAG_LABELS: Record<string, string> = {
  b2b: "B2B",
  processing: "Processing",
  support_on_demand: "On Demand",
  affinity: "Affinity",
  recruitment: "Recruitment",
};

function LoanTagsCell({ tx }: { tx: PLTransaction }) {
  const active = (["b2b", "processing", "support_on_demand", "affinity", "recruitment"] as const)
    .filter((k) => tx[k] === true)
    .map((k) => LOAN_TAG_LABELS[k]);
  return (
    <td
      className="px-2 py-0 overflow-hidden whitespace-nowrap"
      title={active.length > 0 ? active.join(", ") : undefined}
    >
      {active.length > 0 ? (
        <span className="text-[10px] text-indigo-700">{active.join(", ")}</span>
      ) : tx.loan_number && !tx.loan_number_incomplete ? (
        <span className="text-gray-300">—</span>
      ) : (
        <span className="text-gray-200 text-[10px]">no loan</span>
      )}
    </td>
  );
}

// Inline loan # status picker (4-way: All / Has Loan / No Loan / Incomplete)
function LoanNumStatusPicker({ value, onChange }: { value: LoanNumStatus; onChange: (v: LoanNumStatus) => void }) {
  const opts: { v: LoanNumStatus; label: string; activeClass: string }[] = [
    { v: "all",        label: "All",   activeClass: "bg-blue-600 text-white" },
    { v: "has_loan",   label: "Loan ✓", activeClass: "bg-green-600 text-white" },
    { v: "no_loan",    label: "No Loan", activeClass: "bg-gray-500 text-white" },
    { v: "incomplete", label: "⚠ Incomplete", activeClass: "bg-gray-600 text-white" },
  ];
  return (
    <span className="ml-1 inline-flex items-center rounded border border-gray-200 bg-white overflow-hidden shrink-0">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            value === o.v ? o.activeClass : "text-gray-400 hover:text-gray-600"
          }`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

// ─── Loan number resolution picker ───────────────────────────────────────────

type LoanSearchResult = {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  month: string | null;
  year: number | null;
};

function LoanResolvePicker({
  tx,
  anchorEl,
  onResolved,
  onClose,
}: {
  tx: PLTransaction;
  anchorEl: HTMLElement;
  onResolved: (id: string, loanNumber: string) => void;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<LoanSearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LoanSearchResult[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Position portal relative to button
  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 340));

  // Load prefix candidates on mount
  useEffect(() => {
    const prefix = tx.loan_number ?? "";
    if (!prefix) { setLoadingCandidates(false); return; }
    fetch(`/api/loan-officials/search?prefix=${encodeURIComponent(prefix)}&limit=10`)
      .then((r) => r.json())
      .then((d: LoanSearchResult[]) => { setCandidates(Array.isArray(d) ? d : []); })
      .catch(() => setCandidates([]))
      .finally(() => setLoadingCandidates(false));
  }, [tx.loan_number]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery) { setSearchResults([]); return; }
    setLoadingSearch(true);
    const t = setTimeout(() => {
      fetch(`/api/loan-officials/search?q=${encodeURIComponent(searchQuery)}&limit=12`)
        .then((r) => r.json())
        .then((d: LoanSearchResult[]) => setSearchResults(Array.isArray(d) ? d : []))
        .catch(() => setSearchResults([]))
        .finally(() => setLoadingSearch(false));
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      const target = e.target as Node;
      if (!document.getElementById("loan-resolve-picker")?.contains(target)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);

  // Focus search input when picker opens
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  async function resolve(loanNumber: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/transactions/${tx.id}/resolve-loan`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loan_number: loanNumber }),
      });
      if (!res.ok) return;
      onResolved(tx.id, loanNumber);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const displayList = searchQuery ? searchResults : candidates;
  const isCandidate = !searchQuery && candidates.length > 0;

  return createPortal(
    <div
      id="loan-resolve-picker"
      className="fixed z-[9999] w-80 rounded-xl border border-gray-200 bg-white shadow-xl"
      style={{ top, left }}
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <span className="text-[11px] font-semibold text-gray-700">
          Resolve loan #{" "}
          <span className="font-mono text-gray-600">{tx.loan_number}</span>
        </span>
        <button onClick={onClose} className="text-gray-300 hover:text-gray-600"><X size={13} /></button>
      </div>

      {/* Candidates section */}
      {!searchQuery && (
        <div className="px-3 pt-2.5">
          {loadingCandidates ? (
            <p className="text-[11px] text-gray-400 pb-1">Looking up candidates…</p>
          ) : isCandidate ? (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                Prefix matches ({candidates.length})
              </p>
              <div className="space-y-1">
                {candidates.map((c) => (
                  <button
                    key={c.loan_number}
                    onClick={() => resolve(c.loan_number)}
                    disabled={saving}
                    className="flex w-full items-start justify-between gap-2 rounded-lg border border-gray-100 px-2.5 py-2 text-left hover:border-blue-300 hover:bg-blue-50 disabled:opacity-40"
                  >
                    <span className="font-mono text-[12px] text-gray-800">{c.loan_number}</span>
                    <span className="text-right text-[10px] text-gray-400 leading-tight">
                      {c.borrower_name && <span className="block">{c.borrower_name}</span>}
                      {c.month && <span className="block">{c.month} {c.year}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[11px] text-gray-400 pb-1">No prefix matches — search below.</p>
          )}
        </div>
      )}

      {/* Search */}
      <div className="px-3 pb-1 pt-2">
        {!searchQuery && <div className="my-2 border-t border-gray-100" />}
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search loan # or borrower name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-7 pr-3 text-[11px] focus:border-blue-400 focus:bg-white focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Search results */}
      {searchQuery && (
        <div className="max-h-52 overflow-y-auto px-3 pb-2">
          {loadingSearch ? (
            <p className="py-2 text-center text-[11px] text-gray-400">Searching…</p>
          ) : searchResults.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-gray-400">No results.</p>
          ) : (
            <div className="space-y-1 pt-1">
              {searchResults.map((c) => (
                <button
                  key={c.loan_number}
                  onClick={() => resolve(c.loan_number)}
                  disabled={saving}
                  className="flex w-full items-start justify-between gap-2 rounded-lg border border-gray-100 px-2.5 py-2 text-left hover:border-blue-300 hover:bg-blue-50 disabled:opacity-40"
                >
                  <span className="font-mono text-[12px] text-gray-800">{c.loan_number}</span>
                  <span className="text-right text-[10px] text-gray-400 leading-tight">
                    {c.borrower_name && <span className="block">{c.borrower_name}</span>}
                    {c.month && <span className="block">{c.month} {c.year}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-gray-100 px-3 py-2">
        <p className="text-[10px] text-gray-400">
          {saving ? "Saving…" : "Click a loan to confirm. This updates loan_number and clears the incomplete flag."}
        </p>
      </div>
    </div>,
    document.body
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const COL_COUNT = 15;

export default function TransactionsPage() {
  const { activeBranches, isLoaded: branchFilterLoaded } = useActiveBranches();

  const [uploads, setUploads] = useState<{ id: string; file_name: string }[]>([]);
  const [selectedUpload, setSelectedUpload] = useState("");
  const [filterOpts, setFilterOpts] = useState<FilterOptionsResponse>({
    month: [], year: [], gl_code: [], gl_name: [],
    branch: [], vendor: [], category_5: [], category_6: [], ref_numb: [],
    check_description_2: [], check_description_3: [], source: [],
    costCenters: [],
  });

  // Keep filterOpts in a ref so fetchAll doesn't have it as a reactive dependency.
  // Prevents filter-options loading from triggering a redundant second server fetch.
  const filterOptsRef = useRef<FilterOptionsResponse>(filterOpts);

  const [serverFilters, setServerFilters] = useState<ServerFilters>(emptyServer());
  const [clientFilters, setClientFilters] = useState<ClientFilters>(emptyClient());
  const [descSort, setDescSort] = useState<"asc" | "desc" | null>(null);

  const [rows, setRows] = useState<PLTransaction[]>([]);
  const [totals, setTotals] = useState<TransactionTotals>({ debit: 0, credit: 0, movement: 0 });

  // Loan resolution picker state
  const [resolvingTx, setResolvingTx] = useState<PLTransaction | null>(null);
  const [resolveAnchor, setResolveAnchor] = useState<HTMLElement | null>(null);

  // Manual entry edit/delete state
  const [editingManualTx, setEditingManualTx] = useState<PLTransaction | null>(null);

  async function handleDeleteManual(tx: PLTransaction) {
    if (!confirm(`Delete this manual entry transaction?\n${tx.check_description || tx.gl_code || tx.id}\n\nThis cannot be undone.`)) return;
    const res = await fetch(`/api/manual-entry/${tx.id}`, { method: "DELETE" });
    if (res.ok) {
      setRows((prev) => prev.filter((r) => r.id !== tx.id));
    }
  }

  function handleLoanResolved(id: string, loanNumber: string) {
    setRows((prev) => prev.map((r) =>
      r.id === id ? { ...r, loan_number: loanNumber, loan_number_raw: loanNumber, loan_number_incomplete: false } : r
    ));
  }

  function openResolvePicker(e: React.MouseEvent, tx: PLTransaction) {
    e.stopPropagation();
    setResolvingTx(tx);
    setResolveAnchor(e.currentTarget as HTMLElement);
  }
  const [allSplits, setAllSplits] = useState<SplitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Version counter: only the latest fetch's results are applied.
  // Prevents a slow earlier fetch from overwriting results from a newer one.
  const fetchSeq = useRef(0);

  // ── Virtual scroll ──────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setContainerH(es[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    setScrollTop(e.currentTarget.scrollTop);
    if (resolvingTx) { setResolvingTx(null); setResolveAnchor(null); }
  }

  // ── Client-side row filtering (loan # status + loan tags) ──────────────────
  const displayedRows = useMemo(() => {
    let out = rows;

    if (clientFilters.loan_number_status !== "all") {
      const s = clientFilters.loan_number_status;
      out = out.filter((tx) => {
        if (s === "has_loan")   return !!tx.loan_number && !tx.loan_number_incomplete;
        if (s === "no_loan")    return !tx.loan_number;
        if (s === "incomplete") return tx.loan_number_incomplete === true;
        return true;
      });
    }

    if (clientFilters.loan_tags.length > 0) {
      out = out.filter((tx) =>
        clientFilters.loan_tags.some((tag) => {
          const key = TAG_KEY_MAP[tag];
          return key && tx[key] === true;
        })
      );
    }

    if (descSort) {
      const dir = descSort === "asc" ? 1 : -1;
      out = [...out].sort((a, b) =>
        dir * (a.check_description ?? "").localeCompare(b.check_description ?? "", undefined, { sensitivity: "base" })
      );
    }

    return out;
  }, [rows, clientFilters, descSort]);

  const N = displayedRows.length;
  const firstV = Math.floor(scrollTop / ROW_H);
  const lastV = Math.ceil((scrollTop + containerH) / ROW_H);
  const renderFrom = Math.max(0, firstV - OVERSCAN);
  const renderTo = Math.min(N, lastV + OVERSCAN);
  const visibleRows = displayedRows.slice(renderFrom, renderTo);
  const topPad = renderFrom * ROW_H;
  const botPad = Math.max(0, (N - renderTo) * ROW_H);

  const clientFiltersActive =
    clientFilters.loan_number_status !== "all" || clientFilters.loan_tags.length > 0;

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((data: { id: string; file_name: string; status: string }[]) =>
        setUploads(data.filter((u) => u.status === "completed"))
      )
      .catch(console.error);
    fetch("/api/cc-allocation-splits")
      .then((r) => r.json())
      .then((data: SplitEntry[]) => setAllSplits(data))
      .catch(console.error);
  }, []);

  // Filter-options: only re-fetch when selectedUpload changes.
  // Sync to ref immediately so the next fetchAll has correct costCenters.
  useEffect(() => {
    const params = selectedUpload ? `?uploadId=${selectedUpload}` : "";
    fetch(`/api/transactions/filter-options${params}`)
      .then((r) => r.json())
      .then((v: FilterOptionsResponse) => {
        filterOptsRef.current = v;
        setFilterOpts(v);
      })
      .catch(console.error);
  }, [selectedUpload]);

  // fetchAll only depends on server-side params — NOT on filterOpts (uses ref instead).
  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError("");
    if (containerRef.current) { containerRef.current.scrollTop = 0; setScrollTop(0); }
    try {
      const p = buildParams(selectedUpload, serverFilters, filterOptsRef.current.costCenters, activeBranches);
      const res = await fetch(`/api/transactions?${p}`);
      if (seq !== fetchSeq.current) return; // stale — a newer fetch is in flight
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Request failed"); return; }
      const json = await res.json() as { data: PLTransaction[]; totals: TransactionTotals };
      if (seq !== fetchSeq.current) return; // stale
      setRows(json.data);
      setTotals(json.totals);
    } catch (err) {
      if (seq === fetchSeq.current) setError(String(err));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  // filterOptsRef is a ref (not reactive) — intentionally excluded from deps.
  // activeBranches is a dep so global branch changes trigger a re-fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUpload, serverFilters, activeBranches]);

  // Only run auto-fetch once the branch filter has resolved its initial state.
  // Without this guard, fetchAll fires with activeBranches=[] on mount, then
  // again when branches load — causing two simultaneous fetches that race.
  useEffect(() => {
    if (!branchFilterLoaded) return;
    fetchAll();
  }, [branchFilterLoaded, fetchAll]);

  function setSF<K extends keyof ServerFilters>(key: K, value: ServerFilters[K]) {
    setServerFilters((prev) => ({ ...prev, [key]: value }));
  }
  function setCF<K extends keyof ClientFilters>(key: K, value: ClientFilters[K]) {
    setClientFilters((prev) => ({ ...prev, [key]: value }));
  }

  const ccFilterOptions = ["Unassigned", "Conflict", ...filterOpts.costCenters.map((cc) => cc.name)];
  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  function handleExport() {
    const data = displayedRows.map((r) => ({
      ...r,
      cost_center_name: (r.cost_centers as { name: string } | null)?.name ?? "",
    })) as Record<string, unknown>[];
    downloadCSV("transactions.csv", data, [
      { key: "journal_post_date", label: "Date" },
      { key: "month",             label: "Month" },
      { key: "branch",            label: "Branch" },
      { key: "gl_code",           label: "GL Code" },
      { key: "gl_name",           label: "GL Name" },
      { key: "vendor",            label: "Vendor" },
      { key: "check_description", label: "Description" },
      { key: "check_description_2", label: "CD2" },
      { key: "check_description_3", label: "CD3" },
      { key: "ref_numb",          label: "Ref #" },
      { key: "loan_number",       label: "Loan #" },
      { key: "loan_number_raw",   label: "Loan # Raw" },
      { key: "loan_number_incomplete", label: "Loan # Incomplete" },
      { key: "debit",             label: "Debit" },
      { key: "credit",            label: "Credit" },
      { key: "movement",          label: "Movement" },
      { key: "source",            label: "Source" },
      { key: "cost_center_name",  label: "Cost Center" },
      { key: "cost_center_status",label: "CC Status" },
    ]);
  }

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-32px)]">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Transaction Review</h2>
          <p className="text-sm text-gray-500">
            {loading
              ? "Loading…"
              : clientFiltersActive
                ? `${N.toLocaleString()} of ${rows.length.toLocaleString()} rows`
                : `${rows.length.toLocaleString()} rows`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedUpload}
            onChange={(e) => {
              setSelectedUpload(e.target.value);
              setServerFilters(emptyServer());
              setClientFilters(emptyClient());
            }}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
          >
            <option value="">All uploads</option>
            {uploads.map((u) => <option key={u.id} value={u.id}>{u.file_name}</option>)}
          </select>
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          {rows.length > 0 && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              <Download size={14} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 gap-3 shrink-0 max-w-xs">
        <TotalCard label="Net movement" value={totals.movement}
          colorClass={totals.movement >= 0 ? "text-green-700" : "text-red-700"} />
      </div>

      {error && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600 shrink-0">{error}</p>
      )}

      {/* Virtual scroll table */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm min-h-0"
        onScroll={onScroll}
      >
        <table className="text-xs table-fixed border-collapse" style={{ minWidth: "100%", width: "max-content" }}>
          <colgroup>
            {/* CC | Month | Year | GL Code | GL Name | Branch | Desc | CD2 | CD3 | Vendor | Ref | Movement | Loan# | Loan Tags | Source */}
            {["160px","72px","52px","80px","150px","72px","230px","120px","120px","130px","80px","100px","140px","160px","72px"].map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20 bg-gray-50">
            <tr className="border-b border-gray-200 text-gray-500">
              <TH label="Cost Center">
                <ColumnFilter label="Cost Center" type="categorical"
                  options={ccFilterOptions} selected={serverFilters.cost_center}
                  onChange={(v) => setSF("cost_center", v)} />
              </TH>
              <TH label="Month">
                <ColumnFilter label="Month" type="categorical"
                  options={filterOpts.month} selected={serverFilters.month}
                  onChange={(v) => setSF("month", v)} />
              </TH>
              <TH label="Year">
                <ColumnFilter label="Year" type="categorical"
                  options={filterOpts.year} selected={serverFilters.year}
                  onChange={(v) => setSF("year", v)} />
              </TH>
              <TH label="GL Code">
                <ColumnFilter label="GL Code" type="categorical"
                  options={filterOpts.gl_code} selected={serverFilters.gl_code}
                  onChange={(v) => setSF("gl_code", v)} />
              </TH>
              <TH label="GL Name">
                <ColumnFilter label="GL Name" type="categorical"
                  options={filterOpts.gl_name} selected={serverFilters.gl_name}
                  onChange={(v) => setSF("gl_name", v)} />
              </TH>
              <TH label="Branch">
                <ColumnFilter label="Branch" type="categorical"
                  options={filterOpts.branch} selected={serverFilters.branch}
                  onChange={(v) => setSF("branch", v)} />
              </TH>
              <TH label="Description">
                <button
                  onClick={() => setDescSort(d => d === null ? "asc" : d === "asc" ? "desc" : null)}
                  title={descSort === null ? "Sort A→Z" : descSort === "asc" ? "Sort Z→A" : "Clear sort"}
                  className="ml-0.5 text-gray-400 hover:text-blue-600"
                >
                  {descSort === "asc"  ? <ArrowUpAZ   size={11} className="text-blue-500" /> :
                   descSort === "desc" ? <ArrowDownAZ size={11} className="text-blue-500" /> :
                                         <ChevronsUpDown size={11} />}
                </button>
                <ColumnFilter label="Description" type="text"
                  value={serverFilters.description}
                  onChange={(v) => setSF("description", v)} />
              </TH>
              <TH label="Check Desc 2">
                <ColumnFilter label="Check Desc 2" type="categorical"
                  options={filterOpts.check_description_2 ?? []} selected={serverFilters.check_description_2}
                  onChange={(v) => setSF("check_description_2", v)} />
              </TH>
              <TH label="Check Desc 3">
                <ColumnFilter label="Check Desc 3" type="categorical"
                  options={filterOpts.check_description_3 ?? []} selected={serverFilters.check_description_3}
                  onChange={(v) => setSF("check_description_3", v)} />
              </TH>
              <TH label="Vendor">
                <ColumnFilter label="Vendor" type="categorical"
                  options={filterOpts.vendor} selected={serverFilters.vendor}
                  onChange={(v) => setSF("vendor", v)} />
              </TH>
              <TH label="Ref Numb">
                <ColumnFilter label="Ref Numb" type="categorical"
                  options={filterOpts.ref_numb} selected={serverFilters.ref_numb}
                  onChange={(v) => setSF("ref_numb", v)} />
              </TH>
              <TH label="Movement" className="text-right">
                <ColumnFilter label="Movement" type="numeric"
                  min={serverFilters.movement_min} max={serverFilters.movement_max}
                  onChange={(min, max) => { setSF("movement_min", min); setSF("movement_max", max); }} />
              </TH>
              <TH label="Loan #">
                <LoanNumStatusPicker
                  value={clientFilters.loan_number_status}
                  onChange={(v) => setCF("loan_number_status", v)}
                />
              </TH>
              <TH label="Loan Tags">
                <ColumnFilter label="Loan Tags" type="categorical"
                  options={LOAN_TAG_OPTIONS} selected={clientFilters.loan_tags}
                  onChange={(v) => setCF("loan_tags", v)} />
              </TH>
              <TH label="Source">
                <ColumnFilter label="Source" type="categorical"
                  options={["Original", "Addback", "Offshore", "Manual Entry", "Employee Fee"]} selected={serverFilters.source}
                  onChange={(v) => setSF("source", v)} />
              </TH>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr style={{ height: 200 }}>
                <td colSpan={COL_COUNT} className="text-center align-middle text-gray-400">
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
                  <span className="ml-2">Loading all transactions…</span>
                </td>
              </tr>
            ) : N === 0 ? (
              <tr style={{ height: 120 }}>
                <td colSpan={COL_COUNT} className="text-center align-middle text-gray-400">
                  No transactions found with the current filters.
                </td>
              </tr>
            ) : (
              <>
                {topPad > 0 && (
                  <tr aria-hidden="true"><td colSpan={COL_COUNT} style={{ height: topPad, padding: 0 }} /></tr>
                )}
                {visibleRows.map((tx) => (
                  <tr
                    key={tx.id}
                    style={{ height: ROW_H }}
                    className={[
                      "border-b border-gray-50 hover:bg-blue-50/20",
                      !tx.category_1 ? "bg-gray-50/50" : "",
                    ].join(" ")}
                  >
                    <td className="px-2 py-0 overflow-hidden"><CCCell tx={tx} splitsMap={splitsMap} /></td>
                    <td className="px-2 py-0 text-gray-700 overflow-hidden whitespace-nowrap">{tx.month ?? "—"}</td>
                    <td className="px-2 py-0 text-gray-700 overflow-hidden whitespace-nowrap">{tx.year ?? "—"}</td>
                    <td className="px-2 py-0 font-mono text-gray-800 overflow-hidden whitespace-nowrap">{tx.gl_code ?? "—"}</td>
                    <td className="px-2 py-0 text-gray-700 overflow-hidden whitespace-nowrap truncate" title={tx.gl_name ?? ""}>{tx.gl_name ?? "—"}</td>
                    <td className="px-2 py-0 text-gray-700 overflow-hidden whitespace-nowrap">{tx.branch ?? "—"}</td>
                    <td className="px-2 py-0 text-gray-600 overflow-hidden whitespace-nowrap truncate" title={tx.check_description ?? ""}>{tx.check_description ?? "—"}</td>
                    <td className="px-2 py-0 text-sky-700 overflow-hidden whitespace-nowrap truncate" title={tx.check_description_2 ?? ""}>{tx.check_description_2 ?? <span className="text-gray-300">—</span>}</td>
                    <td className="px-2 py-0 text-sky-600 overflow-hidden whitespace-nowrap truncate" title={tx.check_description_3 ?? ""}>{tx.check_description_3 ?? <span className="text-gray-300">—</span>}</td>
                    <td className="px-2 py-0 text-gray-600 overflow-hidden whitespace-nowrap truncate" title={tx.vendor ?? ""}>{tx.vendor ?? "—"}</td>
                    <td className="px-2 py-0 font-mono text-gray-600 overflow-hidden whitespace-nowrap">{tx.ref_numb ?? "—"}</td>
                    <td className={`px-2 py-0 text-right font-mono overflow-hidden whitespace-nowrap ${mvColor(tx.movement)}`}>{fmt(tx.movement)}</td>
                    <td className="px-2 py-0 overflow-hidden whitespace-nowrap font-mono">
                      {tx.loan_number ? (
                        tx.loan_number_incomplete ? (
                          <span className="flex items-center gap-1">
                            <AlertTriangle size={10} className="shrink-0 text-gray-400" />
                            <span className="text-gray-600 text-[10px]">{tx.loan_number}</span>
                            <button
                              onClick={(e) => openResolvePicker(e, tx)}
                              className="ml-0.5 rounded px-1 py-px text-[9px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200 whitespace-nowrap"
                              title="Assign correct loan number"
                            >
                              Resolve
                            </button>
                          </span>
                        ) : (
                          <span className="text-gray-700">{tx.loan_number}</span>
                        )
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <LoanTagsCell tx={tx} />
                    <td className="px-2 py-0 overflow-hidden whitespace-nowrap">
                      {tx.source === "addback" ? (
                        <span className="rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-700">Addback</span>
                      ) : tx.source === "offshore_allocations" ? (
                        <span className="rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-700">Offshore</span>
                      ) : tx.source === "manual_entry" ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-700">Manual</span>
                          <button
                            onClick={() => setEditingManualTx(tx)}
                            title="Edit"
                            className="rounded p-px text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={() => handleDeleteManual(tx)}
                            title="Delete"
                            className="rounded p-px text-gray-400 hover:text-red-600 hover:bg-red-50"
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      ) : (
                        <span className="text-gray-400 text-[10px]">Original</span>
                      )}
                    </td>
                  </tr>
                ))}
                {botPad > 0 && (
                  <tr aria-hidden="true"><td colSpan={COL_COUNT} style={{ height: botPad, padding: 0 }} /></tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Loan number resolution picker — portal rendered, stays above virtual scroll */}
      {resolvingTx && resolveAnchor && (
        <LoanResolvePicker
          tx={resolvingTx}
          anchorEl={resolveAnchor}
          onResolved={handleLoanResolved}
          onClose={() => { setResolvingTx(null); setResolveAnchor(null); }}
        />
      )}

      {/* Manual entry edit modal */}
      {editingManualTx && (
        <ManualEntryEditModal
          tx={editingManualTx}
          onClose={() => setEditingManualTx(null)}
          onSaved={() => { setEditingManualTx(null); fetchAll(); }}
        />
      )}
    </div>
  );
}
