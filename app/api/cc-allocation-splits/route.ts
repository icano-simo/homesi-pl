import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const CHUNK = 500;

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

/**
 * GET — all splits (no params) OR splits for one key (?type=&value=).
 *
 * Normalizes `value` for vendor type so whitespace-variant assign_values are found.
 * When ?include_rule=true and no manual splits found, falls back to the matching
 * split rule's allocations (so SplitEditor pre-populates rule-assigned rows).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type         = searchParams.get("type");
  const rawValue     = searchParams.get("value");
  const includeRule  = searchParams.get("include_rule") === "true";

  const supabase = createServerClient();

  // "All splits" fetch (no type/value params) — paginate to bypass the
  // Supabase PostgREST 1000-row default limit (table has 1900+ rows).
  if (!(type && rawValue !== null)) {
    const PAGE_SIZE = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allData: any[] = [];
    let offset = 0;
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from("cc_allocation_splits")
        .select("id,assign_type,assign_value,cost_center_id,percentage,is_operational,cost_centers(name)")
        .order("percentage", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });
      if (!page || page.length === 0) break;
      allData.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return NextResponse.json(allData);
  }

  // Single-key lookup (type + value provided) — always small, no pagination needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("cc_allocation_splits")
    .select("id,assign_type,assign_value,cost_center_id,percentage,is_operational,cost_centers(name)")
    .order("percentage", { ascending: false });

  const normValueKey = norm(rawValue!);
  q = q.eq("assign_type", type);
  if (normValueKey !== rawValue) {
    q = q.in("assign_value", [rawValue, normValueKey]);
  } else {
    q = q.eq("assign_value", rawValue);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If nothing found and caller wants a rule fallback, look for a matching split rule
  if (includeRule && (!data || data.length === 0) && type && rawValue !== null) {
    const normValue = norm(rawValue);
    const conditionField = type === "vendor" ? "vendor" : "check_description_3";
    const lookupValues = normValue !== rawValue ? [rawValue, normValue] : [rawValue];

    const { data: condRows } = await supabase
      .from("split_rule_conditions")
      .select("split_rule_id")
      .eq("field", conditionField)
      .eq("operator", "equals")
      .in("value", lookupValues);

    if (condRows && condRows.length > 0) {
      const ruleId = (condRows as { split_rule_id: string }[])[0].split_rule_id;

      const { data: allocRows } = await supabase
        .from("split_rule_allocations")
        .select("cost_center_id,percentage,cost_centers(name)")
        .eq("split_rule_id", ruleId)
        .order("display_order");

      if (allocRows && allocRows.length > 0) {
        return NextResponse.json(
          (allocRows as { cost_center_id: string; percentage: number; cost_centers: unknown }[])
            .map((a) => ({
              assign_type:    type,
              assign_value:   rawValue,
              cost_center_id: a.cost_center_id,
              percentage:     a.percentage,
              is_operational: true,
              cost_centers:   a.cost_centers,
            }))
        );
      }
    }
  }

  return NextResponse.json(data ?? []);
}

/**
 * PUT — upsert the full allocation split for one (assign_type, assign_value) key.
 * Body: { assign_type, assign_value, splits: [{cost_center_id, percentage, is_operational?}] }
 *
 * Normalizes assign_value for vendor type so whitespace variants converge to a single key.
 * Matches transactions using both raw and normalized vendor names.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json() as {
    assign_type: "vendor" | "description3";
    assign_value: string;
    splits: { cost_center_id: string; percentage: number; is_operational?: boolean }[];
  };

  const { assign_type, splits } = body;
  const rawAssignValue = body.assign_value;

  if (!assign_type || !rawAssignValue || !Array.isArray(splits) || splits.length === 0) {
    return NextResponse.json({ error: "assign_type, assign_value, and splits are required" }, { status: 400 });
  }

  const total = splits.reduce((s, r) => s + r.percentage, 0);
  if (Math.abs(total - 100) > 0.01) {
    return NextResponse.json({ error: `Percentages must sum to 100 (currently ${total.toFixed(3)})` }, { status: 400 });
  }

  // Normalize assign_value for vendor type so future lookups are consistent
  const assign_value = assign_type === "vendor" ? norm(rawAssignValue) : rawAssignValue;

  const supabase = createServerClient();

  // 1. Replace splits for this key — delete old rows with EITHER the raw or normalized value
  const deleteValues = assign_type === "vendor" && assign_value !== rawAssignValue
    ? [rawAssignValue, assign_value]
    : [assign_value];

  for (const dv of deleteValues) {
    const { error: delErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", assign_type)
      .eq("assign_value", dv);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  const { error: insErr } = await supabase.from("cc_allocation_splits").insert(
    splits.map((s) => ({
      assign_type,
      assign_value,        // normalized
      cost_center_id:  s.cost_center_id,
      percentage:      s.percentage,
      is_operational:  s.is_operational ?? true,
    }))
  );
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 2. Determine primary CC (highest %) and compute operational_pct
  const primaryCcId = [...splits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
  const operationalPct = splits.reduce((s, r) => s + ((r.is_operational ?? true) ? r.percentage : 0), 0);

  // 3. Find matching transaction IDs — for vendor type, try both raw and normalized names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txQ: any = supabase.from("pl_transactions").select("id");
  if (assign_type === "vendor") {
    const vendorLookup = assign_value !== rawAssignValue
      ? [rawAssignValue, assign_value]
      : [assign_value];
    txQ = txQ.in("vendor", vendorLookup);
  } else {
    // description3 — only OA source
    txQ = txQ.eq("source", "offshore_allocations").eq("check_description_3", assign_value);
  }

  const { data: txRows, error: txErr } = await txQ;
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  const txIds: string[] = (txRows ?? []).map((r: { id: string }) => r.id);

  // 4. Update pl_transactions with primary CC and operational_pct
  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        primaryCcId,
          cost_center_status:    "assigned",
          cost_center_conflicts: null,
          assignment_origin:     "manual",
          operational_pct:       operationalPct,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ saved: splits.length, tx_updated: txIds.length });
}

/**
 * DELETE — remove all splits for one (assign_type, assign_value) key
 * and reset matching pl_transactions back to unassigned.
 * Query params: ?type=vendor|description3&value=...
 */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const assign_type  = searchParams.get("type")  as "vendor" | "description3" | null;
  const rawValue     = searchParams.get("value");

  if (!assign_type || !rawValue) {
    return NextResponse.json({ error: "type and value query params are required" }, { status: 400 });
  }

  // Normalize for vendor type (matches what PUT saves)
  const assign_value = assign_type === "vendor" ? norm(rawValue) : rawValue;

  const supabase = createServerClient();

  // 1. Delete split rows for both raw and normalized values
  const deleteValues = assign_type === "vendor" && assign_value !== rawValue
    ? [rawValue, assign_value]
    : [assign_value];

  for (const dv of deleteValues) {
    const { error: delErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", assign_type)
      .eq("assign_value", dv);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // 2. Find matching transactions (raw + normalized)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txQ: any = supabase.from("pl_transactions").select("id");
  if (assign_type === "vendor") {
    const vendorLookup = assign_value !== rawValue ? [rawValue, assign_value] : [assign_value];
    txQ = txQ.in("vendor", vendorLookup);
  } else {
    txQ = txQ.eq("source", "offshore_allocations").eq("check_description_3", assign_value);
  }
  const { data: txRows, error: txErr } = await txQ;
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  const txIds: string[] = (txRows ?? []).map((r: { id: string }) => r.id);

  // 3. Reset to unassigned in chunks
  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        null,
          cost_center_status:    "unassigned",
          cost_center_conflicts: null,
          assignment_origin:     null,
          operational_pct:       100,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ deleted: true, tx_reset: txIds.length });
}
