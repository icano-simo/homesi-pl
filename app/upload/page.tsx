"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, X, Trash2, RefreshCw } from "lucide-react";
import type { UploadPLResponse, AddbacksUploadResponse, OffshoreAllocationsUploadResponse, UploadLoanCountResponse, ManualAssignmentSummary, RelinkSummary } from "@/types";
import type { DuplicateInfo } from "@/lib/check-duplicate-upload";

type UploadStatus = "idle" | "uploading" | "success" | "error";

// ─── Stat card ────────────────────────────────────────────────────────────────

function Stat({ value, label, warn = false }: { value: number; label: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-green-100 bg-white p-3">
      <p className={`text-2xl font-bold ${warn ? "text-gray-500" : "text-gray-900"}`}>
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

// ─── Orphaned note summary (shown when a re-upload detached notes) ───────────

/**
 * Transaction-level notes survive a replace but lose their transaction. This
 * says what happened to them at the moment it happens — before, they simply
 * stopped appearing and nobody was told.
 */
function OrphanNotesBlock({ on }: { on: RelinkSummary }) {
  const unresolved = on.notesOrphaned + on.notesAmbiguous;
  const border = unresolved > 0 ? "border-amber-200" : "border-green-200";
  const bg     = unresolved > 0 ? "bg-amber-50"      : "bg-green-50";

  return (
    <div className={`rounded-lg border ${border} ${bg} px-3 py-2.5 space-y-1.5`}>
      <p className="text-xs font-semibold text-gray-700">Notes attached to transactions</p>
      {on.notesRelinked > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-green-700">
          <CheckCircle2 size={13} />
          Reattached automatically: {on.notesRelinked}
        </div>
      )}
      {on.notesAmbiguous > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-orange-700">
          <AlertCircle size={13} />
          Several transactions matched, left for review: {on.notesAmbiguous}
        </div>
      )}
      {on.notesOrphaned > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertCircle size={13} />
          No matching transaction found: {on.notesOrphaned}
        </div>
      )}
      {unresolved > 0 && (
        <p className="text-[11px] text-gray-500">
          These are listed under “Orphaned Notes” in P&amp;L Notes, where they can be
          re-linked by hand or discarded. Nothing was deleted.
        </p>
      )}
    </div>
  );
}

// ─── Manual assignment summary (shown after Replace) ─────────────────────────

