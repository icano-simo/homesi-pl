import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser client with the anon key.
 *
 * Points at `finance_division` for consistency with the server client, but note
 * that it cannot currently read anything: only service_role was granted
 * privileges on that schema, and the base tables carry RLS with no policies.
 * That is deliberate — every data path in this app goes through an API route
 * using lib/supabase-server.ts.
 *
 * Nothing imports this today. It is kept as the entry point for any future
 * browser-side read, which would first need a GRANT and an RLS policy for
 * `anon` or `authenticated`. For authentication use lib/supabase-browser.ts,
 * whose session lives in cookies so the proxy gate can see it.
 */
export const supabase = createClient(url, anonKey, {
  db: { schema: "finance_division" },
});
