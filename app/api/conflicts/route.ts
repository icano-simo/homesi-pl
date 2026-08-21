import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { ConflictGroup } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;
  const branches = sp.getAll("branch");
  const months = sp.getAll("month");
  const years = sp.getAll("year").map(Number).filter((n) => !isNaN(n));
  /** Just the number, for the roadmap. Same predicate, no payload. */
  const countOnly = sp.get("count") === "1";

  /** What counts as a conflict, in one place — see the note in
   *  cost-center-assignment/unassigned: one definition, read twice. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => {
    q = q.eq("cost_center_status", "conflict");
    if (branches.length > 0) q = q.in("branch", branches);
    if (months.length > 0)   q = q.in("month", months);
    if (years.length > 0)    q = q.in("year", years);
    return q;
  };

  if (countOnly) {
    const { count, error } = await scoped(
      supabase.from("pl_transactions").select("id", { count: "exact", head: true }),
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ count: count ?? 0 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = scoped(
    supabase.from("pl_transactions").select(
      "id,gl_code,gl_name,month,year,branch,check_description,check_description_2," +
      "check_description_3,vendor,debit,credit,movement,cost_center_conflicts,conflict_type"
    ),
  ).order("gl_code", { nullsFirst: false });

  const { data: txs, error: txErr } = await q;
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  // Collect all unique rule IDs referenced in conflict arrays
  const ruleIds = new Set<string>();
  for (const tx of txs ?? []) {
    for (const id of (tx.cost_center_conflicts ?? []) as string[]) {
      ruleIds.add(id);
    }
  }

  const ruleNameMap = new Map<string, string>();
  const ruleAllocMap = new Map<string, Array<{ cost_center_id: string; percentage: number }>>();
  const ccNameMap = new Map<string, string>();

  if (ruleIds.size > 0) {
    const ids = [...ruleIds];
    const [{ data: rules }, { data: allocs }, { data: ccs }] = await Promise.all([
      supabase.from("split_rules").select("id,name").in("id", ids),
      supabase
        .from("split_rule_allocations")
        .select("split_rule_id,cost_center_id,percentage,display_order")
        .in("split_rule_id", ids)
        .order("display_order"),
      supabase.from("cost_centers").select("id,name"),
    ]);

    for (const r of rules ?? []) ruleNameMap.set(r.id as string, r.name as string);
    for (const a of allocs ?? []) {
      const arr = ruleAllocMap.get(a.split_rule_id as string) ?? [];
      arr.push({ cost_center_id: a.cost_center_id as string, percentage: a.percentage as number });
      ruleAllocMap.set(a.split_rule_id as string, arr);
    }
    for (const c of ccs ?? []) ccNameMap.set(c.id as string, c.name as string);
  }

  const groupMap = new Map<string, ConflictGroup>();

  for (const tx of txs ?? []) {
    const key = tx.gl_code ?? "(No GL Code)";
    if (!groupMap.has(key)) {
      groupMap.set(key, { gl_code: key, gl_name: tx.gl_name ?? "", transactions: [] });
    }

    const ruleIdList = (tx.cost_center_conflicts ?? []) as string[];
    const matchedRules = ruleIdList.map((ruleId) => {
      const allocs = ruleAllocMap.get(ruleId) ?? [];
      const rulePct = allocs.reduce((s, a) => s + a.percentage, 0);
      return {
        rule_id: ruleId,
        rule_name: ruleNameMap.get(ruleId) ?? "(deleted rule)",
        allocations: allocs.map((a) => ({
          cost_center_id: a.cost_center_id,
          cc_name: ccNameMap.get(a.cost_center_id) ?? "(deleted CC)",
          percentage: a.percentage,
        })),
        rule_total_percentage: rulePct,
      };
    });

    const totalPct = matchedRules.reduce((s, r) => s + r.rule_total_percentage, 0);

    groupMap.get(key)!.transactions.push({
      id: tx.id,
      gl_code: tx.gl_code,
      gl_name: tx.gl_name,
      month: tx.month,
      year: tx.year,
      branch: tx.branch,
      check_description: tx.check_description,
      check_description_2: tx.check_description_2,
      check_description_3: tx.check_description_3,
      vendor: tx.vendor,
      debit: tx.debit,
      credit: tx.credit,
      movement: tx.movement,
      conflict_type: (tx.conflict_type as "underassigned" | "overassigned") ?? "underassigned",
      total_matched_percentage: totalPct,
      matched_rules: matchedRules,
    });
  }

  return NextResponse.json([...groupMap.values()]);
}
