import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; patternId: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const { id, patternId } = await params;
  const { error } = await supabase
    .from("cc_description_patterns")
    .delete()
    .eq("id", patternId)
    .eq("cost_center_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
