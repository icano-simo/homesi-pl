import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const supabase = createServerClient();
  const { id } = await params;
  const { data, error } = await supabase
    .from("cc_description_patterns")
    .select("id,pattern,gl_code,created_at")
    .eq("cost_center_id", id)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const { id } = await params;
  const body = await req.json();
  const pattern = (body.pattern as string | undefined)?.trim();
  const gl_code = (body.gl_code as string | undefined)?.trim() || null;
  if (!pattern) return NextResponse.json({ error: "pattern required" }, { status: 400 });
  const { data, error } = await supabase
    .from("cc_description_patterns")
    .insert({ cost_center_id: id, pattern, gl_code })
    .select("id,pattern,gl_code")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
