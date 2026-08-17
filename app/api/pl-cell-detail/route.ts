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
 * Sentinels for a blank description, and the note level each field anchors to.
 *
 * Copied deliberately from getGroup() in lib/pivot-engine.ts rather than
 * invented here. These strings are what a note's scope stores, so if the two
 * ever disagreed a note written from this window would anchor to a cell the
 * pivot never builds — visible nowhere, deleted by nobody, still in the table.
 */
const DESC_META: Record<DescField, { level: string; blankKey: string; blankLabel: string }> = {
  check_description:   { level: "description",  blankKey: "(No Description)",   blankLabel: "(No Description)" },
  check_description_2: { level: "check_desc_2", blankKey: "(No Description 2)", blankLabel: "(No Description 2)" },
  check_description_3: { level: "check_desc_3", blankKey: "__no_desc3__",       blankLabel: "—" },
};

/**
 * The level below a GL cell, grouped by whichever description the reader picks.
 *
 * This is the only breakdown the server has to compute. Every level above it is
 * a level of the pivot, so the table already holds its children and hands them
 * over without a request — which is what keeps opening a cost centre exactly as
 * cheap as opening a GL.
 *
 * Below GL there is no such level: the useful split is by description, and no
 * single description serves every account. Measured on production,
 * check_description covers everything except Office Expense, where it is empty
 * on 792 of its 835 rows and the content sits in check_description_2 and _3.
 * Office Expense is the only account in the table with that shape.
 *
 * So the choice belongs to the reader — but an uninformed choice lands on a
 * blank screen that reads as a broken page. All three are grouped here and the
 * populated count travels with them, so the selector can say which is which.
 */
export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;

  // The cell is a scope, not a GL alone: the same account under two cost
  // centres is two different cells with two different breakdowns.
  const glCode     = sp.get("gl_code");
  const category6  = sp.get("category_6");
  const category7  = sp.get("category_7");
  const costCenter = sp.get("cost_center");
  const month    = sp.get("month");
  const years    = sp.getAll("year").map(Number).filter(Boolean);
  const branches = sp.getAll("branch");
  const sources  = sp.getAll("source");
  const ccIds    = sp.getAll("cost_center_id");

  if (!glCode && !category6 && !category7 && !costCenter) {
    return NextResponse.json({ error: "a cell scope is required" }, { status: 400 });
  }

  try {
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += PAGE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("pl_transactions")
        .select(
          "id,gl_code,gl_name,movement," +
          "check_description,check_description_2,check_description_3",
        )
        ;
      if (glCode)     q = q.eq("gl_code", glCode);
      if (category6)  q = q.eq("category_6", category6);
      if (category7)  q = q.eq("category_7", category7);
      // The cost centre of a row is its assignment, and "__unassigned__" /
      // "__conflict__" are states rather than ids — the same stable values the
      // pivot uses for its scope.
      if (costCenter === "__unassigned__")    q = q.is("cost_center_id", null);
      else if (costCenter === "__conflict__") q = q.eq("cost_center_status", "conflict");
      else if (costCenter)                    q = q.eq("cost_center_id", costCenter);
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

    // Grouped here rather than shipped raw: the client needs one line per
    // description, and a GL with a few thousand movements would otherwise send
    // all of them across so the browser could reduce them to a dozen rows.
    const groups = Object.fromEntries(
      DESC_FIELDS.map((f) => {
        const meta = DESC_META[f];
        const g = new Map<string, { key: string; label: string; total: number; count: number }>();
        for (const r of rows) {
          const raw = String(r[f] ?? "").trim();
          const key = raw || meta.blankKey;
          const e = g.get(key) ?? { key, label: raw || meta.blankLabel, total: 0, count: 0 };
          e.total += Number(r.movement ?? 0);
          e.count++;
          g.set(key, e);
        }
        return [f, [...g.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))];
      }),
    ) as Record<DescField, Array<{ key: string; label: string; total: number; count: number }>>;

    // How many rows each description actually has — the reason the selector can
    // be informed without choosing for the user.
    const coverage = Object.fromEntries(
      DESC_FIELDS.map((f) => [f, rows.filter((r) => String(r[f] ?? "").trim() !== "").length]),
    ) as Record<DescField, number>;

    return NextResponse.json({
      gl_code: glCode,
      gl_name: rows[0]?.gl_name ?? null,
      month,
      row_count: rows.length,
      total: rows.reduce((s, r) => s + Number(r.movement ?? 0), 0),
      levels: Object.fromEntries(DESC_FIELDS.map((f) => [f, DESC_META[f].level])),
      coverage,
      groups,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
