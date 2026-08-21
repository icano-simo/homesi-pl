import { NextRequest, NextResponse } from "next/server";
import { normalizePL } from "@/lib/normalize-pl";
import { enrichTransactions } from "@/lib/enrich-transactions";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanOfficialFields, enrichTxWithLoanOfficials, fetchUploadTxsForRules } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import { createServerClient } from "@/lib/supabase-server";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import { checkDuplicateUpload, deleteUpload } from "@/lib/check-duplicate-upload";
import { relinkOrphanNotes } from "@/lib/relink-orphan-notes";
import { snapshotManualAssignments, reapplyManualSnapshot } from "@/lib/snapshot-manual-assignments";
import { runLoanNumberCompletion } from "@/lib/loan-number-completion";
import type { ApiError, UploadPLResponse, PLTransaction, SplitRuleWithDetails } from "@/types";
import { requireSession } from "@/lib/auth";

function apiError(message: string, status = 500): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  let uploadId: string | null = null;

  try {
    // ── 1. Parse multipart form ────────────────────────────────────────────
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return apiError("No file provided", 400);

    const { searchParams } = new URL(req.url);
    const force     = searchParams.get("force") === "true";
    const replaceId = searchParams.get("replace_id") ?? null;

    // ── 2. Normalize the Excel (needed for dupe check) ────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    const { rows, warnings, sheet, headers, missingColumns } = normalizePL(buffer);

    if (rows.length === 0) {
      return apiError("No data rows found after normalization", 422);
    }

    /**
     * Refuse a file whose columns were never recognised.
     *
     * This is the failure that produced 13.848 rows of nothing on 27 July and
     * did it again this month: with no matching sheet and the wrong headers,
     * every column reads as undefined, every row still counts, and the upload
     * reported "completed" having imported not one value.
     *
     * Two tests, and the first is exact. The header row either carries the
     * expected names or it does not — no threshold to argue about. The second
     * is a backstop for a file whose headers sit somewhere other than the first
     * row: measured across every upload in this database, a real one has 0,0%
     * of its rows without a GL code, without a branch and without a period,
     * while the broken one has 100,0% of all three. Half is nowhere near either.
     *
     * It runs before the pl_uploads record is created, so a refusal leaves
     * nothing behind — no row to clean up, and no "completed" to disbelieve.
     */
    const blank = (n: number) => n / rows.length;
    const noGl     = blank(rows.filter((r) => !String(r.gl_code ?? "").trim()).length);
    const noBranch = blank(rows.filter((r) => !String(r.branch ?? "").trim()).length);
    const noPeriod = blank(rows.filter((r) => r.year == null || !r.month).length);
    const UNMAPPED_LIMIT = 0.5;

    if (missingColumns.length > 0 ||
        noGl > UNMAPPED_LIMIT || noBranch > UNMAPPED_LIMIT || noPeriod > UNMAPPED_LIMIT) {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      const detail = missingColumns.length > 0
        ? `Columns not found: ${missingColumns.join(", ")}.`
        : `${pct(noGl)} of rows have no GL code, ${pct(noBranch)} no branch, ${pct(noPeriod)} no period.`;
      return apiError(
        `The columns of this file were not recognised, so nothing was imported. ` +
        `A GL Detail Report sheet is expected, with its headers on the first row. ` +
        `Read sheet "${sheet.name}"${sheet.matched ? "" : " (no sheet named “GL Detail” was found, so the first one was used)"}. ` +
        `${detail} ` +
        `Headers seen: ${headers.filter(Boolean).slice(0, 12).join(", ") || "(none)"}.`,
        422,
      );
    }

    // ── 3. Duplicate check (skip if force or replace) ─────────────────────
    if (!force && !replaceId) {
      const dupeResult = await checkDuplicateUpload(supabase, "original", rows);
      if (dupeResult.found) {
        return NextResponse.json({ duplicate: true, info: dupeResult.info }, { status: 409 });
      }
    }

    // ── 3b. Persist the manual assignments BEFORE anything is deleted ─────
    // The await is the invariant: snapshotManualAssignments writes the backup
    // rows and reads them back, and throws if the count does not match, so
    // control only reaches the delete below once the backup is confirmed on
    // disk. If it throws, nothing has been deleted yet and the upload aborts
    // with the old data intact.
    if (replaceId) await snapshotManualAssignments(supabase, replaceId);

    // ── 4. Delete replaced upload if requested ────────────────────────────
    if (replaceId) await deleteUpload(supabase, replaceId);

    // ── 5. Create upload record ───────────────────────────────────────────
    const { data: uploadRecord, error: insertErr } = await supabase
      .from("pl_uploads")
      .insert({ file_name: file.name, status: "processing" })
      .select("id")
      .single();

    if (insertErr || !uploadRecord) {
      return apiError("Failed to create upload record");
    }
    // uploadRecord.id is always a UUID string; cast needed because Supabase
    // types don't distinguish non-null columns from nullable ones here.
    const id = uploadRecord.id as string;
    uploadId = id;

    // ── 6. Fetch lookup tables in parallel ────────────────────────────────
    const [{ data: glMappings }, { data: branches }] = await Promise.all([
      supabase.from("gl_mapping").select("*"),
      supabase.from("branches").select("*"),
    ]);

    // ── 7. Enrich rows with category / region data (pure function) ────────
    const { transactions, uncategorizedCount, unknownBranchCount } =
      enrichTransactions(rows, glMappings ?? [], branches ?? [], id);

    // ── 6. Batch-insert in chunks to stay within payload limits ───────────
    for (let i = 0; i < transactions.length; i += INSERT_CHUNK_SIZE) {
      const chunk = transactions.slice(i, i + INSERT_CHUNK_SIZE);
      const { error: chunkErr } = await supabase
        .from("pl_transactions")
        .insert(chunk);
      if (chunkErr) throw new Error(`Insert error (chunk ${i}): ${chunkErr.message}`);
    }

    // ── 6b. Resolve loan_number_raw → loan_number for this upload ────────
    await runLoanNumberCompletion(supabase, { uploadId: id });

    // ── 7. Apply cost center rules to the newly inserted transactions ─────
    const [splitRules, loMap] = await Promise.all([
      loadAllSplitRules(supabase),
      loadLoanOfficialFields(supabase),
    ]);

    // Paged: an unbounded select stops at 1000 rows, which would leave every
    // row past the first thousand of a large file without rule evaluation.
    const newTxs = await fetchUploadTxsForRules(supabase, id);

    if (newTxs.length > 0) {
      const ruleSplitEntries: RuleSplitEntry[] = [];
      const ccUpdates = newTxs.map((tx) => {
        const txId = (tx as unknown as { id: string }).id;
        const enriched = enrichTxWithLoanOfficials(tx as unknown as Record<string, unknown>, loMap);
        const r = evaluateCostCenterRules(enriched as unknown as PLTransaction, splitRules as SplitRuleWithDetails[]);
        const origin = r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";
        if (r.rule_splits) ruleSplitEntries.push({ transaction_id: txId, splits: r.rule_splits });
        return {
          id: txId,
          cost_center_id: r.cost_center_id,
          cost_center_status: r.cost_center_status,
          cost_center_conflicts: r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null,
          assignment_origin: origin,
          conflict_type: r.conflict_type ?? null,
        };
      });
      for (let i = 0; i < ccUpdates.length; i += INSERT_CHUNK_SIZE) {
        await Promise.all(
          ccUpdates.slice(i, i + INSERT_CHUNK_SIZE).map((u) =>
            supabase.from("pl_transactions")
              .update({
                cost_center_id: u.cost_center_id,
                cost_center_status: u.cost_center_status,
                cost_center_conflicts: u.cost_center_conflicts,
                assignment_origin: u.assignment_origin,
                conflict_type: u.conflict_type,
              })
              .eq("id", u.id)
          )
        );
      }
      await syncRuleSplitAllocations(supabase, ccUpdates.map((u) => u.id), ruleSplitEntries);
    }

    // ── 7b. Re-apply manual snapshot after rule assignment ────────────────
    // Reads the pending backup rows from the table rather than an in-memory
    // array, so a run that died earlier can be resumed by uploading again.
    const manualSummary = replaceId
      ? await reapplyManualSnapshot(supabase, id, replaceId)
      : null;

    // ── 7c. Reattach notes orphaned by a replaced upload ──────────────────
    // Runs unconditionally, not only for replacements: sweeping every orphan
    // heals notes stranded by an earlier replace as soon as their transaction
    // reappears in any later file.
    const relinkSummary = await relinkOrphanNotes(supabase, id);

    // ── 8. Mark upload as completed ───────────────────────────────────────
    await supabase
      .from("pl_uploads")
      .update({ status: "completed", row_count: rows.length })
      .eq("id", id);

    const response: UploadPLResponse = {
      uploadId: id,
      rowCount: rows.length,
      uncategorizedCount,
      unknownBranchCount,
      parseWarnings: warnings.length,
    };
    if (manualSummary) response.manualAssignments = manualSummary;
    if (relinkSummary.notesConsidered > 0) response.orphanNotes = relinkSummary;
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[upload-pl]", message);

    if (uploadId) {
      await createServerClient()
        .from("pl_uploads")
        .update({ status: "error", error_message: message })
        .eq("id", uploadId);
    }
    return apiError(message);
  }
}
