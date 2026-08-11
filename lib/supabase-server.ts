import { createClient } from "@supabase/supabase-js";

/**
 * Server-side client with the service role key — bypasses RLS for API routes.
 *
 * Every table lives in `finance_division`, not `public`, since the migration to
 * the SimoLogic project. Setting the schema here rather than qualifying each
 * call means the 40+ API routes need no change: supabase-js turns this into the
 * Accept-Profile / Content-Profile headers PostgREST reads.
 *
 * The schema is exposed through pgrst.db_schemas on the authenticator role, and
 * only service_role holds privileges on it — which is why every data path in
 * this app goes through here and not through the browser client.
 */
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
      db: { schema: "finance_division" },
    }
  );
}
