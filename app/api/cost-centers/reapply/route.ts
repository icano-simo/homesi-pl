import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanOfficialFields, enrichTxWithLoanOfficials } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";

type TxRow = {
  id: string;
  gl_code: string | null;
  gl_name: string | null;
  branch: string | null;
  vendor: string | null;
  check_description: string | null;
  ref_numb: string | null;
  category_5: string | null;
  category_6: string | null;
  doc_type: string | null;
  month: string | null;
  year: number | null;
  debit: number;
  credit: number;
  movement: number | null;
  assignment_origin: string | null;
  loan_number: string | null;
  loan_number_incomplete: boolean | null;
};

const FETCH_BATCH = 1000;
const UPDATE_PARALLEL = 100;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let branches: string[] = Array.isArray(body?.branches) ? body.branches : [];

  const supabase = createServerClient();

  // If no branches supplied, fall back to the global active_branches setting
  if (branches.length === 0) {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("active_branches")
      .limit(1)
      .single();
    branches = Array.isArray(settings?.active_branches) ? settings.active_branches : [];
  }

  // ── 1. Load cost centers, rules, resolved snapshots ───────────────────────

  const [
    { data: resolvedSnapshots, error: snapErr },
    splitRules,
    loMap,
  ] = await Promise.all([
    supabase.from("conflict_snapshots").select("*").eq("is_resolved", true),
    loadAllSplitRules(supabase),
    loadLoanOfficialFields(supabase),
  ]);

  if (snapErr) console.warn("[reapply] Could not load snapshots:", snapErr.message);

  const resolvedByTx = new Map<string, { conflicting_cc_ids: string[]; resolved_at: string | null }>(
    (resolvedSnapshots ?? []).map((s) => [s.transaction_id, s])
  );

  // ── 2. Paginate and evaluate ──────────────────────────────────────────────

  let offset = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalAssigned = 0;
  let totalConflicts = 0;
  let totalUpdateErrors = 0;
  const firstUpdateError: string[] = [];
  const snapshotUpserts: { transaction_id: string; conflicting_cc_ids: string[] }[] = [];
  const snapshotDeletes: string[] = [];

  // Index rules by ID so we can compare updated_at against resolved_at
  const splitRulesById = new Map(splitRules.map((r) => [r.id, r]));

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select(
        "id,gl_code,gl_name,branch,vendor,check_description," +
        "ref_numb,category_5,category_6,doc_type,month,year,debit,credit,movement,assignment_origin," +
        "loan_number,loan_number_incomplete"
      )
      .order("id", { ascending: true })
      .range(offset, offset + FETCH_BATCH - 1);
    if (branches.length > 0) q = q.in("branch", branches);
    const { data, error: fetchErr } = await q;

    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!data || data.length === 0) break;

    const rows = data as unknown as TxRow[];

    const toUpdate: {
      id: string;
      cost_center_id: string | null;
      cost_center_status: string;
      cost_center_conflicts: string[] | null;
      assignment_origin: string | null;
      conflict_type: string | null;
      operational_pct: number;
    }[] = [];
    const evaluatedIds: string[] = [];
    const ruleSplitEntries: RuleSplitEntry[] = [];

    for (const tx of rows) {
      // Manual assignments are permanent — never re-evaluate
      if (tx.assignment_origin === "manual") {
        totalSkipped++;
        continue;
      }

      const resolved = resolvedByTx.get(tx.id);

      const enriched = enrichTxWithLoanOfficials(tx as unknown as Record<string, unknown>, loMap);
      const r = evaluateCostCenterRules(enriched as unknown as PLTransaction, splitRules as SplitRuleWithDetails[]);

      // Protect resolved conflicts: only re-open if at least one of the currently-
      // conflicting rules was modified AFTER the conflict was resolved. If no rule
      // changed since resolution, the manual resolution decision stands.
      if (r.cost_center_status === "conflict" && resolved?.resolved_at) {
        const resolvedAt = new Date(resolved.resolved_at);
        const anyRuleChangedAfter = r.cost_center_conflicts.some((ruleId) => {
          const rule = splitRulesById.get(ruleId);
          // If the rule no longer exists it was deleted → treat as changed (re-open)
          return !rule || new Date(rule.updated_at) > resolvedAt;
        });
        if (!anyRuleChangedAfter) {
          totalSkipped++;
          continue; // Keep the manual resolution intact — skip all updates for this tx
        }
      }

      const origin =
        r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";
      evaluatedIds.push(tx.id);
      if (r.rule_splits) ruleSplitEntries.push({ transaction_id: tx.id, splits: r.rule_splits });
      toUpdate.push({
        id: tx.id,
        cost_center_id: r.cost_center_id,
        cost_center_status: r.cost_center_status,
        cost_center_conflicts: r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null,
        assignment_origin: origin,
        conflict_type: r.conflict_type ?? null,
        operational_pct: r.operational_pct,
      });

      if (r.cost_center_status === "conflict") {
        snapshotUpserts.push({ transaction_id: tx.id, conflicting_cc_ids: r.cost_center_conflicts });
      } else if (resolved) {
        snapshotDeletes.push(tx.id);
      }
    }

    totalAssigned += toUpdate.filter((u) => u.cost_center_status === "assigned").length;
    totalConflicts += toUpdate.filter((u) => u.cost_center_status === "conflict").length;

    for (let i = 0; i < toUpdate.length; i += UPDATE_PARALLEL) {
      const results = await Promise.all(
        toUpdate.slice(i, i + UPDATE_PARALLEL).map((u) =>
          supabase
            .from("pl_transactions")
            .update({
              cost_center_id: u.cost_center_id,
              cost_center_status: u.cost_center_status,
              cost_center_conflicts: u.cost_center_conflicts,
              assignment_origin: u.assignment_origin,
              conflict_type: u.conflict_type,
              operational_pct: u.operational_pct,
            })
            .eq("id", u.id)
        )
      );
      for (const res of results) {
        if (res.error) {
          totalUpdateErrors++;
          if (firstUpdateError.length < 3) firstUpdateError.push(res.error.message);
        }
      }
    }

    await syncRuleSplitAllocations(supabase, evaluatedIds, ruleSplitEntries);

    totalProcessed += rows.length;
    if (rows.length < FETCH_BATCH) break;
    offset += FETCH_BATCH;
  }

  // ── 3. Sync conflict snapshots ─────────────────────────────────────────────

  if (snapshotUpserts.length > 0) {
    for (let i = 0; i < snapshotUpserts.length; i += 200) {
      await supabase.from("conflict_snapshots").upsert(
        snapshotUpserts.slice(i, i + 200).map((s) => ({
          transaction_id: s.transaction_id,
          conflicting_cc_ids: s.conflicting_cc_ids,
          is_resolved: false,
          resolved_cc_id: null,
          resolved_at: null,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "transaction_id" }
      );
    }
  }

  if (snapshotDeletes.length > 0) {
    for (let i = 0; i < snapshotDeletes.length; i += 200) {
      await supabase.from("conflict_snapshots").delete().in("transaction_id", snapshotDeletes.slice(i, i + 200));
    }
  }

  if (totalUpdateErrors > 0) {
    return NextResponse.json(
      {
        error: `${totalUpdateErrors} row update(s) failed — first error: "${firstUpdateError[0]}".`,
        processed: totalProcessed, skipped: totalSkipped,
        assigned: totalAssigned, conflicts: totalConflicts,
        unassigned: totalProcessed - totalSkipped - totalAssigned - totalConflicts,
        updateErrors: totalUpdateErrors,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    processed: totalProcessed,
    skipped: totalSkipped,
    assigned: totalAssigned,
    unassigned: totalProcessed - totalSkipped - totalAssigned - totalConflicts,
    conflicts: totalConflicts,
  });
}
