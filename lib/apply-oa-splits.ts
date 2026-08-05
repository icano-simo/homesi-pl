import { createServerClient } from "@/lib/supabase-server";
import {
  buildVersionedSplitsMap,
  findApplicableVersion,
  toPeriod,
  txMonthPeriod,
  type SplitVersionRow,
  type VersionedSplitsMap,
} from "@/lib/split-version-utils";

type SupabaseClient = ReturnType<typeof createServerClient>;

const CHUNK = 500;

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

async function loadVersionedOASplits(supabase: SupabaseClient): Promise<VersionedSplitsMap> {
  const { data, error } = await supabase
    .from("cc_allocation_splits")
    .select("assign_type,assign_value,cost_center_id,percentage,is_operational,effective_from_year,effective_from_month")
    .in("assign_type", ["description3", "vendor"]);
  if (error) throw new Error(error.message);
  return buildVersionedSplitsMap((data ?? []) as SplitVersionRow[]);
}

type TxRow = {
  id: string;
  check_description_3: string | null;
  vendor: string | null;
  year: number | null;
  month: string | null;
};

async function fetchUnassignedOATxs(supabase: SupabaseClient): Promise<TxRow[]> {
  const rows: TxRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id,check_description_3,vendor,year,month")
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
 * Button 1 — apply description3/vendor split rules (respecting temporal versions)
 * to all unassigned OA transactions. Each transaction is matched to the version of
 * the rule that was in effect at the transaction's month/year.
 */
export async function applyOASplits(supabase: SupabaseClient): Promise<ApplyOASplitsResult> {
  const vMap = await loadVersionedOASplits(supabase);
  if (vMap.size === 0) return { assigned: 0, breakdown: [] };

  const txRows = await fetchUnassignedOATxs(supabase);

  type GroupKey = string;
  type GroupData = { splits: { cost_center_id: string; percentage: number; is_operational: boolean }[]; txIds: string[]; displayKey: string };
  const matchedGroups = new Map<GroupKey, GroupData>();

  for (const tx of txRows) {
    const normVendor = tx.vendor ? norm(tx.vendor) : null;
    const normCd3    = tx.check_description_3 ? norm(tx.check_description_3) : null;
    const keyStr =
      (normVendor && vMap.has(`vendor:${normVendor}`))         ? `vendor:${normVendor}` :
      (normCd3   && vMap.has(`description3:${normCd3}`))       ? `description3:${normCd3}` :
      null;
    if (!keyStr) continue;

    const versions = vMap.get(keyStr)!;
    const ver = findApplicableVersion(versions, tx.year, tx.month);
    if (!ver) continue;

    const groupKey = `${keyStr}::${ver.period}`;
    if (!matchedGroups.has(groupKey)) {
      matchedGroups.set(groupKey, {
        splits:     ver.splits,
        txIds:      [],
        displayKey: keyStr.replace(/^(vendor|description3):/, ""),
      });
    }
    matchedGroups.get(groupKey)!.txIds.push(tx.id);
  }

  const countByDisplayKey = new Map<string, number>();
  let totalAssigned = 0;

  for (const [, group] of matchedGroups) {
    const { splits: keySplits, txIds, displayKey } = group;
    const primaryCcId     = [...keySplits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
    const operationalPct  = keySplits.reduce((sum, s) => sum + (s.is_operational ? s.percentage : 0), 0);

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

    countByDisplayKey.set(displayKey, (countByDisplayKey.get(displayKey) ?? 0) + txIds.length);
    totalAssigned += txIds.length;
  }

  const breakdown = [...countByDisplayKey.entries()].map(([key, count]) => ({ key, count }));
  return { assigned: totalAssigned, breakdown };
}

/**
 * GET helper — count of unassigned OA txs that have an applicable version.
 */
export async function countMatchableOATxs(supabase: SupabaseClient): Promise<{
  count: number;
  breakdown: { key: string; count: number }[];
}> {
  const vMap = await loadVersionedOASplits(supabase);
  if (vMap.size === 0) return { count: 0, breakdown: [] };
  const txRows = await fetchUnassignedOATxs(supabase);

  const countMap = new Map<string, number>();
  for (const tx of txRows) {
    const normVendor = tx.vendor ? norm(tx.vendor) : null;
    const normCd3    = tx.check_description_3 ? norm(tx.check_description_3) : null;
    const keyStr =
      (normVendor && vMap.has(`vendor:${normVendor}`))   ? `vendor:${normVendor}` :
      (normCd3   && vMap.has(`description3:${normCd3}`)) ? `description3:${normCd3}` :
      null;
    if (!keyStr) continue;
    const versions = vMap.get(keyStr)!;
    if (!findApplicableVersion(versions, tx.year, tx.month)) continue;
    const dk = keyStr.replace(/^(vendor|description3):/, "");
    countMap.set(dk, (countMap.get(dk) ?? 0) + 1);
  }

  const breakdown = [...countMap.entries()].map(([key, count]) => ({ key, count }));
  const count = breakdown.reduce((s, r) => s + r.count, 0);
  return { count, breakdown };
}
