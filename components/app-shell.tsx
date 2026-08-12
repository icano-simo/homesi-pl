"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { BranchFilterProvider } from "@/components/branch-filter-provider";

/**
 * Routes rendered without the application chrome.
 *
 * Login and the forced password change are the two places a user can legally be
 * while not yet allowed into any module, so showing the sidebar there would
 * offer navigation that the middleware is about to refuse anyway.
 *
 * Kept in sync with the public/gated route lists in middleware.ts — the shell
 * decides what is *drawn*, the middleware decides what is *reachable*, and the
 * two answers have to agree.
 */
const BARE_ROUTES = ["/login", "/change-password", "/no-access"];

/** Collapsed sidebar width. Single source for the main content offset. */
const SIDEBAR_RAIL_W = 68;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) {
    return <>{children}</>;
  }

  return (
    <BranchFilterProvider>
      <Sidebar />
      {/* The sidebar is fixed and collapses to a rail, so the offset is its
          collapsed width. The 1440px cap is applied to the content inside the
          scroll container rather than to the container itself, or the reports —
          which scroll horizontally through twelve months — would be clipped
          instead of centred. */}
      <main
        style={{ marginLeft: SIDEBAR_RAIL_W }}
        className="h-screen overflow-y-auto bg-[#FCFCFA]"
      >
        <div className="mx-auto max-w-[1440px] px-6 py-4">{children}</div>
      </main>
    </BranchFilterProvider>
  );
}
