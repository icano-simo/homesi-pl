import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);
  const months = searchParams.getAll("month");
  const years = searchParams.getAll("year").map(Number).filter((n) => !isNaN(n));

  // Paginated. Unbounded, PostgREST stops at 1000 rows and says nothing — the
  // table would simply be short and every dropdown built from it would be
  // missing whatever fell past the cap, which reads as "the filter does not
  // offer that branch" rather than as a truncated fetch. 379 rows today; the
  // same cap already cost us three uploaders.
  const PAGE = 1000;
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("loan_officials").select("*")
      .order("year").order("month").order("loan_number")
      .range(from, from + PAGE - 1);
    if (months.length > 0) q = q.in("month", months);
    if (years.length > 0) q = q.in("year", years);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return NextResponse.json(all);
}
