import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string; condId: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { condId } = await params;
  const supabase = createServerClient();

  const { error } = await supabase
    .from("split_rule_conditions")
    .delete()
    .eq("id", condId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { condId } = await params;
  const supabase = createServerClient();

  const body = await req.json().catch(() => ({}));
  const allowed: Record<string, unknown> = {};
  if (typeof body.sequence === "number") allowed.sequence = body.sequence;
  if ("logic_connector" in body) allowed.logic_connector = body.logic_connector;
  if (typeof body.field === "string") allowed.field = body.field;
  if (typeof body.operator === "string") allowed.operator = body.operator;
  if (typeof body.value === "string") allowed.value = body.value;
  if (typeof body.group_number === "number") allowed.group_number = body.group_number;

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("split_rule_conditions")
    .update(allowed)
    .eq("id", condId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
