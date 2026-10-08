import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanClassifications, enrichTxWithLoanClassifications } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations } from "@/lib/sync-rule-split-allocations";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";
import { requireSession } from "@/lib/auth";
import { deleteUpload } from "@/lib/check-duplicate-upload";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const { id } = await params;

  try {
    const body = await req.json() as {
      gl_code: string;
      branch: string;
      check_description: string;
      vendor: string;
      debit: number;
      credit: number;
      month: string;
      year: number;
    };

    // Fetch lookup tables
    const [{ data: glMappings }, { data: branches }] = await Promise.all([
      supabase.from("gl_mapping").select("*"),
      supabase.from("branches").select("*"),
    ]);

    const glMap = new Map((glMappings ?? []).map((g) => [g.gl_code as string, g as Record<string, unknown>]));
    const branchMap = new Map((branches ?? []).map((b) => [b.branch as string, b as Record<string, unknown>]));

    const glEntry = body.gl_code ? glMap.get(body.gl_code) : undefined;
    const branchEntry = body.branch ? branchMap.get(body.branch) : undefined;
    const movement = (body.credit ?? 0) - (body.debit ?? 0);

    const updateFields: Record<string, unknown> = {
      gl_code: body.gl_code || null,
      gl_name: (glEntry?.gl_name as string) ?? null,
      branch: body.branch || null,
      check_description: body.check_description ?? "",
      vendor: body.vendor ?? "",
      debit: body.debit ?? 0,
      credit: body.credit ?? 0,
      movement,
      month: body.month || null,
      year: body.year || null,
      // GL enrichment
      category_1: glEntry?.category_1 ?? null,
      category_2: glEntry?.category_2 ?? null,
      category_3: glEntry?.category_3 ?? null,
      category_4: glEntry?.category_4 ?? null,
      category_5: glEntry?.category_5 ?? null,
      category_6: glEntry?.category_6 ?? null,
      category_7: glEntry?.category_7 ?? null,
      order_1: glEntry?.order_1 ?? null,
      order_2: glEntry?.order_2 ?? null,
      order_3: glEntry?.order_3 ?? null,
      // Branch enrichment
      region: branchEntry?.region ?? null,
      branch_manager: branchEntry?.branch_manager ?? null,
    };

    // Re-run CC rules on the updated row
    const [splitRules, loMap] = await Promise.all([
      loadAllSplitRules(supabase),
      loadLoanClassifications(supabase),
    ]);

    const enriched = enrichTxWithLoanClassifications(updateFields, loMap);
    const r = evaluateCostCenterRules(enriched as unknown as PLTransaction, splitRules as SplitRuleWithDetails[]);
    const origin = r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";

    updateFields.cost_center_id = r.cost_center_id;
    updateFields.cost_center_status = r.cost_center_status;
    updateFields.cost_center_conflicts = r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null;
    updateFields.assignment_origin = origin;
    updateFields.conflict_type = r.conflict_type ?? null;

    const { error } = await supabase
      .from("pl_transactions")
      .update(updateFields)
      .eq("id", id)
      .eq("source", "manual_entry");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await syncRuleSplitAllocations(
      supabase,
      [id],
      r.rule_splits ? [{ transaction_id: id, splits: r.rule_splits }] : []
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Deletes one manual entry for real: the pl_transactions row, its
 * cc_allocation_splits (plain-text assign_value, no FK, so no cascade) and,
 * when it was the only row of its upload, the pl_uploads record too — otherwise
 * the uploads list fills with empty "Manual Entry" records.
 *
 * Every save from the Manual Entry form creates its own upload, but a save with
 * several rows puts them all under one upload_id. In that case only this row
 * goes and the upload stays with its row_count lowered.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const { id } = await params;

  try {
    const { data: tx, error: txErr } = await supabase
      .from("pl_transactions")
      .select("id,upload_id,source")
      .eq("id", id)
      .eq("source", "manual_entry")
      .maybeSingle();
    if (txErr) throw new Error(txErr.message);
    if (!tx) return NextResponse.json({ error: "Manual entry not found" }, { status: 404 });

    const uploadId = tx.upload_id as string | null;

    // Who else lives in this upload. Redundant guard on purpose: deleteUpload
    // takes everything under the upload_id, so it only runs once it is proven
    // the upload holds nothing but manual entries.
    const siblings = uploadId
      ? await supabase.from("pl_transactions").select("id,source").eq("upload_id", uploadId).order("id").limit(1000)
      : { data: [], error: null };
    if (siblings.error) throw new Error(siblings.error.message);
    const siblingRows = (siblings.data ?? []) as { id: string; source: string }[];
    if (siblingRows.some((r) => r.source !== "manual_entry")) {
      throw new Error(`Upload ${uploadId} mixes manual entries with other sources — refusing to delete it`);
    }

    if (uploadId && siblingRows.length === 1 && siblingRows[0].id === id) {
      await deleteUpload(supabase, uploadId);
    } else {
      const { error: splitErr } = await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .eq("assign_value", id);
      if (splitErr) throw new Error(`cc_allocation_splits: ${splitErr.message}`);

      const { error: delErr } = await supabase
        .from("pl_transactions")
        .delete()
        .eq("id", id)
        .eq("source", "manual_entry");
      if (delErr) throw new Error(`pl_transactions: ${delErr.message}`);

      if (uploadId) {
        const { error: upErr } = await supabase
          .from("pl_uploads")
          .update({ row_count: siblingRows.length - 1 })
          .eq("id", uploadId);
        if (upErr) throw new Error(`pl_uploads: ${upErr.message}`);
      }
    }

    // A delete that returns no error is not proof it happened — read it back.
    const { data: still, error: checkErr } = await supabase
      .from("pl_transactions").select("id").eq("id", id).maybeSingle();
    if (checkErr) throw new Error(checkErr.message);
    if (still) throw new Error("The row is still there after the delete");
    if (uploadId && siblingRows.length === 1) {
      const { data: upload, error: upCheckErr } = await supabase
        .from("pl_uploads").select("id").eq("id", uploadId).maybeSingle();
      if (upCheckErr) throw new Error(upCheckErr.message);
      if (upload) throw new Error(`Row deleted but its upload ${uploadId} is still there`);
    }

    return NextResponse.json({ ok: true, upload_deleted: siblingRows.length === 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[manual-entry DELETE]", message);
    return NextResponse.json({ error: `Could not delete the manual entry: ${message}` }, { status: 500 });
  }
}
