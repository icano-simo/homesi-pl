import { NextResponse, type NextRequest } from "next/server";
import { createMiddlewareClient, withAuthCookies } from "@/lib/supabase-middleware";

/**
 * Global authentication gate.
 *
 * Every route in the app passes through here, so pages are protected by
 * existing rather than by remembering to add a guard. Adding a new module needs
 * no change to this file; forgetting to protect it is not possible.
 *
 * Lives in proxy.ts rather than middleware.ts: Next 16 renamed the convention
 * and warns on the old filename. Same execution point, same semantics.
 */

/**
 * This app's entry in app_metadata.allowed_apps.
 *
 * The Supabase project is shared with the other portal apps, so a valid session
 * only proves the person works here — not that they may open Homesí. Access is
 * granted per app, in app_metadata so that only the service role can write it.
 */
const APP_NAME = "homesi";

/** Reachable without a session. Everything else requires one. */
const PUBLIC_ROUTES = ["/login"];

/**
 * Reachable with a session that lacks access to this app. Exempt from the
 * access check itself, or the redirect would chase its own tail.
 */
const NO_ACCESS_ROUTES = ["/no-access"];

/**
 * Reachable with a session that still owes a password change. Kept separate
 * from PUBLIC_ROUTES because these do require authentication — they are just
 * exempt from the must-change-password redirect that would otherwise loop.
 */
const PASSWORD_CHANGE_ROUTES = ["/change-password", "/api/auth/complete-password-change"];

/** Signed-out landing, and where a completed sign-in goes. */
const LOGIN_PATH = "/login";
const DEFAULT_LANDING = "/pl-all";

const matches = (pathname: string, routes: string[]) =>
  routes.some((r) => pathname === r || pathname.startsWith(r + "/"));

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { supabase, response } = createMiddlewareClient(request);

  // getUser, not getSession: getSession trusts the cookie as-is, while getUser
  // validates it against Supabase. A gate that trusts an unverified cookie is
  // not a gate.
  const { data: { user } } = await supabase.auth.getUser();

  const isApi = pathname.startsWith("/api/");
  const isPublic = matches(pathname, PUBLIC_ROUTES);
  const isPasswordChange = matches(pathname, PASSWORD_CHANGE_ROUTES);
  const isNoAccess = matches(pathname, NO_ACCESS_ROUTES);

  // ── Not signed in ────────────────────────────────────────────────────────
  if (!user) {
    if (isPublic) return response();

    // API calls get a 401 rather than a redirect: a fetch that receives the
    // login page as HTML fails in a confusing way, usually as a JSON parse
    // error far from the real cause.
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
      );
    }

    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = "";
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // ── Signed in, but is this person allowed into Homesí at all? ────────────
  // Checked before the password rule on purpose: making someone set a new
  // password for an app they cannot open would be pointless busywork.
  const allowedApps = user.app_metadata?.allowed_apps;
  const hasAccess = Array.isArray(allowedApps) && allowedApps.includes(APP_NAME);

  if (!hasAccess && !isNoAccess) {
    // 403, not 401: the caller proved who they are, they simply lack the
    // permission. A 401 would suggest signing in again would help.
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: "No access to this application" }, { status: 403 }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/no-access";
    url.search = "";
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // Someone who does have access should never sit on /no-access.
  if (hasAccess && isNoAccess) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_LANDING;
    url.search = "";
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // ── Signed in but still on a temporary password ──────────────────────────
  // The flag lives in app_metadata, which only the service role can write, so a
  // user cannot clear it from the browser to skip the change.
  const mustChangePassword = user.app_metadata?.must_change_password === true;

  if (mustChangePassword && !isPasswordChange) {
    if (isApi) {
      return withAuthCookies(
        response(),
        NextResponse.json({ error: "Password change required" }, { status: 403 }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/change-password";
    url.search = "";
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  // ── Signed in and settled ────────────────────────────────────────────────
  if (isPublic || (isPasswordChange && !mustChangePassword && !isApi)) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_LANDING;
    url.search = "";
    return withAuthCookies(response(), NextResponse.redirect(url));
  }

  return response();
}

export const config = {
  // Everything except static assets. Listing exclusions rather than inclusions
  // means a new route is gated the moment it exists.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo-|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
