import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import {
  loadAllSplitRules,
  loadLoanOfficialFields,
  enrichTxWithLoanOfficials,
} from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";

export const dynamic = "force-dynamic";

const TX_FIELDS =
  "id,gl_code,gl_name,branch,vendor,check_description," +
  "ref_numb,category_5,category_6,doc_type,month,year,debit,credit,movement," +
  "loan_number,loan_number_incomplete";

const UPDATE_PARALLEL = 100;

// GET — count of OA transactions that are manually assigned (and thus skipped by global reapply)
export async function GET() {
  const supabase = createServerClient();
  const { count, error } = await supabase
    .from("pl_transactions")
    .select("id", { count: "exact", head: true })
    .eq("source", "offshore_allocations")
    .eq("assignment_origin", "manual");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ count: count ?? 0 });
}

// POST — re-evaluate those transactions against current rules, bypassing the manual-skip guard
export async function POST() {
  const supabase = createServerClient();

  // Load rules and loan officials in parallel
  const [splitRules, loMap] = await Promise.all([
    loadAllSplitRules(supabase),
    loadLoanOfficialFields(supabase),
  ]);

  // Fetch all OA transactions with assignment_origin = 'manual' (the ones normally skipped)
  type TxRow = { id: string } & Record<string, unknown>;
  const all: TxRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(TX_FIELDS)
      .eq("source", "offshore_allocations")
      .eq("assignment_origin", "manual")
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as TxRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  if (all.length === 0) {
    return NextResponse.json({ processed: 0, assigned: 0, conflicts: 0, unassigned: 0 });
  }

  const txs = all.map((tx) => enrichTxWithLoanOfficials(tx, loMap) as TxRow);

  // Evaluate each transaction — manual protection intentionally bypassed for this specific flow
  const toUpdate: {
    id: string;
    cost_center_id: string | null;
    cost_center_status: string;
    cost_center_conflicts: string[] | null;
    assignment_origin: string | null;
    conflict_type: string | null;
    operational_pct: number;
  }[] = [];
  const ruleSplitEntries: RuleSplitEntry[] = [];
  const snapshotUpserts: { transaction_id: string; conflicting_cc_ids: string[] }[] = [];
  const snapshotDeletes: string[] = [];

  for (const tx of txs) {
    const r = evaluateCostCenterRules(tx as unknown as PLTransaction, splitRules as SplitRuleWithDetails[]);
    const origin = r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";

    if (r.rule_splits) ruleSplitEntries.push({ transaction_id: tx.id, splits: r.rule_splits });
    toUpdate.push({
      id: tx.id,
      cost_center_id:       r.cost_center_id,
      cost_center_status:   r.cost_center_status,
      cost_center_conflicts: r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null,
      assignment_origin:    origin,
      conflict_type:        r.conflict_type ?? null,
      operational_pct:      r.operational_pct,
    });

    if (r.cost_center_status === "conflict") {
      snapshotUpserts.push({ transaction_id: tx.id, conflicting_cc_ids: r.cost_center_conflicts });
    } else {
      snapshotDeletes.push(tx.id);
    }
  }

  // Apply updates in parallel batches
  for (let i = 0; i < toUpdate.length; i += UPDATE_PARALLEL) {
    await Promise.all(
      toUpdate.slice(i, i + UPDATE_PARALLEL).map((u) =>
        supabase
          .from("pl_transactions")
          .update({
            cost_center_id:       u.cost_center_id,
            cost_center_status:   u.cost_center_status,
            cost_center_conflicts: u.cost_center_conflicts,
            assignment_origin:    u.assignment_origin,
            conflict_type:        u.conflict_type,
            operational_pct:      u.operational_pct,
          })
          .eq("id", u.id)
      )
    );
  }

  await syncRuleSplitAllocations(supabase, txs.map((t) => t.id), ruleSplitEntries);

  // Sync conflict snapshots
  const now = new Date().toISOString();

  if (snapshotUpserts.length > 0) {
    for (let i = 0; i < snapshotUpserts.length; i += 200) {
      await supabase.from("conflict_snapshots").upsert(
        snapshotUpserts.slice(i, i + 200).map((s) => ({
          transaction_id:      s.transaction_id,
          conflicting_cc_ids:  s.conflicting_cc_ids,
          is_resolved:         false,
          resolved_cc_id:      null,
          resolved_at:         null,
          updated_at:          now,
        })),
        { onConflict: "transaction_id" }
      );
    }
  }

  if (snapshotDeletes.length > 0) {
    for (let i = 0; i < snapshotDeletes.length; i += 200) {
      await supabase
        .from("conflict_snapshots")
        .delete()
        .in("transaction_id", snapshotDeletes.slice(i, i + 200));
    }
  }

  return NextResponse.json({
    processed:  txs.length,
    assigned:   toUpdate.filter((u) => u.cost_center_status === "assigned").length,
    conflicts:  toUpdate.filter((u) => u.cost_center_status === "conflict").length,
    unassigned: toUpdate.filter((u) => u.cost_center_status === "unassigned").length,
  });
}
