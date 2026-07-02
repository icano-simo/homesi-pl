import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/cc-allocation-splits/conflict-check?type=vendor|description3&value=...
 *
 * Returns { rule_conflict: { rule_id, rule_name } | null }
 *
 * Checks whether saving a manual split for this (type, value) pair would silently
 * override an existing split rule that captures the same vendor or description3.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type  = searchParams.get("type") as "vendor" | "description3" | null;
  const value = searchParams.get("value");

  if (!type || !value) return NextResponse.json({ rule_conflict: null });

  const supabase = createServerClient();

  // Map assign_type → the field name used in split_rule_conditions
  const condField = type === "vendor" ? "vendor" : "check_description_3";

  const { data: conditions } = await supabase
    .from("split_rule_conditions")
    .select("split_rule_id, operator, value")
    .eq("field", condField);

  if (!conditions || conditions.length === 0) return NextResponse.json({ rule_conflict: null });

  const normValue = value.trim().replace(/\s+/g, " ").toLowerCase();

  const match = (conditions as { split_rule_id: string; operator: string; value: string }[]).find((c) => {
    const cv = c.value.toLowerCase();
    switch (c.operator) {
      case "equals":      return normValue === cv;
      case "contains":    return normValue.includes(cv);
      case "starts_with": return normValue.startsWith(cv);
      case "ends_with":   return normValue.endsWith(cv);
      default:            return false;
    }
  });

  if (!match) return NextResponse.json({ rule_conflict: null });

  const { data: rule } = await supabase
    .from("split_rules")
    .select("id, name")
    .eq("id", match.split_rule_id)
    .single();

  if (!rule) return NextResponse.json({ rule_conflict: null });

  return NextResponse.json({ rule_conflict: { rule_id: rule.id, rule_name: rule.name } });
}
