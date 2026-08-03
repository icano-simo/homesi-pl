import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    type: "description3" | "vendor";
    value: string;
    cost_center_id: string;
  };

  const { type, value, cost_center_id } = body;

  if (!type || !value || !cost_center_id) {
    return NextResponse.json(
      { error: "type, value, and cost_center_id are required" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  const field = type === "description3" ? "check_description_3" : "vendor";

  // Fetch all matching IDs (source = offshore_allocations AND field = value)
  const allIds: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id")
      .eq("source", "offshore_allocations")
      .eq(field, value)
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    allIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < 1000) break;
    offset += 1000;
  }

  if (allIds.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  // Update in batches of 500
  let updated = 0;
  for (let i = 0; i < allIds.length; i += 500) {
    const batch = allIds.slice(i, i + 500);
    const { error: updErr } = await supabase
      .from("pl_transactions")
      .update({
        cost_center_id,
        cost_center_status: "assigned",
        cost_center_conflicts: null,
        assignment_origin: "split_propagated",
      })
      .in("id", batch);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    updated += batch.length;
  }

  return NextResponse.json({ updated });
}
