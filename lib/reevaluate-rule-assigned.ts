/**
 * Targeted re-evaluation of non-manual transactions.
 *
 * Used when a Cost Center or Split Rule is modified/deleted.
 * Covers assignment_origin = 'rule', 'rule_split', NULL (legacy rows), and any
 * other non-'manual' value.  Transactions with assignment_origin = 'manual' are
 * NEVER touched here.
 */

import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { createServerClient } from "@/lib/supabase-server";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import type {
  PLTransaction,
  SplitRule,
  SplitRuleWithDetails,
  SplitRuleCondition,
  SplitRuleAllocation,
} from "@/types";

type SupabaseClient = ReturnType<typeof createServerClient>;

// ─── Loan Officials enrichment ────────────────────────────────────────────────

type LoanOfficialFields = {
  loan_number: string;
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  affinity: boolean;
  recruitment: boolean;
  lead_source_lo: string | null;
  bd_owner: string | null;
};

/**
 * Loads all loan official boolean/text fields keyed by loan_number.
 * Used to enrich transactions before cost-center rule evaluation.
 */
export async function loadLoanOfficialFields(
  supabase: SupabaseClient
): Promise<Map<string, LoanOfficialFields>> {
  const { data } = await supabase
    .from("loan_officials")
    .select("loan_number,b2b,processing,support_on_demand,affinity,recruitment,lead_source_lo,bd_owner")
    .not("loan_number", "is", null);

  const map = new Map<string, LoanOfficialFields>();
  for (const row of (data ?? []) as LoanOfficialFields[]) {
    map.set(row.loan_number, row);
  }
  return map;
}

/**
 * Merges loan official fields onto a transaction object.
 * If loan_number is null or loan_number_incomplete=true, returns the tx unchanged
 * (loan official fields will be undefined → evaluator treats as no-match).
 */
export function enrichTxWithLoanOfficials(
  tx: Record<string, unknown>,
  loMap: Map<string, LoanOfficialFields>
): Record<string, unknown> {
  const loanNum = tx.loan_number as string | null | undefined;
  const incomplete = tx.loan_number_incomplete as boolean | null | undefined;
  if (!loanNum || incomplete) return tx;
  const lo = loMap.get(loanNum);
  if (!lo) return tx;
  return {
    ...tx,
    b2b: lo.b2b,
    processing: lo.processing,
    support_on_demand: lo.support_on_demand,
    affinity: lo.affinity,
    recruitment: lo.recruitment,
    lead_source_lo: lo.lead_source_lo,
    bd_owner: lo.bd_owner,
  };
}

export type ReevalStats = {
  reevaluated: number;
  reassigned: number;
  unassigned: number;
  conflicts: number;
};

const TX_FIELDS =
  "id,gl_code,gl_name,branch,vendor,check_description," +
  "ref_numb,category_5,category_6,doc_type,month,year,debit,credit,movement," +
  "loan_number,loan_number_incomplete";

const UPDATE_PARALLEL = 100;

/**
 * Loads all split rules with their conditions and allocations from the database.
 * Call AFTER any mutation so the result reflects the current state.
 */
export async function loadAllSplitRules(supabase: SupabaseClient): Promise<SplitRuleWithDetails[]> {
  const [{ data: rules }, { data: conditions }, { data: allocations }] = await Promise.all([
    supabase.from("split_rules").select("*"),
    supabase.from("split_rule_conditions").select("*").order("sequence"),
    supabase.from("split_rule_allocations").select("*").order("display_order"),
  ]);

  const condsByRule = new Map<string, SplitRuleCondition[]>();
  for (const c of (conditions ?? []) as SplitRuleCondition[]) {
    const arr = condsByRule.get(c.split_rule_id) ?? [];
    arr.push(c);
    condsByRule.set(c.split_rule_id, arr);
  }

  const allocsByRule = new Map<string, SplitRuleAllocation[]>();
  for (const a of (allocations ?? []) as SplitRuleAllocation[]) {
    const arr = allocsByRule.get(a.split_rule_id) ?? [];
    arr.push(a);
    allocsByRule.set(a.split_rule_id, arr);
  }

  return (rules ?? []).map((sr) => ({
    ...(sr as SplitRule),
    conditions: condsByRule.get(sr.id as string) ?? [],
    allocations: allocsByRule.get(sr.id as string) ?? [],
  }));
}

/**
 * Fetches the IDs of all re-evaluable transactions for a given Cost Center.
 * Excludes only assignment_origin = 'manual'.
 */
export async function getRuleAssignedTxIds(
  supabase: SupabaseClient,
  ccId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    const { data } = await supabase
      .from("pl_transactions")
      .select("id")
      .eq("cost_center_id", ccId)
      .or("assignment_origin.neq.manual,assignment_origin.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (!data || data.length === 0) break;
    ids.push(...(data as { id: string }[]).map((r) => r.id));
    if (data.length < 1000) break;
    offset += 1000;
  }

  return ids;
}

/**
 * Re-evaluates a specific set of transactions against the current ruleset.
 * Updates pl_transactions and syncs conflict_snapshots.
 */
export async function reevaluateRuleAssigned(
  supabase: SupabaseClient,
  txIds: string[],
  splitRules: SplitRuleWithDetails[] = [],
): Promise<ReevalStats> {
  if (txIds.length === 0) {
    return { reevaluated: 0, reassigned: 0, unassigned: 0, conflicts: 0 };
  }

  type TxRow = { id: string } & Record<string, unknown>;
  const [txsRaw, loMap] = await Promise.all([
    (async () => {
      const result: TxRow[] = [];
      for (let i = 0; i < txIds.length; i += 1000) {
        const chunk = txIds.slice(i, i + 1000);
        const { data } = await supabase.from("pl_transactions").select(TX_FIELDS).in("id", chunk);
        if (data) result.push(...(data as unknown as TxRow[]));
      }
      return result;
    })(),
    loadLoanOfficialFields(supabase),
  ]);
  const txs = txsRaw.map((tx) => enrichTxWithLoanOfficials(tx, loMap) as TxRow);

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
    const r = evaluateCostCenterRules(tx as unknown as PLTransaction, splitRules);
    const origin =
      r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";

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
    } else {
      snapshotDeletes.push(tx.id);
    }
  }

  for (let i = 0; i < toUpdate.length; i += UPDATE_PARALLEL) {
    await Promise.all(
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
  }

  await syncRuleSplitAllocations(supabase, txs.map((t) => t.id), ruleSplitEntries);

  const now = new Date().toISOString();

  if (snapshotUpserts.length > 0) {
    for (let i = 0; i < snapshotUpserts.length; i += 200) {
      await supabase.from("conflict_snapshots").upsert(
        snapshotUpserts.slice(i, i + 200).map((s) => ({
          transaction_id: s.transaction_id,
          conflicting_cc_ids: s.conflicting_cc_ids,
          is_resolved: false,
          resolved_cc_id: null,
          resolved_at: null,
          updated_at: now,
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

  return {
    reevaluated: txs.length,
    reassigned: toUpdate.filter((u) => u.cost_center_status === "assigned").length,
    unassigned: toUpdate.filter((u) => u.cost_center_status === "unassigned").length,
    conflicts: toUpdate.filter((u) => u.cost_center_status === "conflict").length,
  };
}
