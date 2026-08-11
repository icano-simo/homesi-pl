import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const supabase = createServerClient();
  const [{ data: ccs }, { data: allocs }] = await Promise.all([
    supabase.from("cost_centers").select("*").order("name"),
    // Count distinct unified rules that allocate to each CC
    supabase.from("split_rule_allocations").select("cost_center_id,split_rule_id"),
  ]);

  const countByCC = new Map<string, Set<string>>();
  for (const a of allocs ?? []) {
    const set = countByCC.get(a.cost_center_id as string) ?? new Set<string>();
    set.add(a.split_rule_id as string);
    countByCC.set(a.cost_center_id as string, set);
  }

  return NextResponse.json(
    (ccs ?? []).map((cc) => ({ ...cc, rule_count: countByCC.get(cc.id as string)?.size ?? 0 }))
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { name, description } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("cost_centers")
    .insert({ name: name.trim(), description: description?.trim() || null })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
