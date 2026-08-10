import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { vendor_key, cost_center_id, branch, month, year } = await req.json() as {
    vendor_key: string;
    cost_center_id: string;
    branch?: string[];
    month?: string[];
    year?: number[];
  };

  if (!vendor_key || !cost_center_id) {
    return NextResponse.json({ error: "vendor_key and cost_center_id are required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Find all matching transaction IDs
  let idQ = supabase
    .from("pl_transactions")
    .select("id")
    .not("vendor", "is", null);

  if (branch?.length) idQ = idQ.in("branch", branch);
  if (month?.length)  idQ = idQ.in("month", month);
  if (year?.length)   idQ = idQ.in("year", year);

  const { data: allTxs, error: fetchErr } = await idQ;
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  // Filter by vendor_key client-side (normalized match)
  const matchingIds = (allTxs ?? [])
    .filter((r: { id: string; vendor?: string | null }) => {
      const k = (r as unknown as { vendor?: string | null }).vendor;
      return k != null && k.trim().replace(/\s+/g, " ").toLowerCase() === vendor_key;
    })
    .map((r: { id: string }) => r.id);

  // Supabase doesn't support computed column filters, so we fetch with vendor field and filter in JS
  // Re-fetch with vendor included
  let vQ = supabase.from("pl_transactions").select("id,vendor")
    .not("vendor", "is", null);
  if (branch?.length) vQ = vQ.in("branch", branch);
  if (month?.length)  vQ = vQ.in("month", month);
  if (year?.length)   vQ = vQ.in("year", year);

  const { data: vRows, error: vErr } = await vQ;
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 });

  const ids = (vRows ?? [])
    .filter((r: { id: string; vendor: string | null }) =>
      r.vendor != null &&
      r.vendor.trim().replace(/\s+/g, " ").toLowerCase() === vendor_key
    )
    .map((r: { id: string }) => r.id);

  void matchingIds; // unused now

  if (ids.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  // Update in batches of 500
  let updated = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error: updErr } = await supabase
      .from("pl_transactions")
      .update({
        cost_center_id,
        cost_center_status: "assigned",
        cost_center_conflicts: null,
        assignment_origin: "manual",
      })
      .in("id", batch);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    updated += batch.length;
  }

  return NextResponse.json({ updated });
}
