import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { transaction_ids, cost_center_id, is_operational = true } = await req.json() as {
    transaction_ids: string[];
    cost_center_id: string;
    is_operational?: boolean;
  };

  if (!transaction_ids?.length || !cost_center_id) {
    return NextResponse.json({ error: "transaction_ids and cost_center_id are required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const operational_pct = is_operational ? 100 : 0;

  // Update pl_transactions
  const { error } = await supabase
    .from("pl_transactions")
    .update({
      cost_center_id,
      cost_center_status: "assigned",
      cost_center_conflicts: null,
      assignment_origin: "manual",
      operational_pct,
    })
    .in("id", transaction_ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Record operational classification in cc_allocation_splits (transaction-keyed)
  for (let i = 0; i < transaction_ids.length; i += CHUNK) {
    const chunk = transaction_ids.slice(i, i + CHUNK);

    await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", "transaction")
      .in("assign_value", chunk);

    const { error: insErr } = await supabase.from("cc_allocation_splits").insert(
      chunk.map((tx_id) => ({
        assign_type: "transaction",
        assign_value: tx_id,
        cost_center_id,
        percentage: 100,
        is_operational,
      }))
    );
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ assigned: transaction_ids.length });
}
