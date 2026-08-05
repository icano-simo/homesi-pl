import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { applyOASplits, countMatchableOATxs } from "@/lib/apply-oa-splits";

export const dynamic = "force-dynamic";

// GET — count of unassigned OA txs that have a matching split rule
export async function GET() {
  const supabase = createServerClient();
  try {
    const result = await countMatchableOATxs(supabase);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST — apply existing description3/vendor split rules to all matching unassigned OA transactions
export async function POST() {
  const supabase = createServerClient();
  try {
    const result = await applyOASplits(supabase);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
