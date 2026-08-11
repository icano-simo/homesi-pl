import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { loadAllSplitRules, reevaluateRuleAssigned } from "@/lib/reevaluate-rule-assigned";
import { requireSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Returns the count of all transactions that "Unassign all" will touch:
 *   direct_count  — transactions with cost_center_id = this CC
 *   conflict_count — unresolved conflict_snapshots where this CC appears
 *                    in conflicting_cc_ids (cost_center_id is null for these)
 *
 * Resolved conflicts (resolved_cc_id = this CC) are NOT included — those
 * block the delete and must be reopened manually, consistent with DELETE policy.
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();

  const [{ count: directCount }, { count: conflictCount }] = await Promise.all([
    supabase
      .from("pl_transactions")
      .select("id", { count: "exact", head: true })
      .eq("cost_center_id", id),
    supabase
      .from("conflict_snapshots")
      .select("transaction_id", { count: "exact", head: true })
      .eq("is_resolved", false)
      .contains("conflicting_cc_ids", [id]),
  ]);

  return NextResponse.json({
    count: (directCount ?? 0) + (conflictCount ?? 0),
    direct_count: directCount ?? 0,
    conflict_count: conflictCount ?? 0,
  });
}

/**
 * Two-part cleanup:
 *
 * Part A — Direct assignments (cost_center_id = this CC):
 *   Hard-reset to never-evaluated state: cost_center_id/assignment_origin/
 *   cost_center_status/cost_center_conflicts all → null/"unassigned"/null.
 *   Deletes their conflict_snapshots (shouldn't exist for assigned txs, but
 *   cleans up any stale ones).
 *
 * Part B — Unresolved conflicts involving this CC (cost_center_id is null):
 *   Re-evaluates each transaction against the current ruleset *excluding*
 *   this cost center. If the conflict was a 2-way tie and the other CC's
 *   rules still match, the tx gets cleanly assigned. If 3+ CCs were
 *   involved, the tx may still conflict among the remaining ones.
 *   reevaluateRuleAssigned handles updating pl_transactions and
 *   conflict_snapshots (upsert/delete as needed).
 *
 * Resolved conflicts (resolved_cc_id = this CC) are NOT touched here —
 * they must be reopened manually.
 */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await params;
  const supabase = createServerClient();

  // ── Part A: collect direct-assignment tx IDs ──────────────────────────────
  const directTxIds: string[] = [];
  {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("pl_transactions")
        .select("id")
        .eq("cost_center_id", id)
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      directTxIds.push(...(data as { id: string }[]).map((r) => r.id));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // ── Part B: collect conflict tx IDs ──────────────────────────────────────
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

  // ── Execute Part A reset ──────────────────────────────────────────────────
  if (directTxIds.length > 0) {
    const { error } = await supabase
      .from("pl_transactions")
      .update({
        cost_center_id: null,
        assignment_origin: null,
        cost_center_status: "unassigned",
        cost_center_conflicts: null,
      })
      .eq("cost_center_id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    for (let i = 0; i < directTxIds.length; i += 500) {
      await supabase
        .from("conflict_snapshots")
        .delete()
        .in("transaction_id", directTxIds.slice(i, i + 500));
    }
  }

  // ── Execute Part B re-evaluation ─────────────────────────────────────────
  let reevalStats = { reevaluated: 0, reassigned: 0, unassigned: 0, conflicts: 0 };
  if (conflictTxIds.length > 0) {
    const splitRules = await loadAllSplitRules(supabase);
    reevalStats = await reevaluateRuleAssigned(supabase, conflictTxIds, splitRules);
  }

  return NextResponse.json({
    unassigned: directTxIds.length,
    conflict_reevaluated: reevalStats.reevaluated,
    conflict_reassigned: reevalStats.reassigned,
    conflict_unassigned: reevalStats.unassigned,
    conflict_still_conflicting: reevalStats.conflicts,
  });
}
