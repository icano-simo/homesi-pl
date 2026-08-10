import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

/**
 * POST — apply one allocation split to multiple (assign_type, assign_value) targets at once.
 * Body: {
 *   targets: { assign_type: "vendor" | "description3"; assign_value: string }[];
 *   splits:  { cost_center_id: string; percentage: number; is_operational?: boolean }[];
 * }
 * For each target: deletes existing splits, inserts new ones, and updates pl_transactions.
 */
export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const body = await req.json() as {
    targets: { assign_type: "vendor" | "description3"; assign_value: string }[];
    splits: { cost_center_id: string; percentage: number; is_operational?: boolean }[];
  };

  const { targets, splits } = body;

  if (!Array.isArray(targets) || targets.length === 0 ||
      !Array.isArray(splits) || splits.length === 0) {
    return NextResponse.json({ error: "targets and splits are required" }, { status: 400 });
  }

  const total = splits.reduce((s, r) => s + r.percentage, 0);
  if (Math.abs(total - 100) > 0.01) {
    return NextResponse.json(
      { error: `Percentages must sum to 100 (currently ${total.toFixed(3)})` },
      { status: 400 }
    );
  }

  const primaryCcId = [...splits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
  const operationalPct = splits.reduce(
    (s, r) => s + ((r.is_operational ?? true) ? r.percentage : 0),
    0
  );

  const supabase = createServerClient();
  let txUpdated = 0;

  for (const { assign_type, assign_value: rawValue } of targets) {
    const assign_value = assign_type === "vendor" ? norm(rawValue) : rawValue;
    const deleteValues =
      assign_type === "vendor" && assign_value !== rawValue
        ? [rawValue, assign_value]
        : [assign_value];

    // 1. Remove existing splits for this key
    for (const dv of deleteValues) {
      const { error } = await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", assign_type)
        .eq("assign_value", dv);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 2. Insert new splits
    const { error: insErr } = await supabase.from("cc_allocation_splits").insert(
      splits.map((s) => ({
        assign_type,
        assign_value,
        cost_center_id:  s.cost_center_id,
        percentage:      s.percentage,
        is_operational:  s.is_operational ?? true,
      }))
    );
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    // 3. Find matching pl_transactions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let txQ: any = supabase.from("pl_transactions").select("id");
    if (assign_type === "vendor") {
      const vendorLookup =
        assign_value !== rawValue ? [rawValue, assign_value] : [assign_value];
      txQ = txQ.in("vendor", vendorLookup);
    } else {
      txQ = txQ
        .eq("source", "offshore_allocations")
        .eq("check_description_3", assign_value);
    }

    const { data: txRows, error: txErr } = await txQ;
    if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

    const txIds: string[] = (txRows ?? []).map((r: { id: string }) => r.id);

    // 4. Update those transactions in chunks
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

    txUpdated += txIds.length;
  }

  return NextResponse.json({ saved_keys: targets.length, tx_updated: txUpdated });
}
