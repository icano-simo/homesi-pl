import { createServerClient } from "@/lib/supabase-server";
import { applyEmployeeFeeCostSplits, type EmpSplitRow } from "@/lib/apply-employee-fee-cost-splits";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface ResyncEmployeeSplitsResult {
  synced: number;
  skipped: number;
  total: number;
}

/**
 * Button 2 — assign cost splits to all unassigned employee_fee GL 90002 lines
 * using each employee's description3 split rule.
 * Writes assignment_origin='split_propagated'.
 */
export async function resyncEmployeeSplits(
  supabase: SupabaseClient,
): Promise<ResyncEmployeeSplitsResult> {
  const unassignedCostTxs: Array<{ id: string; vendor: string | null }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id, vendor")
      .eq("source", "employee_fee")
      .eq("gl_code", "90002")
      .eq("cost_center_status", "unassigned")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    unassignedCostTxs.push(...(data as Array<{ id: string; vendor: string | null }>));
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
    .select("assign_value, cost_center_id, percentage, is_operational")
    .eq("assign_type", "description3")
    .in("assign_value", distinctVendors);
  if (splitFetchErr) throw new Error(splitFetchErr.message);

  const empSplitMap = new Map<string, EmpSplitRow[]>();
  for (const row of (rawSplits ?? []) as Array<{
    assign_value: string;
    cost_center_id: string;
    percentage: number;
    is_operational: boolean | null;
  }>) {
    if (!empSplitMap.has(row.assign_value)) empSplitMap.set(row.assign_value, []);
    empSplitMap.get(row.assign_value)!.push({
      cost_center_id: row.cost_center_id,
      percentage:     row.percentage,
      is_operational: row.is_operational,
    });
  }

  const result = await applyEmployeeFeeCostSplits(supabase, unassignedCostTxs, empSplitMap);
  return { ...result, total };
}
