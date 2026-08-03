import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { CCReportTx, CCReportResponse } from "@/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();

  const { data: cc, error: ccErr } = await supabase
    .from("cost_centers")
    .select("*")
    .eq("id", id)
    .single();

  if (ccErr || !cc) {
    return NextResponse.json({ error: "Cost center not found" }, { status: 404 });
  }

  // Paginate through all transactions assigned to this cost center
  const allTxs: CCReportTx[] = [];
  let offset = 0;
  const BATCH = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(
        "id,month,year,branch,check_description,vendor,ref_numb," +
        "debit,credit,movement,gl_code,gl_name,category_6"
      )
      .eq("cost_center_id", id)
      .order("id", { ascending: true })
      .range(offset, offset + BATCH - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allTxs.push(...(data as unknown as CCReportTx[]));
    if (data.length < BATCH) break;
    offset += BATCH;
  }

  const response: CCReportResponse = { cost_center: cc, transactions: allTxs };
  return NextResponse.json(response);
}
