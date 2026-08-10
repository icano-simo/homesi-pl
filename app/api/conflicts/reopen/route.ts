import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { transaction_id } = await req.json() as { transaction_id: string };
  if (!transaction_id) {
    return NextResponse.json({ error: "transaction_id is required" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: snap, error: snapErr } = await supabase
    .from("conflict_snapshots")
    .select("conflicting_cc_ids")
    .eq("transaction_id", transaction_id)
    .single();

  if (snapErr || !snap) {
    return NextResponse.json({ error: "Conflict snapshot not found" }, { status: 404 });
  }

  const { error: txErr } = await supabase
    .from("pl_transactions")
    .update({
      cost_center_id: null,
      cost_center_status: "conflict",
      cost_center_conflicts: snap.conflicting_cc_ids,
      assignment_origin: null,
    })
    .eq("id", transaction_id);

  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  const { error: updateErr } = await supabase
    .from("conflict_snapshots")
    .update({
      is_resolved: false,
      resolved_cc_id: null,
      resolved_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", transaction_id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
