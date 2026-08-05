import { createServerClient } from "@/lib/supabase-server";
import { applyEmployeeFeeCostSplits } from "@/lib/apply-employee-fee-cost-splits";
import { buildVersionedSplitsMap, type SplitVersionRow } from "@/lib/split-version-utils";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ResyncEmployeeSplitsResult {
  synced: number;
  skipped: number;
  total: number;
}

/**
 * Button 2 — assign cost splits to all unassigned employee_fee GL 90002 lines
 * using each employee's description3 split rule (version applicable to each
 * transaction's month/year). Writes assignment_origin='split_propagated'.
 */
export async function resyncEmployeeSplits(
  supabase: SupabaseClient,
): Promise<ResyncEmployeeSplitsResult> {
  const unassignedCostTxs: Array<{ id: string; vendor: string | null; year: number | null; month: string | null }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id, vendor, year, month")
      .eq("source", "employee_fee")
      .eq("gl_code", "90002")
      .eq("cost_center_status", "unassigned")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    unassignedCostTxs.push(...(data as Array<{ id: string; vendor: string | null; year: number | null; month: string | null }>));
    if (data.length < 1000) break;
    offset += 1000;
  }

  const total = unassignedCostTxs.length;
  if (total === 0) return { synced: 0, skipped: 0, total: 0 };

  const distinctVendors = [
    ...new Set(
      unassignedCostTxs
        .map((tx) => (tx.vendor ?? "").trim())
        .filter(Boolean),
    ),
  ];

  const { data: rawSplits, error: splitFetchErr } = await supabase
    .from("cc_allocation_splits")
    .select("assign_value, cost_center_id, percentage, is_operational, effective_from_year, effective_from_month")
    .eq("assign_type", "description3")
    .in("assign_value", distinctVendors);
  if (splitFetchErr) throw new Error(splitFetchErr.message);

  const empSplitMap = buildVersionedSplitsMap(
    (rawSplits ?? []).map((r) => ({
      assign_type:          "description3" as const,
      assign_value:         r.assign_value as string,
      cost_center_id:       r.cost_center_id as string,
      percentage:           r.percentage as number,
      is_operational:       (r.is_operational ?? true) as boolean,
      effective_from_year:  (r.effective_from_year ?? null) as number | null,
      effective_from_month: (r.effective_from_month ?? null) as number | null,
    })) as SplitVersionRow[],
  );

  const result = await applyEmployeeFeeCostSplits(supabase, unassignedCostTxs, empSplitMap);
  return { ...result, total };
}
