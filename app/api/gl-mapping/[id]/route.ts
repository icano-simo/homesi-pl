import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await params;
  const supabase = createServerClient();
  const body = await req.json();

  const { data, error } = await supabase
    .from("gl_mapping")
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await params;
  const supabase = createServerClient();

  const { error } = await supabase.from("gl_mapping").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return new NextResponse(null, { status: 204 });
}
