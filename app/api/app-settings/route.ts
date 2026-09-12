import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The branch filter, which belongs to one person.
 *
 * ─── WHY THIS STOPPED BEING GLOBAL ─────────────────────────────────────────
 * It used to be a single row, id='global', shared by all 28 accounts. Whoever
 * changed the filter changed it for everyone, live, and nobody could tell that
 * the figure in front of them answered somebody else's question. 17 of the 28
 * signed in during the last 30 days and 5 on the same day the row was last
 * touched, so this was happening, not merely possible.
 *
 * And it did not stop at the screen. A note carries the branch it was written
 * under: someone could write a note believing it was about 716 while another
 * person had moved the filter to 700, and the note would be anchored to the
 * wrong branch with nothing afterwards able to show it. 17 of the 21 notes
 * carry a branch in their scope.
 *
 * The user id comes from requireSession and NEVER from the request. A
 * preference the caller can address by id is a preference anyone can read or
 * overwrite by guessing one.
 */

/** The seed for an account that has never set one. Not a live fallback. */
async function globalDefault(
  supabase: ReturnType<typeof createServerClient>,
): Promise<string[]> {
  const { data } = await supabase
    .from("app_settings")
    .select("active_branches")
    .eq("id", "global")
    .maybeSingle();
  return data?.active_branches ?? [];
}

export async function GET() {
  // The GET needs the session too, which it never used to: it returned the same
  // row to everyone, so it had nothing to ask. Now the answer depends on who is
  // asking, and an unidentified caller has no answer rather than a default one.
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("user_settings")
    .select("active_branches")
    .eq("user_id", guard.user.id)
    .maybeSingle();

  // No row means an account created after the migration seeded everyone, so it
  // starts from the global default — read, not copied. It becomes theirs the
  // first time they save.
  if (error || !data) {
    return NextResponse.json({
      active_branches: await globalDefault(supabase),
      /** So the screen can say the filter is inherited rather than chosen. */
      from_default: true,
    });
  }
  return NextResponse.json({ active_branches: data.active_branches ?? [], from_default: false });
}

export async function PUT(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const body = await req.json().catch(() => ({}));
  const active_branches: string[] = Array.isArray(body.active_branches) ? body.active_branches : [];

  const supabase = createServerClient();
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: guard.user.id, active_branches, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
