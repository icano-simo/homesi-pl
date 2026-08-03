import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { PLReportTx } from "@/types";

export const dynamic = "force-dynamic";

const SELECT =
  "id,month,branch,check_description,vendor,ref_numb,debit,credit,movement," +
  "gl_code,gl_name,category_2,category_7,order_1,order_2";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ccs      = searchParams.getAll("cc");   // UUIDs | "unassigned" | "conflict"
  const years    = searchParams.getAll("year");
  const branches = searchParams.getAll("branch");
  const sources  = searchParams.getAll("source");

  if (ccs.length === 0) return NextResponse.json({ error: "At least one cc param required" }, { status: 400 });

  const supabase = createServerClient();
  const all: PLReportTx[] = [];
  let offset = 0;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("pl_transactions").select(SELECT).order("id", { ascending: true }).range(offset, offset + 999);

    // Build CC filter — may combine UUIDs with status sentinels via OR
    const ccIds = ccs.filter((c) => c !== "unassigned" && c !== "conflict");
    const orParts: string[] = [];
    if (ccIds.length > 0)             orParts.push(`cost_center_id.in.(${ccIds.join(",")})`);
    if (ccs.includes("unassigned"))   orParts.push("cost_center_status.eq.unassigned");
    if (ccs.includes("conflict"))     orParts.push("cost_center_status.eq.conflict");
    if (orParts.length > 0)           q = q.or(orParts.join(","));

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
