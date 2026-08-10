import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";

  let query = supabase
    .from("gl_mapping")
    .select("*")
    .order("gl_code", { ascending: true });

  if (q) {
    query = query.or(
      `gl_code.ilike.%${q}%,gl_name.ilike.%${q}%,category_1.ilike.%${q}%,category_7.ilike.%${q}%`
    );
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const body = await req.json();

  const { data, error } = await supabase
    .from("gl_mapping")
    .insert(body)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data, { status: 201 });
}
