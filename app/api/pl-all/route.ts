import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { PLReportTx } from "@/types";

export const dynamic = "force-dynamic";

const SELECT =
  "id,month,branch,check_description,check_description_2,check_description_3," +
  "vendor,ref_numb,debit,credit,movement,operational_pct,loan_number," +
  "gl_code,gl_name,category_2,category_6,category_7,order_1,order_2,order_3," +
  "cost_center_id,cost_center_status,cost_centers(name)";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const years    = searchParams.getAll("year");
  const branches = searchParams.getAll("branch");
  const sources  = searchParams.getAll("source");

  const supabase = createServerClient();
  const all: PLReportTx[] = [];
  let offset = 0;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("pl_transactions").select(SELECT)
      .order("journal_post_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (years.length > 0)    q = q.in("year", years.map((y) => parseInt(y, 10)));
    if (branches.length > 0) q = q.in("branch", branches);
    if (sources.length > 0)  q = q.in("source", sources);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...(data as PLReportTx[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  return NextResponse.json(all);
}
