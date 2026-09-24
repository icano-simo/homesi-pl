import { NextRequest, NextResponse } from "next/server";
import { parseAddbacks } from "@/lib/parse-addbacks";
import { enrichTransactions } from "@/lib/enrich-transactions";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanClassifications, enrichTxWithLoanClassifications, fetchUploadTxsForRules } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import { createServerClient } from "@/lib/supabase-server";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import { checkDuplicateUpload, deleteUpload, findSameFile, resumirCobertura } from "@/lib/check-duplicate-upload";
import { createHash } from "node:crypto";
import { relinkOrphanNotes } from "@/lib/relink-orphan-notes";
import { snapshotManualAssignments, reapplyManualSnapshot } from "@/lib/snapshot-manual-assignments";
import type { AddbacksUploadResponse, ApiError, PLTransaction, SplitRuleWithDetails } from "@/types";
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

    // ── 2. Parse addbacks Excel (pure function, no DB) ────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    /* Sobre los BYTES recibidos: la pregunta es "¿es este archivo?". */
    const fileHash = createHash("sha256").update(buffer).digest("hex");
    const { rows, warnings } = parseAddbacks(buffer);

    if (rows.length === 0) {
      return apiError(
        "No valid rows found. Verify the file has columns: GL Code, Branch, Debit, Credit, Month, Year.",
        422
      );
    }

    // ── 3. Duplicate check ────────────────────────────────────────────────
    if (!force && !replaceId) {
      /*
       * ⚠ EL ARCHIVO ENTERO PRIMERO. Ver la nota de app/api/upload-pl/route.ts:
       * "este periodo ya tiene datos" es cierto casi siempre y se aprende a
       * despachar; "este archivo ya esta" es un hecho.
       *
       * La comprobacion es la misma funcion en las tres rutas a proposito:
       * tres copias de la misma pregunta es como una se queda sin arreglar.
       */
      const sameFile = await findSameFile(supabase, file.name, fileHash);
      if (sameFile.length > 0) {
        return NextResponse.json({ same_file: true, matches: sameFile }, { status: 409 });
      }

      const dupeResult = await checkDuplicateUpload(supabase, "addback", rows);
      if (dupeResult.found) {
        // Todos los candidatos, no el que mas solapa: elegir por la app dejaba
        // los demas fuera sin decirlo. Ver check-duplicate-upload.
        return NextResponse.json({ duplicate: true, candidates: dupeResult.candidates }, { status: 409 });
      }
    }
    // ── 3b. Persist the manual assignments BEFORE anything is deleted ─────
    // The await is the invariant: snapshotManualAssignments writes the backup
    // rows and reads them back, throwing if the count does not match, so
    // control only reaches the delete once the backup is confirmed on disk.
    if (replaceId) await snapshotManualAssignments(supabase, replaceId);

    if (replaceId) await deleteUpload(supabase, replaceId);

    // ── 4. Create upload record ───────────────────────────────────────────
    const { data: uploadRecord, error: insertErr } = await supabase
      .from("pl_uploads")
      .insert({ file_name: file.name, file_hash: fileHash, status: "processing" })
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

    // ── 5. Enrich rows (same logic as P&L, source = 'addback') ───────────
    const { transactions, uncategorizedCount, unknownBranchCount } = enrichTransactions(
      rows,
      glMappings ?? [],
      branches ?? [],
      id,
      "addback"
    );

    // ── 6. Batch-insert ───────────────────────────────────────────────────
    for (let i = 0; i < transactions.length; i += INSERT_CHUNK_SIZE) {
      const chunk = transactions.slice(i, i + INSERT_CHUNK_SIZE);
      const { error: chunkErr } = await supabase.from("pl_transactions").insert(chunk);
      if (chunkErr) throw new Error(`Insert error (chunk ${i}): ${chunkErr.message}`);
    }

    // ── 7. Apply cost center rules ────────────────────────────────────────
    const [splitRules, loMap] = await Promise.all([
      loadAllSplitRules(supabase),
      loadLoanClassifications(supabase),
    ]);

    // Paged: an unbounded select stops at 1000 rows, which would leave every
    // row past the first thousand of a large file without rule evaluation.
    const newTxs = await fetchUploadTxsForRules(supabase, id);

    if (newTxs.length > 0) {
      const ruleSplitEntries: RuleSplitEntry[] = [];
      const ccUpdates = newTxs.map((tx) => {
        const txId = (tx as unknown as { id: string }).id;
        const enriched = enrichTxWithLoanClassifications(tx as unknown as Record<string, unknown>, loMap);
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
    // Reads the pending backup rows from the table rather than an in-memory
    // array, so a run that died earlier can be resumed by uploading again.
    const manualSummary = replaceId
      ? await reapplyManualSnapshot(supabase, id, replaceId)
      : null;

    // ── 7c. Reattach notes orphaned by a replaced upload ──────────────────
    const relinkSummary = await relinkOrphanNotes(supabase, id);

    // ── 8. Mark completed ─────────────────────────────────────────────────
    await supabase
      .from("pl_uploads")
      /* `coverage` sobre las filas SUBIDAS: es lo que trajo el archivo, no lo
         que quede despues. Ver resumirCobertura. */
      .update({ status: "completed", row_count: rows.length, coverage: resumirCobertura(rows) })
      .eq("id", id);

    const response: AddbacksUploadResponse = {
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
    console.error("[upload-addbacks]", message);
    if (uploadId) {
      await createServerClient()
        .from("pl_uploads")
        .update({ status: "error", error_message: message })
        .eq("id", uploadId);
    }
    return apiError(message);
  }
}
