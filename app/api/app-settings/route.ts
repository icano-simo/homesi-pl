import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("app_settings")
    .select("active_branches")
    .eq("id", "global")
    .maybeSingle();
  if (error) return NextResponse.json({ active_branches: [] });
  return NextResponse.json({ active_branches: data?.active_branches ?? [] });
}

export async function PUT(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const body = await req.json().catch(() => ({}));
  const active_branches: string[] = Array.isArray(body.active_branches) ? body.active_branches : [];
  const supabase = createServerClient();
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { id: "global", active_branches, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
