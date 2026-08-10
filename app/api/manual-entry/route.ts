import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanOfficialFields, enrichTxWithLoanOfficials } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";
import { requireSession } from "@/lib/auth";

interface ManualEntryRow {
  gl_code: string;
  branch: string;
  check_description: string;
  vendor: string;
  debit: number;
  credit: number;
  month: string;
  year: number;
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  let uploadId: string | null = null;

  try {
    const { rows }: { rows: ManualEntryRow[] } = await req.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    // 1. Create upload record
    const { data: uploadRecord, error: uploadErr } = await supabase
      .from("pl_uploads")
      .insert({ file_name: "Manual Entry", status: "processing" })
      .select("id")
      .single();
    if (uploadErr || !uploadRecord) {
      return NextResponse.json({ error: "Failed to create upload record" }, { status: 500 });
    }
    const id = uploadRecord.id as string;
    uploadId = id;

    // 2. Fetch lookup tables
    const [{ data: glMappings, error: glErr }, { data: branches, error: brErr }] = await Promise.all([
      supabase.from("gl_mapping").select("*"),
      supabase.from("branches").select("*"),
    ]);
    if (glErr) throw new Error(glErr.message);
    if (brErr) throw new Error(brErr.message);

    const glMap = new Map((glMappings ?? []).map((g) => [g.gl_code as string, g]));
    const branchMap = new Map((branches ?? []).map((b) => [b.branch as string, b]));

    // 3. Build enriched transactions
    const transactions = rows.map((row) => {
      const glEntry = glMap.get(row.gl_code);
      const branchEntry = branchMap.get(row.branch);
      const movement = (row.credit ?? 0) - (row.debit ?? 0);

      return {
        upload_id: id,
        gl_number_raw: row.gl_code,
        gl_code: row.gl_code || null,
        gl_name: (glEntry as { gl_name?: string } | undefined)?.gl_name ?? null,
        branch: row.branch || null,
        check_description: row.check_description ?? "",
        vendor: row.vendor ?? "",
        debit: row.debit ?? 0,
        credit: row.credit ?? 0,
        movement,
        month: row.month || null,
        year: row.year || null,
        source: "manual_entry",
        manual_override: false,
        // GL mapping enrichment
        category_1: (glEntry as Record<string, unknown> | undefined)?.category_1 ?? null,
        category_2: (glEntry as Record<string, unknown> | undefined)?.category_2 ?? null,
        category_3: (glEntry as Record<string, unknown> | undefined)?.category_3 ?? null,
        category_4: (glEntry as Record<string, unknown> | undefined)?.category_4 ?? null,
        category_5: (glEntry as Record<string, unknown> | undefined)?.category_5 ?? null,
        category_6: (glEntry as Record<string, unknown> | undefined)?.category_6 ?? null,
        category_7: (glEntry as Record<string, unknown> | undefined)?.category_7 ?? null,
        order_1: (glEntry as Record<string, unknown> | undefined)?.order_1 ?? null,
        order_2: (glEntry as Record<string, unknown> | undefined)?.order_2 ?? null,
        order_3: (glEntry as Record<string, unknown> | undefined)?.order_3 ?? null,
        // Branch enrichment
        region: (branchEntry as Record<string, unknown> | undefined)?.region ?? null,
        branch_manager: (branchEntry as Record<string, unknown> | undefined)?.branch_manager ?? null,
      };
    });

    // 4. Batch insert
    for (let i = 0; i < transactions.length; i += INSERT_CHUNK_SIZE) {
      const chunk = transactions.slice(i, i + INSERT_CHUNK_SIZE);
      const { error: chunkErr } = await supabase.from("pl_transactions").insert(chunk);
      if (chunkErr) throw new Error(`Insert error: ${chunkErr.message}`);
    }

    // 5. Apply cost center rules
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

    // 6. Mark completed
    await supabase
      .from("pl_uploads")
      .update({ status: "completed", row_count: rows.length })
      .eq("id", id);

    return NextResponse.json({ uploadId: id, rowCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[manual-entry POST]", message);
    if (uploadId) {
      await createServerClient()
        .from("pl_uploads")
        .update({ status: "error", error_message: message })
        .eq("id", uploadId);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
