import { NextRequest, NextResponse } from "next/server";
import { parseOffshoreAllocations } from "@/lib/parse-offshore-allocations";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanOfficialFields, enrichTxWithLoanOfficials } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import { createServerClient } from "@/lib/supabase-server";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import { checkDuplicateUpload, deleteUpload } from "@/lib/check-duplicate-upload";
import { snapshotManualAssignments, reapplyManualSnapshot } from "@/lib/snapshot-manual-assignments";
import { generateEmployeeFeeLines } from "@/lib/generate-employee-fee-lines";
import { applyOASplits } from "@/lib/apply-oa-splits";
import { resyncEmployeeSplits } from "@/lib/resync-employee-splits";
import type {
  OffshoreAllocationsUploadResponse,
  ApiError,
  PLTransaction,
  SplitRuleWithDetails,
  GLMapping,
  Branch,
} from "@/types";

function apiError(message: string, status = 500): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
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

    // ── 2. Parse offshore allocations Excel ───────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    const { rows, warnings } = parseOffshoreAllocations(buffer);

    if (rows.length === 0) {
      return apiError(
        "No valid rows found. Verify the file has columns: GL Code, Branch, Movement, Month, Year.",
        422
      );
    }

    // ── 3. Duplicate check ────────────────────────────────────────────────
    if (!force && !replaceId) {
      const dupeResult = await checkDuplicateUpload(supabase, "offshore_allocations", rows);
      if (dupeResult.found) {
        return NextResponse.json({ duplicate: true, info: dupeResult.info }, { status: 409 });
      }
    }
    // ── 3b. Snapshot manual assignments before deleting the old upload ────
    const manualSnapshot = replaceId
      ? await snapshotManualAssignments(supabase, replaceId)
      : [];
    if (replaceId) await deleteUpload(supabase, replaceId);

    // ── 4. Create upload record ───────────────────────────────────────────
    const { data: uploadRecord, error: insertErr } = await supabase
      .from("pl_uploads")
      .insert({ file_name: file.name, status: "processing" })
      .select("id")
      .single();

    if (insertErr || !uploadRecord) return apiError("Failed to create upload record");
    const id = uploadRecord.id as string;
    uploadId = id;

    // ── 4. Fetch lookup tables ────────────────────────────────────────────
    const [{ data: glMappings, error: glErr }, { data: branches, error: brErr }] =
      await Promise.all([
        supabase.from("gl_mapping").select("*"),
        supabase.from("branches").select("*"),
      ]);
    if (glErr) throw new Error(glErr.message);
    if (brErr) throw new Error(brErr.message);

    // ── 5. Enrich rows inline (GL + branch enrichment + OA-specific fields)
    const glMap = new Map<string, GLMapping>(
      (glMappings ?? []).map((r: GLMapping) => [r.gl_code, r])
    );
    const branchMap = new Map<string, Branch>(
      (branches ?? []).map((r: Branch) => [r.branch, r])
    );

    let uncategorizedCount = 0;
    let unknownBranchCount = 0;

    const toInsert = rows.map((row) => {
      const gl = glMap.get(row.gl_code);
      const br = branchMap.get(row.branch);
      if (!gl) uncategorizedCount++;
      if (!br) unknownBranchCount++;

      return {
        upload_id:           id,
        gl_number_raw:       row.gl_number_raw,
        gl_code:             row.gl_code,
        branch:              row.branch,
        gl_name:             row.gl_name,
        check_description:   row.check_description,
        check_description_2: row.check_description_2,
        check_description_3: row.check_description_3,
        year:                row.year,
        month:               row.month,
        vendor:              row.vendor,
        category:            row.category,
        position:            row.position,
        branch_allocation:   row.branch_allocation,
        debit:               row.debit,
        credit:              row.credit,
        movement:            row.movement,
        loan_number:         null,
        borrower_name:       null,
        journal_post_date:   null,
        invoice_numb:        "",
        ref_numb:            "",
        doc_type:            "",
        // GL mapping enrichment
        category_1:    gl?.category_1 ?? null,
        category_2:    gl?.category_2 ?? null,
        category_3:    gl?.category_3 ?? null,
        category_4:    gl?.category_4 ?? null,
        category_5:    gl?.category_5 ?? null,
        category_6:    gl?.category_6 ?? null,
        category_7:    gl?.category_7 ?? null,
        order_1:       gl?.order_1 ?? null,
        order_2:       gl?.order_2 ?? null,
        order_3:       gl?.order_3 ?? null,
        // Branch enrichment
        region:         br?.region ?? null,
        branch_manager: br?.branch_manager ?? null,
        manual_override: false,
        source: "offshore_allocations" as const,
      };
    });

    // ── 6. Batch-insert ───────────────────────────────────────────────────
    for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + INSERT_CHUNK_SIZE);
      const { error: chunkErr } = await supabase.from("pl_transactions").insert(chunk);
      if (chunkErr) throw new Error(`Insert error (chunk ${i}): ${chunkErr.message}`);
    }

    // ── 7. Apply cost center rules ────────────────────────────────────────
    const [splitRules, loMap] = await Promise.all([
      loadAllSplitRules(supabase),
      loadLoanOfficialFields(supabase),
    ]);

    const { data: newTxs } = await supabase
      .from("pl_transactions")
      .select(
        "id,gl_code,gl_name,branch,vendor,check_description," +
        "ref_numb,category_5,category_6,doc_type,month,year,debit,credit,movement," +
        "loan_number,loan_number_incomplete"
      )
      .eq("upload_id", id);

    if (newTxs && newTxs.length > 0) {
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
            supabase
              .from("pl_transactions")
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
    const manualSummary = replaceId
      ? await reapplyManualSnapshot(supabase, id, manualSnapshot)
      : null;

    // ── 7c. Auto-generate employee fee lines for all not_recoverable employees
    // Uses idempotency: only creates lines for (employee, month, year) combos
    // that don't already have employee_fee lines.
    const feeSummary = await generateEmployeeFeeLines(supabase);

    // ── 7d. Apply OA split rules to all unassigned OA transactions (Button 1 auto)
    await applyOASplits(supabase);

    // ── 7e. Sync employee cost splits for unassigned GL 90002 lines (Button 2 auto)
    await resyncEmployeeSplits(supabase);

    // ── 8. Mark completed ─────────────────────────────────────────────────
    await supabase
      .from("pl_uploads")
      .update({ status: "completed", row_count: rows.length })
      .eq("id", id);

    const response: OffshoreAllocationsUploadResponse = {
      uploadId: id,
      rowCount: rows.length,
      uncategorizedCount,
      unknownBranchCount,
      parseWarnings: warnings.length,
    };
    if (manualSummary) response.manualAssignments = manualSummary;
    if (feeSummary.transactions_inserted > 0) {
      response.employeeFeeLines = {
        employees:    feeSummary.employees_processed,
        months:       feeSummary.new_months,
        transactions: feeSummary.transactions_inserted,
      };
    }
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[upload-offshore-allocations]", message);
    if (uploadId) {
      await createServerClient()
        .from("pl_uploads")
        .update({ status: "error", error_message: message })
        .eq("id", uploadId);
    }
    return apiError(message);
  }
}
