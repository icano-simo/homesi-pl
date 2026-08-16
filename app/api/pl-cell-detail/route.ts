import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const PAGE = 1000;

const DESC_FIELDS = ["check_description", "check_description_2", "check_description_3"] as const;
export type DescField = (typeof DESC_FIELDS)[number];

export const DESC_LABELS: Record<DescField, string> = {
  check_description:   "Description",
  check_description_2: "Description 2",
  check_description_3: "Description 3",
};

/**
 * Movements behind one cell of the P&L, grouped by whichever description the
 * reader picks.
 *
 * This is what replaced the deep drill-down. The tree now stops at GL, because
 * below it the useful breakdown is by description and no single description
 * serves every account: measured on production, check_description covers
 * everything except Office Expense, where it is empty on 792 of its 835 rows
 * and the content sits in check_description_2 and _3. Office Expense is the
 * only account in the table with that shape.
 *
 * So the choice belongs to the reader — but an uninformed choice lands on a
 * blank screen that reads as a broken page. The response therefore carries the
 * populated count for all three, and the client shows them on the selector.
 */
export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;

  const glCode   = sp.get("gl_code");
  const month    = sp.get("month");
  const years    = sp.getAll("year").map(Number).filter(Boolean);
  const branches = sp.getAll("branch");
  const sources  = sp.getAll("source");
  const ccIds    = sp.getAll("cost_center_id");

  if (!glCode) {
    return NextResponse.json({ error: "gl_code is required" }, { status: 400 });
  }

  try {
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += PAGE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("pl_transactions")
        .select(
          "id,gl_code,gl_name,branch,month,year,vendor,ref_numb,debit,credit,movement," +
          "check_description,check_description_2,check_description_3,cost_center_id",
        )
        .eq("gl_code", glCode);
      if (month)           q = q.eq("month", month);
      if (years.length)    q = q.in("year", years);
      if (branches.length) q = q.in("branch", branches);
      if (sources.length)  q = q.in("source", sources);
      if (ccIds.length)    q = q.in("cost_center_id", ccIds);

      const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    // How many rows each description actually has. The reason the selector can
    // be informed without choosing for the user.
    const coverage = Object.fromEntries(
      DESC_FIELDS.map((f) => [f, rows.filter((r) => String(r[f] ?? "").trim() !== "").length]),
    ) as Record<DescField, number>;

    const total = rows.reduce((s, r) => s + Number(r.movement ?? 0), 0);

    return NextResponse.json({
      gl_code: glCode,
      gl_name: rows[0]?.gl_name ?? null,
      month,
      row_count: rows.length,
      total,
      coverage,
      rows,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
