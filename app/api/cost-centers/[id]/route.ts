import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  getRuleAssignedTxIds,
  loadAllSplitRules,
  reevaluateRuleAssigned,
} from "@/lib/reevaluate-rule-assigned";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();
  const { data: cc, error } = await supabase.from("cost_centers").select("*").eq("id", id).single();
  if (error || !cc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(cc);
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const { name, description } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("cost_centers")
    .update({ name: name.trim(), description: description?.trim() || null })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();

  // ── Pre-flight: classify ALL transactions pointing to this CC ─────────────

  const [
    { count: manualCount },
    { count: snapCount },
    { count: nullOriginCount },
  ] = await Promise.all([
    supabase
      .from("pl_transactions")
      .select("id", { count: "exact", head: true })
      .eq("cost_center_id", id)
      .eq("assignment_origin", "manual"),
    supabase
      .from("conflict_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("resolved_cc_id", id),
    supabase
      .from("pl_transactions")
      .select("id", { count: "exact", head: true })
      .eq("cost_center_id", id)
      .is("assignment_origin", null),
  ]);

  const blockers: string[] = [];
  if ((manualCount ?? 0) > 0)
    blockers.push(
      `${manualCount} manually assigned transaction${manualCount !== 1 ? "s" : ""} — reassign them first`
    );
  if ((snapCount ?? 0) > 0)
    blockers.push(
      `${snapCount} resolved conflict${snapCount !== 1 ? "s" : ""} referencing it — reopen them first`
    );

  if (blockers.length > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete: ${blockers.join("; ")}.`,
        manual_count: manualCount ?? 0,
        snap_count: snapCount ?? 0,
        null_origin_count: nullOriginCount ?? 0,
      },
      { status: 409 }
    );
  }

  // ── Collect all IDs that need re-evaluation BEFORE deletion ───────────────

  // Set A: rule/null-origin direct assignments (cost_center_id = this CC)
  const ruleAssignedIds = await getRuleAssignedTxIds(supabase, id);

  // Set B: unresolved conflict transactions referencing this CC in their
  //        conflict array (cost_center_id = null for these)
  const conflictTxIds: string[] = [];
  {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("conflict_snapshots")
        .select("transaction_id")
        .eq("is_resolved", false)
        .contains("conflicting_cc_ids", [id])
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      conflictTxIds.push(...(data as { transaction_id: string }[]).map((r) => r.transaction_id));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // ── Delete rules then CC ──────────────────────────────────────────────────

  await supabase.from("cost_center_rules").delete().eq("cost_center_id", id);

  const { error } = await supabase.from("cost_centers").delete().eq("id", id);

  if (error) {
    const isForeignKey =
      (error as { code?: string }).code === "23503" ||
      error.message.toLowerCase().includes("foreign key") ||
      error.message.toLowerCase().includes("fkey");

    if (isForeignKey) {
      return NextResponse.json(
        {
          error:
            "Cannot delete: some transactions still reference this Cost Center " +
            "despite the pre-flight check. Use 'Unassign all' on the detail page " +
            "to clear them first, then retry the delete.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // ── Load rules post-deletion (excludes any that referenced the deleted CC) ─

  const splitRules = await loadAllSplitRules(supabase);

  // ── Re-evaluate Set A (rule/null-origin direct) ───────────────────────────
  const directStats = await reevaluateRuleAssigned(supabase, ruleAssignedIds, splitRules);

  // ── Re-evaluate Set B (conflict transactions) ─────────────────────────────
  const conflictStats = await reevaluateRuleAssigned(supabase, conflictTxIds, splitRules);

  return NextResponse.json({
    deleted: true,
    null_origin_count: nullOriginCount ?? 0,
    // Set A stats
    reevaluated: directStats.reevaluated,
    reassigned: directStats.reassigned,
    unassigned: directStats.unassigned,
    conflicts: directStats.conflicts,
    // Set B stats
    conflict_reevaluated: conflictStats.reevaluated,
    conflict_reassigned: conflictStats.reassigned,
    conflict_unassigned: conflictStats.unassigned,
    conflict_still_conflicting: conflictStats.conflicts,
  });
}