function ManualAssignmentBlock({ ma }: { ma: ManualAssignmentSummary }) {
  const notFound       = ma.manual_not_found      + ma.conflict_resolved_not_found;
  const requiresReview = ma.manual_requires_review + ma.conflict_resolved_requires_review;
  const allGood        = notFound === 0 && requiresReview === 0;

  const borderColor = requiresReview > 0 ? "border-orange-200" : notFound > 0 ? "border-yellow-200" : "border-green-200";
  const bgColor     = requiresReview > 0 ? "bg-orange-50"      : notFound > 0 ? "bg-yellow-50"      : "bg-green-50";

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} px-3 py-2.5 space-y-1.5`}>
      <p className="text-xs font-semibold text-gray-700">Assignments after replace</p>
      {ma.manual_reapplied > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-green-700">
          <CheckCircle2 size={13} />
          Manual assignments restored: {ma.manual_reapplied}
        </div>
      )}
      {ma.conflict_resolved_reapplied > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-green-700">
          <CheckCircle2 size={13} />
          Conflict resolutions restored: {ma.conflict_resolved_reapplied}
        </div>
      )}
      {notFound > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-yellow-700">
          <AlertCircle size={13} />
          Not found (no longer in file): {notFound}
        </div>
      )}
      {requiresReview > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs text-orange-700">
            <AlertCircle size={13} />
            Requires manual review: {requiresReview}
          </div>
          <p className="pl-5 text-[11px] text-orange-600">Find these in Cost Center Assignment → Unassigned</p>
        </div>
      )}
      {allGood && ma.total_snapshotted > 0 && (
        <p className="text-xs text-green-700">All {ma.total_snapshotted} assignment(s) restored successfully.</p>
      )}
      {allGood && ma.total_snapshotted === 0 && (
        <p className="text-xs text-gray-500">No manual assignments in the replaced upload.</p>
      )}
    </div>
  );
}

// ─── Duplicate dialog ─────────────────────────────────────────────────────────

function DuplicateDialog({
  info,
  onReplace,
  onForce,
  onCancel,
}: {
  info: DuplicateInfo;
  onReplace: () => void;
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} className="shrink-0 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900">Possible duplicate upload</h3>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm space-y-1.5">
          <p className="font-medium text-gray-800">Existing upload found:</p>
          <p className="text-gray-700">
            <span className="font-medium">{info.file_name}</span>
          </p>
          <p className="text-gray-600 text-xs">
            Uploaded: {new Date(info.uploaded_at).toLocaleString()} ·{" "}
            {info.row_count != null ? `${info.row_count.toLocaleString()} rows` : "unknown rows"}
          </p>
          {info.overlap.length > 0 && (
            <p className="text-gray-600 text-xs">
              Overlapping periods: {info.overlap.join(", ")}
            </p>
          )}
        </div>

        <p className="mt-4 text-sm text-gray-600">
          Choose how to proceed:
        </p>

        <div className="mt-3 space-y-2">
          <button
            onClick={onReplace}
            className="flex w-full items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            <span>Replace existing</span>
            <span className="text-xs font-normal text-red-500">Deletes the old upload first</span>
          </button>
          <button
            onClick={onForce}
            className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <span>Upload anyway</span>
            <span className="text-xs font-normal text-gray-400">Keep both uploads</span>
          </button>
          <button
            onClick={onCancel}
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Upload section ───────────────────────────────────────────────────────────

interface UploadSectionProps {
  endpoint: string;
  title: string;
  description: string;
  infoItems: string[];
  onUploadComplete?: () => void;
}

function UploadSection({ endpoint, title, description, infoItems, onUploadComplete }: UploadSectionProps) {
  const [file, setFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [result, setResult] = useState<UploadPLResponse | AddbacksUploadResponse | OffshoreAllocationsUploadResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pendingDupe, setPendingDupe] = useState<DuplicateInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File | null) {
    if (!f) return;
    setFile(f);
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
    setPendingDupe(null);
    f.arrayBuffer().then(setFileBuffer).catch(() => setFileBuffer(null));
  }

  async function doUpload(url: string) {
    if (!file) return;
    setStatus("uploading");
    setPendingDupe(null);
    const fd = new FormData();
    if (fileBuffer) {
      fd.append("file", new Blob([fileBuffer], { type: file.type }), file.name);
    } else {
      fd.append("file", file);
    }
    try {
      const res = await fetch(url, { method: "POST", body: fd });
      const json = await res.json();
      if (res.status === 409 && json.duplicate) {
        setStatus("idle");
        setPendingDupe(json.info as DuplicateInfo);
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(json.error ?? "Unknown error");
        return;
      }
      setResult(json);
      setStatus("success");
      onUploadComplete?.();
    } catch (err) {
      setStatus("error");
      setErrorMsg(String(err));
    }
  }

  function handleUpload() {
    doUpload(endpoint);
  }

  function reset() {
    setFile(null);
    setFileBuffer(null);
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
    setPendingDupe(null);
  }

  return (
    <div className="space-y-4">
      {pendingDupe && (
        <DuplicateDialog
          info={pendingDupe}
          onReplace={() => doUpload(`${endpoint}?replace_id=${pendingDupe.upload_id}`)}
          onForce={() => doUpload(`${endpoint}?force=true`)}
          onCancel={() => { setPendingDupe(null); setStatus("idle"); }}
        />
      )}

      <div>
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-500">{description}</p>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0] ?? null); }}
        onClick={() => inputRef.current?.click()}
        className={[
          "cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors",
          dragging
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-white hover:border-blue-300 hover:bg-gray-50",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        <FileSpreadsheet size={36} className="mx-auto text-gray-300" />
        <p className="mt-2 text-sm font-medium text-gray-600">
          {file ? file.name : "Drag here or click to select"}
        </p>
        <p className="mt-1 text-xs text-gray-400">Accepted formats: .xlsx, .xls</p>
      </div>

      {file && status === "idle" && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-gray-700">
            <FileSpreadsheet size={16} className="text-green-500" />
            <span className="font-medium">{file.name}</span>
            <span className="text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); reset(); }}
            className="text-gray-400 hover:text-red-500"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {file && status !== "success" && (
        <button
          onClick={handleUpload}
          disabled={status === "uploading"}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "uploading" ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Processing…
            </>
          ) : (
            <>
              <Upload size={16} /> Upload &amp; process
            </>
          )}
        </button>
      )}

      {status === "success" && result && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-5 space-y-3">
          <div className="flex items-center gap-2 font-semibold text-green-700">
            <CheckCircle2 size={18} /> Upload complete
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat value={result.rowCount} label="Rows loaded" />
            <Stat value={result.uncategorizedCount} label="Uncategorized" warn={result.uncategorizedCount > 0} />
            <Stat value={result.unknownBranchCount} label="Unknown branch" warn={result.unknownBranchCount > 0} />
          </div>
          {result.parseWarnings > 0 && (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {result.parseWarnings} row(s) had parse warnings and were skipped.
            </p>
          )}
          {(result.uncategorizedCount > 0 || result.unknownBranchCount > 0) && (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Some rows are uncategorized. Review GL Mapping and Branches in Settings.
            </p>
          )}
          {result.manualAssignments && <ManualAssignmentBlock ma={result.manualAssignments} />}
          {result.orphanNotes && <OrphanNotesBlock on={result.orphanNotes} />}
          {"employeeFeeLines" in result && result.employeeFeeLines && (
            <p className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              Employee fee lines generated: {result.employeeFeeLines.employees} employee{result.employeeFeeLines.employees !== 1 ? "s" : ""} × {result.employeeFeeLines.months} new month{result.employeeFeeLines.months !== 1 ? "s" : ""} = {result.employeeFeeLines.transactions} transactions
            </p>
          )}
          <button
            onClick={reset}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Upload another file
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-center gap-2 font-semibold text-red-700">
            <AlertCircle size={18} /> Processing error
          </div>
          <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
          <button
            onClick={() => setStatus("idle")}
            className="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      <div className="rounded-xl border border-gray-100 bg-white p-4 text-sm text-gray-500 space-y-1.5">
        <p className="font-semibold text-gray-700">What does this upload do?</p>
        <ol className="list-decimal list-inside space-y-1">
          {infoItems.map((item, i) => <li key={i}>{item}</li>)}
        </ol>
      </div>
    </div>
  );
}

// ─── Loan Count upload section ───────────────────────────────────────────────

type LoanDupeInfo = { month: string; year: number; existing_count: number };

function LoanCountUploadSection({ onUploadComplete }: { onUploadComplete?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [result, setResult] = useState<UploadLoanCountResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pendingDupe, setPendingDupe] = useState<LoanDupeInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File | null) {
    if (!f) return;
    setFile(f); setStatus("idle"); setResult(null); setErrorMsg(""); setPendingDupe(null);
    f.arrayBuffer().then(setFileBuffer).catch(() => setFileBuffer(null));
  }

  async function doUpload(url: string) {
    if (!file) return;
    setStatus("uploading");
    setPendingDupe(null);
    const fd = new FormData();
    if (fileBuffer) fd.append("file", new Blob([fileBuffer], { type: file.type }), file.name);
    else fd.append("file", file);
    try {
      const res = await fetch(url, { method: "POST", body: fd });
      const json = await res.json();
      if (res.status === 409 && json.duplicate) {
        setStatus("idle");
        setPendingDupe(json.info as LoanDupeInfo);
        return;
      }
      if (!res.ok) { setStatus("error"); setErrorMsg(json.error ?? "Unknown error"); return; }
      setResult(json as UploadLoanCountResponse);
      setStatus("success");
      onUploadComplete?.();
    } catch (err) {
      setStatus("error"); setErrorMsg(String(err));
    }
  }

  function handleUpload() { doUpload("/api/upload-loan-count"); }

  function reset() {
    setFile(null); setFileBuffer(null); setStatus("idle"); setResult(null); setErrorMsg(""); setPendingDupe(null);
  }

  return (
    <div className="space-y-4">
      {pendingDupe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle size={18} className="shrink-0 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900">Existing data found</h3>
              </div>
              <button onClick={() => { setPendingDupe(null); setStatus("idle"); }} className="text-gray-400 hover:text-gray-600">
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm space-y-1.5">
              <p className="font-medium text-gray-800">
                {pendingDupe.month} {pendingDupe.year} already has {pendingDupe.existing_count.toLocaleString()} loan records.
              </p>
              <p className="text-gray-600 text-xs">
                Replacing will delete all existing records for that period and load the new file.
              </p>
            </div>
            <div className="mt-4 space-y-2">
              <button
                onClick={() => doUpload("/api/upload-loan-count?force=true")}
                className="flex w-full items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
              >
                <span>Replace existing</span>
                <span className="text-xs font-normal text-red-500">Deletes {pendingDupe.existing_count.toLocaleString()} records first</span>
              </button>
              <button
                onClick={() => { setPendingDupe(null); setStatus("idle"); }}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <div>
        <h3 className="text-base font-semibold text-gray-900">Loan Count</h3>
        <p className="text-sm text-gray-500">
          Monthly loan master list (18 columns). Triggers loan number completion on all P&L transactions.
        </p>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0] ?? null); }}
        onClick={() => inputRef.current?.click()}
        className={[
          "cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors",
          dragging ? "border-blue-400 bg-blue-50" : "border-gray-300 bg-white hover:border-blue-300 hover:bg-gray-50",
        ].join(" ")}
      >
        <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
        <FileSpreadsheet size={36} className="mx-auto text-gray-300" />
        <p className="mt-2 text-sm font-medium text-gray-600">{file ? file.name : "Drag here or click to select"}</p>
        <p className="mt-1 text-xs text-gray-400">Accepted formats: .xlsx, .xls</p>
      </div>

      {file && status === "idle" && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-gray-700">
            <FileSpreadsheet size={16} className="text-green-500" />
            <span className="font-medium">{file.name}</span>
            <span className="text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span>
          </div>
          <button onClick={(e) => { e.stopPropagation(); reset(); }} className="text-gray-400 hover:text-red-500">
            <X size={16} />
          </button>
        </div>
      )}

      {file && status !== "success" && (
        <button onClick={handleUpload} disabled={status === "uploading"}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {status === "uploading"
            ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> Processing…</>
            : <><Upload size={16} /> Upload &amp; process</>}
        </button>
      )}

      {status === "success" && result && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-5 space-y-3">
          <div className="flex items-center gap-2 font-semibold text-green-700">
            <CheckCircle2 size={18} /> Upload complete — {result.month ?? "—"} {result.year ?? ""}
          </div>

          {/* Merge stats */}
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <div className="rounded-lg border border-green-100 bg-white p-2.5">
              <p className="text-lg font-bold text-gray-900">{result.merge.inserted}</p>
              <p className="text-gray-500">New loans</p>
            </div>
            <div className="rounded-lg border border-green-100 bg-white p-2.5">
              <p className="text-lg font-bold text-gray-900">{result.merge.updated}</p>
              <p className="text-gray-500">Updated</p>
            </div>
            <div className="rounded-lg border border-green-100 bg-white p-2.5">
              <p className={`text-lg font-bold ${result.merge.preserved_fields > 0 ? "text-blue-600" : "text-gray-900"}`}>
                {result.merge.preserved_fields}
              </p>
              <p className="text-gray-500">Fields preserved</p>
            </div>
            <div className="rounded-lg border border-green-100 bg-white p-2.5">
              <p className="text-lg font-bold text-gray-900">{result.merge.removed}</p>
              <p className="text-gray-500">Removed</p>
            </div>
          </div>

          {result.merge.kept_historical > 0 && (
            <p className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              {result.merge.kept_historical} loan number{result.merge.kept_historical !== 1 ? "s" : ""} not in new file were kept because they had manual edits.
            </p>
          )}
          {result.warnings > 0 && (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              {result.warnings} row(s) skipped (invalid loan number format).
            </p>
          )}
          {result.completion.processed > 0 && (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800 space-y-1">
              <p className="font-semibold">Loan number completion — {result.completion.processed} P&L transactions processed:</p>
              <ul className="space-y-0.5 pl-2">
                <li>✓ {result.completion.completed_direct} had 12-digit loan numbers (copied directly)</li>
                {result.completion.completed_from_10 > 0 && (
                  <li>✓ {result.completion.completed_from_10} 10-digit numbers completed to 12 digits</li>
                )}
                {result.completion.completed_from_9 > 0 && (
                  <li>✓ {result.completion.completed_from_9} 9-digit numbers completed to 12 digits</li>
                )}
                {result.completion.incomplete_no_match > 0 && (
                  <li className="text-gray-600">⚠{result.completion.incomplete_no_match} partial loan numbers with no match in Loan Count (loan_number_incomplete)</li>
                )}
                {result.completion.incomplete_ambiguous > 0 && (
                  <li className="text-gray-600">⚠{result.completion.incomplete_ambiguous} partial loan numbers with multiple possible matches — loan_number_incomplete (más frecuente en 9 dígitos)</li>
                )}
              </ul>
            </div>
          )}
          <button onClick={reset}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Upload another file
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-center gap-2 font-semibold text-red-700">
            <AlertCircle size={18} /> Processing error
          </div>
          <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
          <button onClick={() => setStatus("idle")}
            className="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Retry
          </button>
        </div>
      )}

      <div className="rounded-xl border border-gray-100 bg-white p-4 text-sm text-gray-500 space-y-1.5">
        <p className="font-semibold text-gray-700">What does this upload do?</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Replaces existing loan data for the same month/year (safe to re-upload).</li>
          <li>Stores branch, borrower, loan officer, loan program, loan type, and five Yes/No flags.</li>
          <li>Runs loan number completion: 12-digit raw → copied directly; 10-digit raw → matched to unique 12-digit entry.</li>
          <li>Marks unresolved or ambiguous loan numbers as loan_number_incomplete for audit.</li>
        </ol>
      </div>
    </div>
  );
}

// ─── Loan Count history ───────────────────────────────────────────────────────

type LoanCountPeriod = { month: string; year: number; count: number; last_updated: string };

function LoanCountHistory({ refreshKey }: { refreshKey: number }) {
  const [periods, setPeriods] = useState<LoanCountPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/loan-count-history");
      if (res.ok) setPeriods(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function handleDelete(month: string, year: number) {
    const key = `${month}|${year}`;
    setDeletingKey(key); setErrorMsg("");
    try {
      const res = await fetch(`/api/loan-count-history?month=${encodeURIComponent(month)}&year=${year}`, { method: "DELETE" });
      if (!res.ok) { const j = await res.json(); setErrorMsg(j.error ?? "Delete failed"); return; }
      setPeriods((prev) => prev.filter((p) => !(p.month === month && p.year === year)));
    } finally { setDeletingKey(null); setConfirmKey(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Loan Count History</h3>
        <button
          onClick={load}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {errorMsg && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{errorMsg}</p>
      )}

      {loading ? (
        <div className="py-8 text-center text-gray-400">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : periods.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">No loan count data uploaded yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium text-right">Loan records</th>
                <th className="px-4 py-3 font-medium">Last updated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => {
                const key = `${p.month}|${p.year}`;
                return (
                  <tr key={key} className="border-b border-gray-50 hover:bg-gray-50/60">
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {p.month} {p.year}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-700">
                      {p.count.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {p.last_updated ? new Date(p.last_updated).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {confirmKey === key ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="text-gray-500">Delete {p.count} records?</span>
                          <button
                            onClick={() => handleDelete(p.month, p.year)}
                            disabled={deletingKey === key}
                            className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
                          >
                            {deletingKey === key ? "…" : "Yes"}
                          </button>
                          <button
                            onClick={() => setConfirmKey(null)}
                            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-50"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmKey(key)}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50"
                          title="Delete all loan records for this period"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
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
}

// ─── Upload history ───────────────────────────────────────────────────────────

type UploadRecord = {
  id: string;
  file_name: string;
  source_type: "original" | "addback" | "offshore_allocations" | null;
  uploaded_at: string;
  row_count: number | null;
  status: string;
  error_message?: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  original: "GL Detail",
  addback: "Addback",
  offshore_allocations: "Offshore",
};

const SOURCE_COLOR: Record<string, string> = {
  original: "bg-gray-100 text-gray-700",
  addback: "bg-blue-100 text-blue-700",
  offshore_allocations: "bg-blue-100 text-blue-700",
};

function UploadHistory({ refreshKey }: { refreshKey: number }) {
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/uploads");
      if (res.ok) setUploads(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function handleDelete(id: string) {
    setDeletingId(id); setErrorMsg("");
    try {
      const res = await fetch(`/api/uploads/${id}`, { method: "DELETE" });
      if (!res.ok) { const j = await res.json(); setErrorMsg(j.error ?? "Delete failed"); return; }
      setUploads((prev) => prev.filter((u) => u.id !== id));
    } finally { setDeletingId(null); setConfirmId(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Upload History</h3>
        <button
          onClick={load}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {errorMsg && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{errorMsg}</p>
      )}

      {loading ? (
        <div className="py-8 text-center text-gray-400">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : uploads.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">No uploads yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">File name</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Uploaded at</th>
                <th className="px-4 py-3 font-medium text-right">Rows</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                  <td className="max-w-[220px] truncate px-4 py-2.5 font-medium text-gray-800" title={u.file_name}>
                    {u.file_name}
                  </td>
                  <td className="px-4 py-2.5">
                    {u.source_type ? (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_COLOR[u.source_type] ?? "bg-gray-100 text-gray-600"}`}>
                        {SOURCE_LABEL[u.source_type] ?? u.source_type}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">
                    {new Date(u.uploaded_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-700">
                    {u.row_count != null ? u.row_count.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {u.status === "completed" ? (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">Completed</span>
                    ) : u.status === "error" ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700" title={u.error_message ?? ""}>Error</span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">{u.status}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {confirmId === u.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-gray-500">Delete?</span>
                        <button
                          onClick={() => handleDelete(u.id)}
                          disabled={deletingId === u.id}
                          className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          {deletingId === u.id ? "…" : "Yes"}
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-50"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmId(u.id)}
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50"
                        title="Delete this upload and all its transactions"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const [historyKey, setHistoryKey] = useState(0);
  const [loanCountHistoryKey, setLoanCountHistoryKey] = useState(0);

  function refreshHistory() { setHistoryKey((k) => k + 1); }
  function refreshLoanCountHistory() { setLoanCountHistoryKey((k) => k + 1); }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Upload P&amp;L</h2>
        <p className="text-sm text-gray-500">
          Upload GL Detail Reports, Addback, or Offshore Allocation files to load transactions into the system.
        </p>
      </div>

      {/* ── GL Detail Report ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <UploadSection
          endpoint="/api/upload-pl"
          title="GL Detail Report"
          description="Export from the accounting system (.xlsx). Requires normalization before import."
          infoItems={[
            "Normalizes the report: filters subtotal rows, fill-down, splits GL Code / Branch.",
            "Joins each row against GL Mapping and Branches to assign categories and region.",
            "Applies Cost Center rules to classify each transaction.",
            "Saves all transactions tagged as source = Original.",
          ]}
          onUploadComplete={refreshHistory}
        />
      </div>

      {/* ── Addbacks ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <UploadSection
          endpoint="/api/upload-addbacks"
          title="Addbacks"
          description="Pre-formatted addback file. Required columns: GL Code, Branch, GL Name, Check Description, Debit, Credit, Month, Year."
          infoItems={[
            "Reads rows directly — no normalization needed (file is already clean).",
            "Joins each row against GL Mapping and Branches to assign categories and region.",
            "Applies Cost Center rules to classify each transaction.",
            "Saves all transactions tagged as source = Addback.",
          ]}
          onUploadComplete={refreshHistory}
        />
      </div>

      {/* ── Offshore Allocations ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <UploadSection
          endpoint="/api/upload-offshore-allocations"
          title="Offshore Allocations"
          description="Pre-formatted offshore allocation file. Required columns: GL Code, Branch, Movement, Month, Year."
          infoItems={[
            "Reads rows directly — no normalization needed (file is already clean).",
            "Applies sign transformation: debit = Movement value, credit = 0, movement = −Movement.",
            "Joins each row against GL Mapping and Branches to assign categories and region.",
            "Applies Cost Center rules to classify each transaction.",
            "Saves all transactions tagged as source = Offshore Allocations.",
          ]}
          onUploadComplete={refreshHistory}
        />
      </div>

      {/* ── Loan Count ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <LoanCountUploadSection onUploadComplete={refreshLoanCountHistory} />
      </div>

      {/* ── Loan Count History ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <LoanCountHistory refreshKey={loanCountHistoryKey} />
      </div>

      {/* ── Upload History (P&L / Addbacks / Offshore) ── */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6">
        <UploadHistory refreshKey={historyKey} />
      </div>
    </div>
  );
}
