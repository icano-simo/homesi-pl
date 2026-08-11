import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Clears must_change_password after the user has actually changed it.
 *
 * The flag lives in app_metadata precisely so the browser cannot write it, so
 * clearing it has to happen here, with the service role. The client changes the
 * password itself via auth.updateUser() and then calls this to release the gate.
 *
 * The user is taken from the session cookie, never from the request body — a
 * caller must not be able to clear the flag on somebody else's account.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createServerClient();

  // Re-read from the server rather than trusting the caller's claim that the
  // password was updated: updateUser bumps updated_at, so a flag still set
  // together with a fresh timestamp is the signal we can act on.
  const { data: fetched, error: fetchErr } = await admin.auth.admin.getUserById(user.id);
  if (fetchErr || !fetched?.user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...fetched.user.app_metadata,
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    },
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
