import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  loadAllSplitRules,
  reevaluateRuleAssigned,
} from "@/lib/reevaluate-rule-assigned";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();
  const rules = await loadAllSplitRules(supabase);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(rule);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();

  const body = await req.json().catch(() => ({}));
  const allowed: Record<string, string | null> = {};
  if (typeof body.name === "string") allowed.name = body.name.trim() || null;
  if ("description" in body) {
    allowed.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }

  const operationalChanged = "is_operational" in body && typeof body.is_operational === "boolean";
  const extra: Record<string, boolean> = {};
  if (operationalChanged) extra.is_operational = body.is_operational as boolean;

  if ("name" in allowed && !allowed.name) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
  }
  if (Object.keys(allowed).length === 0 && Object.keys(extra).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { error } = await supabase
    .from("split_rules")
    .update({ ...allowed, ...extra, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // When is_operational changes, recompute operational_pct for all rule-assigned transactions
  if (operationalChanged) {
    const [splitRules, settingsResult] = await Promise.all([
      loadAllSplitRules(supabase),
      supabase.from("app_settings").select("active_branches").limit(1).single(),
    ]);
    const activeBranches: string[] = Array.isArray(settingsResult.data?.active_branches)
      ? settingsResult.data.active_branches
      : [];

    const txIds: string[] = [];
    let offset = 0;
    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("pl_transactions")
        .select("id")
        .in("assignment_origin", ["rule", "rule_split"])
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (activeBranches.length > 0) q = q.in("branch", activeBranches);
      const { data } = await q;
      if (!data || data.length === 0) break;
      txIds.push(...(data as { id: string }[]).map((r) => r.id));
      if (data.length < 1000) break;
      offset += 1000;
    }

    if (txIds.length > 0) {
      await reevaluateRuleAssigned(supabase, txIds, splitRules);
    }
  }

  const rules = await loadAllSplitRules(supabase);
  return NextResponse.json(rules.find((r) => r.id === id) ?? null);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = createServerClient();

  const { error } = await supabase.from("split_rules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Re-evaluate all rule-assigned transactions against the remaining rules,
  // restricted to the globally active branches from Settings
  const [splitRules, settingsResult] = await Promise.all([
    loadAllSplitRules(supabase),
    supabase.from("app_settings").select("active_branches").limit(1).single(),
  ]);
  const activeBranches: string[] = Array.isArray(settingsResult.data?.active_branches)
    ? settingsResult.data.active_branches
    : [];

  const txIds: string[] = [];
  let offset = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("id")
      .in("assignment_origin", ["rule", "rule_split"])
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (activeBranches.length > 0) q = q.in("branch", activeBranches);
    const { data } = await q;
    if (!data || data.length === 0) break;
    txIds.push(...(data as { id: string }[]).map((r) => r.id));
    if (data.length < 1000) break;
    offset += 1000;
  }

  if (txIds.length > 0) {
    await reevaluateRuleAssigned(supabase, txIds, splitRules);
  }

  return NextResponse.json({ ok: true, reevaluated: txIds.length });
}
