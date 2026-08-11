"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/lib/supabase-browser";

/**
 * Signed in, but this account has no access to Homesí.
 *
 * A distinct page rather than a redirect back to /login, because the two states
 * are not the same: the gate already sends anyone holding a valid session away
 * from /login and onto the landing page, so bouncing an unauthorised user there
 * would loop until the browser gave up. Saying plainly what happened, and who
 * to ask, is also more useful than pretending the sign-in failed.
 *
 * The session is left intact — it is shared with the other apps in this
 * project, and signing out here would kick the person out of those too.
 */
export default function NoAccessPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#FCFCFA] px-4 py-10">
      <div className="w-full max-w-md">
        <Image
          src="/logo-homesi.jpg"
          alt="HOMESÍ — Powered By Supreme Lending"
          width={1080}
          height={190}
          priority
          className="mx-auto mb-8 h-auto w-full max-w-[320px]"
        />

        <div className="mx-auto w-full rounded-3xl bg-white p-10 shadow-lg">
          <div className="mb-4 flex justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
              <ShieldAlert size={22} className="text-amber-500" />
            </span>
          </div>

          <h1 className="text-center text-lg font-bold text-[#001A40]">
            No tienes acceso a Homesí
          </h1>

          <p className="mt-2 text-center text-sm text-slate-500">
            Tu sesión es válida{email ? ` (${email})` : ""}, pero esta cuenta no
            está autorizada para entrar a este módulo.
          </p>

          <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center text-[12px] text-slate-600">
            Solicita acceso al administrador de Homesí. Tu sesión sigue activa
            para las demás aplicaciones del portal.
          </p>

          <button
            onClick={signOut}
            disabled={busy}
            className="mt-6 w-full rounded-full border border-slate-200 bg-white py-3 text-xs font-medium text-slate-600 transition-colors hover:border-[#001A40] disabled:opacity-50"
          >
            {busy ? "Cerrando sesión…" : "Cerrar sesión"}
          </button>
        </div>
      </div>
    </main>
  );
}
