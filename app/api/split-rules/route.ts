import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { loadAllSplitRules } from "@/lib/reevaluate-rule-assigned";
import type { SplitRuleCondition, SplitRuleAllocation } from "@/types";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const supabase = createServerClient();
  const rules = await loadAllSplitRules(supabase);
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();

  const body = await req.json().catch(() => ({}));
  const { name, description, is_operational = true, conditions, allocations } = body as {
    name: string;
    description?: string;
    is_operational?: boolean;
    conditions: Omit<SplitRuleCondition, "id" | "split_rule_id" | "created_at">[];
    allocations: Omit<SplitRuleAllocation, "id" | "split_rule_id">[];
  };

  if (!name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!Array.isArray(allocations) || allocations.length < 1) {
    return NextResponse.json({ error: "At least one allocation is required" }, { status: 400 });
  }
  const totalPct = allocations.reduce((s, a) => s + Number(a.percentage), 0);
  if (Math.abs(totalPct - 100) > 0.01) {
    return NextResponse.json({ error: `Allocations must sum to 100% (got ${totalPct})` }, { status: 400 });
  }

  const { data: rule, error: ruleErr } = await supabase
    .from("split_rules")
    .insert({ name: name.trim(), description: description?.trim() ?? null, is_operational })
    .select()
    .single();

  if (ruleErr || !rule) {
    return NextResponse.json({ error: ruleErr?.message ?? "Insert failed" }, { status: 500 });
  }

  const ruleId = (rule as { id: string }).id;

  if (Array.isArray(conditions) && conditions.length > 0) {
    const { error: condErr } = await supabase.from("split_rule_conditions").insert(
      conditions.map((c) => ({ ...c, split_rule_id: ruleId }))
    );
    if (condErr) return NextResponse.json({ error: condErr.message }, { status: 500 });
  }

  const { error: allocErr } = await supabase.from("split_rule_allocations").insert(
    allocations.map((a) => ({ ...a, split_rule_id: ruleId }))
  );
  if (allocErr) return NextResponse.json({ error: allocErr.message }, { status: 500 });

  const rules = await loadAllSplitRules(supabase);
  return NextResponse.json(rules.find((r) => r.id === ruleId), { status: 201 });
}
