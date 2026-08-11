import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

/**
 * Session verification for API routes.
 *
 * The middleware already rejects unauthenticated calls to /api/*, so this is
 * defence in depth rather than the only lock: a future change to the matcher,
 * or a route reached by a path the matcher does not cover, would otherwise
 * leave a write endpoint open. Every route that mutates data calls this first.
 *
 * Reads the session from cookies with the anon key — never the service role.
 * The service-role client in lib/supabase-server.ts bypasses RLS and has no
 * concept of "who is calling", which is exactly why it must not be the thing
 * answering that question.
 */
async function readSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // API routes do not refresh tokens; the middleware owns that. Writing
        // cookies from here would fight it, so this is intentionally a no-op.
        setAll() {},
      },
    },
  );
}

/** The signed-in user, or null. Validated against Supabase, not just decoded. */
export async function getSessionUser(): Promise<User | null> {
  try {
    const supabase = await readSessionClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Guard for a mutating route. Returns a 401 response to return as-is, or the
 * user when the call is legitimate:
 *
 *   const guard = await requireSession();
 *   if (guard.response) return guard.response;
 */
export async function requireSession(): Promise<
  { response: NextResponse; user: null } | { response: null; user: User }
> {
  const user = await getSessionUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
      user: null,
    };
  }
  return { response: null, user };
}
