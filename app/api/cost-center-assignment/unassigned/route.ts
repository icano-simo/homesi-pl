import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { AssignmentGroup } from "@/types";

export const dynamic = "force-dynamic";

const SELECT =
  "id,gl_code,gl_name,month,year,branch,check_description,check_description_2,check_description_3," +
  "vendor,debit,credit,movement,cost_center_id,cost_center_status,assignment_origin";

type Row = {
  id: string; gl_code: string|null; gl_name: string|null; month: string|null; year: number|null;
  branch: string|null; check_description: string|null; check_description_2: string|null; check_description_3: string|null;
  vendor: string|null; debit: number; credit: number; movement: number|null;
  cost_center_id: string|null; cost_center_status: string|null; assignment_origin: string|null;
};

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const branches = new URL(req.url).searchParams.getAll("branch");
  const rows: Row[] = [];
  let offset = 0;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select(SELECT)
      .or("cost_center_status.eq.unassigned,cost_center_status.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (branches.length > 0) q = q.in("branch", branches);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Row[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  const groupMap = new Map<string, AssignmentGroup>();
  for (const tx of rows) {
    const key = tx.gl_code ?? "(No GL Code)";
    if (!groupMap.has(key)) groupMap.set(key, { gl_code: key, gl_name: tx.gl_name ?? "", transactions: [] });
    groupMap.get(key)!.transactions.push({
      id: tx.id, gl_code: tx.gl_code, gl_name: tx.gl_name,
      month: tx.month, year: tx.year, branch: tx.branch,
      check_description: tx.check_description,
      check_description_2: tx.check_description_2, check_description_3: tx.check_description_3,
      vendor: tx.vendor, debit: tx.debit, credit: tx.credit, movement: tx.movement,
      cost_center_id: null, cost_center_name: null, assignment_origin: tx.assignment_origin,
      operational_pct: 100,
    });
  }

  return NextResponse.json([...groupMap.values()]);
}
