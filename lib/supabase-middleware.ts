import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase client bound to the middleware request/response pair.
 *
 * The returned `response` is not optional bookkeeping: refreshing an expired
 * access token writes new cookies onto it. Discarding that response and
 * returning a fresh NextResponse would drop the refreshed token, and every
 * session would silently die about an hour after sign-in. Callers must return
 * this exact object, or copy its cookies onto whatever they return instead.
 */
export function createMiddlewareClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  return { supabase, response: () => response };
}

/**
 * Copies auth cookies from the middleware's own response onto a redirect.
 *
 * A redirect is a different response object, so without this a token refreshed
 * during the same request would be thrown away and the user would be bounced to
 * login again on their next click.
 */
export function withAuthCookies(from: NextResponse, to: NextResponse) {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}
