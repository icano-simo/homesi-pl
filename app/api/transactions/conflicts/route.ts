import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

const PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const page = Math.max(1, parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10));
  const rangeFrom = (page - 1) * PAGE_SIZE;
  const rangeTo = rangeFrom + PAGE_SIZE - 1;

  const [countRes, dataRes] = await Promise.all([
    supabase
      .from("pl_transactions")
      .select("id", { count: "exact", head: true })
      .eq("cost_center_status", "conflict"),
    supabase
      .from("pl_transactions")
      .select(
        "id,month,year,gl_code,gl_name,branch,check_description,movement,cost_center_conflicts"
      )
      .eq("cost_center_status", "conflict")
      .order("journal_post_date", { ascending: true })
      .order("id", { ascending: true })
      .range(rangeFrom, rangeTo),
  ]);

  if (countRes.error) return NextResponse.json({ error: countRes.error.message }, { status: 500 });
  if (dataRes.error) return NextResponse.json({ error: dataRes.error.message }, { status: 500 });

  return NextResponse.json({ data: dataRes.data ?? [], count: countRes.count ?? 0 });
}
