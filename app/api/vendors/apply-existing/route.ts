import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const CHUNK = 500;

type SplitRow = {
  assign_value: string;
  cost_center_id: string;
  percentage: number;
  is_operational: boolean;
};

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

/** Loads vendor splits and returns:
 *  - byNormKey: normalized(assign_value) → SplitRow[]
 *  - allVendorVariants: both raw and normalized assign_values for DB IN query
 */
async function loadVendorSplits(supabase: ReturnType<typeof createServerClient>) {
  const { data, error } = await supabase
    .from("cc_allocation_splits")
    .select("assign_value,cost_center_id,percentage,is_operational")
    .eq("assign_type", "vendor");

  if (error) throw new Error(error.message);
  const splits = (data ?? []) as SplitRow[];

  const byNormKey = new Map<string, SplitRow[]>();
  const allVendorVariants = new Set<string>();

  for (const s of splits) {
    const normKey = norm(s.assign_value);
    if (!byNormKey.has(normKey)) byNormKey.set(normKey, []);
    byNormKey.get(normKey)!.push(s);
    allVendorVariants.add(s.assign_value);
    allVendorVariants.add(normKey);
  }

  return { byNormKey, allVendorVariants: [...allVendorVariants] };
}

/** Fetch unassigned txs whose vendor matches any of the given values (IN query, chunked). */
async function fetchUnassignedByVendors(
  supabase: ReturnType<typeof createServerClient>,
  vendorVariants: string[]
) {
  const rows: { id: string; vendor: string | null }[] = [];
  for (let i = 0; i < vendorVariants.length; i += CHUNK) {
    const chunk = vendorVariants.slice(i, i + CHUNK);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("pl_transactions")
        .select("id,vendor")
        .in("vendor", chunk)
        .or("cost_center_status.eq.unassigned,cost_center_status.is.null")
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as { id: string; vendor: string | null }[]));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  // Deduplicate by id (raw + normalized might yield duplicates)
  const seen = new Set<string>();
  return rows.filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}

// GET — count of unassigned transactions that have a matching vendor assignment
export async function GET() {
  const supabase = createServerClient();

  let byNormKey: Map<string, SplitRow[]>;
  let allVendorVariants: string[];
  try {
    ({ byNormKey, allVendorVariants } = await loadVendorSplits(supabase));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  if (byNormKey.size === 0) return NextResponse.json({ count: 0, breakdown: [] });

  let txRows: { id: string; vendor: string | null }[];
  try { txRows = await fetchUnassignedByVendors(supabase, allVendorVariants); } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  const countMap = new Map<string, number>();
  for (const tx of txRows) {
    const normVendor = norm(tx.vendor ?? "");
    if (byNormKey.has(normVendor)) {
      countMap.set(normVendor, (countMap.get(normVendor) ?? 0) + 1);
    }
  }

  const breakdown = [...countMap.entries()].map(([key, count]) => ({
    key: byNormKey.get(key)?.[0]?.assign_value ?? key,
    count,
  }));

  return NextResponse.json({ count: txRows.length, breakdown });
}

// POST — apply existing vendor assignments to all matching unassigned transactions
export async function POST() {
  const supabase = createServerClient();

  let byNormKey: Map<string, SplitRow[]>;
  let allVendorVariants: string[];
  try {
    ({ byNormKey, allVendorVariants } = await loadVendorSplits(supabase));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  if (byNormKey.size === 0) return NextResponse.json({ assigned: 0, breakdown: [] });

  let txRows: { id: string; vendor: string | null }[];
  try { txRows = await fetchUnassignedByVendors(supabase, allVendorVariants); } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  // Group tx IDs by normalized vendor key
  const matchedGroups = new Map<string, string[]>(); // normKey → [txId]
  for (const tx of txRows) {
    const normVendor = norm(tx.vendor ?? "");
    if (byNormKey.has(normVendor)) {
      if (!matchedGroups.has(normVendor)) matchedGroups.set(normVendor, []);
      matchedGroups.get(normVendor)!.push(tx.id);
    }
  }

  const breakdown: { key: string; count: number }[] = [];
  let totalAssigned = 0;

  for (const [normKey, txIds] of matchedGroups) {
    const keySplits = byNormKey.get(normKey)!;
    const primaryCcId = [...keySplits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
    const operationalPct = keySplits.reduce((sum, s) => sum + (s.is_operational ? s.percentage : 0), 0);

    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        primaryCcId,
          cost_center_status:    "assigned",
          cost_center_conflicts: null,
          assignment_origin:     "manual",
          operational_pct:       operationalPct,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    // Write per-transaction split rows mirroring the matched vendor split
    // so Transaction Review shows full Split Detail instead of a single flattened CC.
    for (let i = 0; i < txIds.length; i += CHUNK) {
      await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", txIds.slice(i, i + CHUNK));
    }
    const splitRows = txIds.flatMap((txId) =>
      keySplits.map((s) => ({
        assign_type: "transaction" as const,
        assign_value: txId,
        cost_center_id: s.cost_center_id,
        percentage: s.percentage,
        is_operational: s.is_operational,
      }))
    );
    for (let i = 0; i < splitRows.length; i += CHUNK) {
      const { error: splErr } = await supabase
        .from("cc_allocation_splits")
        .insert(splitRows.slice(i, i + CHUNK));
      if (splErr) return NextResponse.json({ error: splErr.message }, { status: 500 });
    }

    breakdown.push({ key: keySplits[0].assign_value, count: txIds.length });
    totalAssigned += txIds.length;
  }

  return NextResponse.json({ assigned: totalAssigned, breakdown });
}
