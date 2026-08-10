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
const BARE_ROUTES = ["/login", "/change-password"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) {
    return <>{children}</>;
  }

  return (
    <BranchFilterProvider>
      <Sidebar />
      <main style={{ marginLeft: "68px" }} className="h-screen overflow-y-auto p-6">
        {children}
      </main>
    </BranchFilterProvider>
  );
}
