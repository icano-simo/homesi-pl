import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { transaction_id, cost_center_id, is_operational = true } = await req.json() as {
    transaction_id: string;
    cost_center_id: string;
    is_operational?: boolean;
  };

  if (!transaction_id || !cost_center_id) {
    return NextResponse.json({ error: "transaction_id and cost_center_id are required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const now = new Date().toISOString();
  const operational_pct = is_operational ? 100 : 0;

  const [txRes, snapRes] = await Promise.all([
    supabase
      .from("pl_transactions")
      .update({ cost_center_id, cost_center_status: "assigned", assignment_origin: "conflict_resolved", operational_pct })
      .eq("id", transaction_id),
    supabase
      .from("conflict_snapshots")
      .update({ resolved_cc_id: cost_center_id, updated_at: now })
      .eq("transaction_id", transaction_id)
      .eq("is_resolved", true),
  ]);

  if (txRes.error) return NextResponse.json({ error: txRes.error.message }, { status: 500 });
  if (snapRes.error) return NextResponse.json({ error: snapRes.error.message }, { status: 500 });

  // Update transaction-keyed cc_allocation_splits
  await supabase
    .from("cc_allocation_splits")
    .delete()
    .eq("assign_type", "transaction")
    .eq("assign_value", transaction_id);

  const { error: insErr } = await supabase.from("cc_allocation_splits").insert({
    assign_type: "transaction",
    assign_value: transaction_id,
    cost_center_id,
    percentage: 100,
    is_operational,
  });
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
