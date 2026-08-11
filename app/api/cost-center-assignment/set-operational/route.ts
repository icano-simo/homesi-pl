import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

export async function POST(req: Request) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();

  let body: { transaction_ids: string[]; is_operational: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { transaction_ids, is_operational } = body;
  if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
    return NextResponse.json({ error: "transaction_ids required" }, { status: 400 });
  }

  const operationalPct = is_operational ? 100 : 0;

  for (let i = 0; i < transaction_ids.length; i += CHUNK) {
    const { error } = await supabase
      .from("pl_transactions")
      .update({ operational_pct: operationalPct })
      .in("id", transaction_ids.slice(i, i + CHUNK));

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ updated: transaction_ids.length });
}
