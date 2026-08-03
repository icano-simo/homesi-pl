import { createServerClient } from "@/lib/supabase-server";

type SupabaseClient = ReturnType<typeof createServerClient>;

const CHUNK = 500;

type SplitRow = {
  assign_type: "description3" | "vendor";
  assign_value: string;
  cost_center_id: string;
  percentage: number;
  is_operational: boolean;
};

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

async function loadOASplits(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("cc_allocation_splits")
    .select("assign_type,assign_value,cost_center_id,percentage,is_operational")
    .in("assign_type", ["description3", "vendor"]);
  if (error) throw new Error(error.message);
  const splits = (data ?? []) as SplitRow[];
  const byKey = new Map<string, SplitRow[]>();
  for (const s of splits) {
    const key = `${s.assign_type}:${norm(s.assign_value)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  return byKey;
}

async function fetchUnassignedOATxs(supabase: SupabaseClient) {
  type TxRow = { id: string; check_description_3: string | null; vendor: string | null };
  const rows: TxRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id,check_description_3,vendor")
      .eq("source", "offshore_allocations")
      .or("cost_center_status.eq.unassigned,cost_center_status.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as TxRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

export interface ApplyOASplitsResult {
  assigned: number;
  breakdown: { key: string; count: number }[];
}

/**
 * Button 1 — apply existing description3/vendor split rules to all unassigned OA transactions.
 * Writes assignment_origin='split_propagated' so auto-propagation can update these assignments
 * when a split rule changes; 'manual' is reserved for explicit per-transaction exceptions.
 */
export async function applyOASplits(supabase: SupabaseClient): Promise<ApplyOASplitsResult> {
  const byKey = await loadOASplits(supabase);
  if (byKey.size === 0) return { assigned: 0, breakdown: [] };

  const txRows = await fetchUnassignedOATxs(supabase);

  const matchedGroups = new Map<string, string[]>();
  for (const tx of txRows) {
    const normVendor = tx.vendor ? norm(tx.vendor) : null;
    const normCd3 = tx.check_description_3 ? norm(tx.check_description_3) : null;
    const key =
      (normVendor && byKey.has(`vendor:${normVendor}`))   ? `vendor:${normVendor}` :
      (normCd3   && byKey.has(`description3:${normCd3}`)) ? `description3:${normCd3}` :
      null;
    if (key) {
      if (!matchedGroups.has(key)) matchedGroups.set(key, []);
      matchedGroups.get(key)!.push(tx.id);
    }
  }

  const breakdown: { key: string; count: number }[] = [];
  let totalAssigned = 0;

  for (const [key, txIds] of matchedGroups) {
    const keySplits = byKey.get(key)!;
    const primaryCcId = [...keySplits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
    const operationalPct = keySplits.reduce((sum, s) => sum + (s.is_operational ? s.percentage : 0), 0);

    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        primaryCcId,
          cost_center_status:    "assigned",
          cost_center_conflicts: null,
          assignment_origin:     "split_propagated",
          operational_pct:       operationalPct,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) throw new Error(updErr.message);
    }

    for (let i = 0; i < txIds.length; i += CHUNK) {
      await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", txIds.slice(i, i + CHUNK));
    }
    const splitRows = txIds.flatMap((txId) =>
      keySplits.map((s) => ({
        assign_type:    "transaction" as const,
        assign_value:   txId,
        cost_center_id: s.cost_center_id,
        percentage:     s.percentage,
        is_operational: s.is_operational,
      }))
    );
    for (let i = 0; i < splitRows.length; i += CHUNK) {
      const { error: splErr } = await supabase
        .from("cc_allocation_splits")
        .insert(splitRows.slice(i, i + CHUNK));
      if (splErr) throw new Error(splErr.message);
    }

    breakdown.push({ key: key.replace(/^(vendor|description3):/, ""), count: txIds.length });
    totalAssigned += txIds.length;
  }

  return { assigned: totalAssigned, breakdown };
}

/**
 * GET helper — count of unassigned OA txs with a matching description3/vendor split rule.
 */
export async function countMatchableOATxs(supabase: SupabaseClient): Promise<{
  count: number;
  breakdown: { key: string; count: number }[];
}> {
  const byKey = await loadOASplits(supabase);
  if (byKey.size === 0) return { count: 0, breakdown: [] };
  const txRows = await fetchUnassignedOATxs(supabase);

  const countMap = new Map<string, number>();
  for (const tx of txRows) {
    const normVendor = tx.vendor ? norm(tx.vendor) : null;
    const normCd3 = tx.check_description_3 ? norm(tx.check_description_3) : null;
    const key =
      (normVendor && byKey.has(`vendor:${normVendor}`))   ? `vendor:${normVendor}` :
      (normCd3   && byKey.has(`description3:${normCd3}`)) ? `description3:${normCd3}` :
      null;
    if (key) countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  const breakdown = [...countMap.entries()].map(([key, count]) => ({
    key: key.replace(/^(vendor|description3):/, ""),
    count,
  }));

  const count = txRows.filter((tx) => {
    const nv = tx.vendor ? norm(tx.vendor) : null;
    const nc = tx.check_description_3 ? norm(tx.check_description_3) : null;
    return (nv && byKey.has(`vendor:${nv}`)) || (nc && byKey.has(`description3:${nc}`));
  }).length;

  return { count, breakdown };
}
