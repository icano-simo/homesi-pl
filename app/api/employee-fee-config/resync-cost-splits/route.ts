import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { resyncEmployeeSplits } from "@/lib/resync-employee-splits";
import { requireSession } from "@/lib/auth";

export async function POST() {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  try {
    const result = await resyncEmployeeSplits(supabase);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[resync-cost-splits]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
