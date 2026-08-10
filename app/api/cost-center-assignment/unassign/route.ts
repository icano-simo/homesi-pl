import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { transaction_ids } = await req.json() as { transaction_ids: string[] };

  if (!transaction_ids?.length) {
    return NextResponse.json({ error: "transaction_ids is required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Reset pl_transactions to unassigned
  const { error } = await supabase
    .from("pl_transactions")
    .update({
      cost_center_id: null,
      cost_center_status: "unassigned",
      cost_center_conflicts: null,
      assignment_origin: null,
      operational_pct: 100,
    })
    .in("id", transaction_ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Remove transaction-keyed cc_allocation_splits records
  for (let i = 0; i < transaction_ids.length; i += CHUNK) {
    const { error: splitErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", "transaction")
      .in("assign_value", transaction_ids.slice(i, i + CHUNK));
    if (splitErr) return NextResponse.json({ error: splitErr.message }, { status: 500 });
  }

  return NextResponse.json({ unassigned: transaction_ids.length });
}
