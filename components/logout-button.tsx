"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase-browser";

/**
 * Sign out from the sidebar footer.
 *
 * signOut clears the Supabase session cookies, so the very next request fails
 * the middleware gate — there is no window where the app is still reachable
 * with a dead token. router.refresh() drops any server-rendered content that
 * was fetched while signed in.
 */
export function LogoutButton({ expanded }: { expanded: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      title="Sign out"
      className={[
        "flex w-full items-center rounded-xl py-2 text-sm font-medium transition-colors duration-150",
        expanded ? "gap-3 px-3" : "justify-center px-0",
        "text-slate-500 hover:bg-slate-50 hover:text-[#FF4040] disabled:opacity-40",
      ].join(" ")}
    >
      <LogOut size={16} className="shrink-0" />
      <span
        className={`whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-150 leading-tight ${
          expanded ? "max-w-xs opacity-100" : "max-w-0 opacity-0"
        }`}
      >
        {busy ? "Signing out…" : "Sign out"}
      </span>
    </button>
  );
}
