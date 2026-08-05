import { createServerClient } from "@/lib/supabase-server";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import {
  findApplicableVersion,
  type VersionedSplitsMap,
} from "@/lib/split-version-utils";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ApplyCostSplitsResult {
  synced: number;
  skipped: number;
}

/**
 * Copies an employee's cc_allocation_splits (assign_type='description3')
 * onto Cost fee transactions (GL 90002) as transaction-level split rows.
 * Respects temporal versioning: each transaction is matched to the version
 * of the employee's split rule that was in effect at the transaction's period.
 *
 * Called from:
 *   - generateEmployeeFeeLines (step 7b) for newly created lines
 *   - POST /api/employee-fee-config/resync-cost-splits for retroactive backfill
 *
 * Transactions with no applicable version in empSplitMap are left unassigned.
 *
 * @param costTxs    Array of {id, vendor, year?, month?} — must all be GL 90002
 * @param empSplitMap Pre-loaded: VersionedSplitsMap keyed "description3:{empName}"
 */
export async function applyEmployeeFeeCostSplits(
  supabase: SupabaseClient,
  costTxs: Array<{ id: string; vendor: string | null; year?: number | null; month?: string | null }>,
  empSplitMap: VersionedSplitsMap,
): Promise<ApplyCostSplitsResult> {
  type SplitInsertRow = {
    assign_type:    string;
    assign_value:   string;
    cost_center_id: string;
    percentage:     number;
    is_operational: boolean | null;
  };

  const splitsToInsert: SplitInsertRow[] = [];
  const txUpdates: Array<{
    id:                 string;
    cost_center_id:     string;
    cost_center_status: string;
    assignment_origin:  string;
  }> = [];

  for (const tx of costTxs) {
    const emp     = (tx.vendor ?? "").trim().replace(/\s+/g, " ");
    const versions = empSplitMap.get(`description3:${emp}`);
    if (!versions || versions.length === 0) continue;

    const ver = findApplicableVersion(versions, tx.year, tx.month);
    if (!ver) continue;

    const splits = ver.splits;
    for (const s of splits) {
      splitsToInsert.push({
        assign_type:    "transaction",
        assign_value:   tx.id,
        cost_center_id: s.cost_center_id,
        percentage:     s.percentage,
        is_operational: s.is_operational,
      });
    }

    const primaryCC = splits.reduce((best, s) =>
      s.percentage > best.percentage ? s : best,
    ).cost_center_id;

    txUpdates.push({
      id:                 tx.id,
      cost_center_id:     primaryCC,
      cost_center_status: "assigned",
      assignment_origin:  "split_propagated",
    });
  }

  if (splitsToInsert.length > 0) {
    for (let i = 0; i < splitsToInsert.length; i += INSERT_CHUNK_SIZE) {
      const chunk = splitsToInsert.slice(i, i + INSERT_CHUNK_SIZE);
      const { error } = await supabase.from("cc_allocation_splits").insert(chunk);
      if (error) throw new Error(`Insert cost split allocations: ${error.message}`);
    }
  }

  if (txUpdates.length > 0) {
    for (let i = 0; i < txUpdates.length; i += INSERT_CHUNK_SIZE) {
      await Promise.all(
        txUpdates.slice(i, i + INSERT_CHUNK_SIZE).map((u) =>
          supabase
            .from("pl_transactions")
            .update({
              cost_center_id:     u.cost_center_id,
              cost_center_status: u.cost_center_status,
              assignment_origin:  u.assignment_origin,
            })
            .eq("id", u.id),
        ),
      );
    }
  }

  return {
    synced:  txUpdates.length,
    skipped: costTxs.length - txUpdates.length,
  };
}
