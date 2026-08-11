import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client for authentication.
 *
 * Deliberately not lib/supabase.ts's plain createClient: that one keeps the
 * session in localStorage, which the server never sees. Middleware has to read
 * the session on every request to gate the app, and it only gets cookies — so
 * the auth client has to be the cookie-backed one from @supabase/ssr.
 *
 * lib/supabase.ts stays as-is for anon data reads that do not involve a session.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
