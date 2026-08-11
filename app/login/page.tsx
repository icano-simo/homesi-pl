"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";

/** Where a user lands once they are in and have nothing left to do. */
const DEFAULT_LANDING = "/pl-all";

/** This app's entry in app_metadata.allowed_apps. Must match proxy.ts. */
const APP_NAME = "homesi";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const supabase = createClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        // Supabase returns the same message for a wrong password and an unknown
        // address, which is the right call — telling them apart would let anyone
        // enumerate who has an account.
        setError("Incorrect email or password.");
        return;
      }

      // app_metadata, not user_metadata: only the service role can write it, so
      // the flag cannot be cleared from the browser to skip the change. The
      // other apps in this shared project keep it in user_metadata; Homesí
      // deliberately does not, and scripts/migrate-password-flag.mjs copies the
      // existing users' flag across.
      //
      // Someone without access to this app is sent to /no-access rather than a
      // module they cannot open — the gate would bounce them anyway.
      const app = data.user?.app_metadata ?? {};
      if (!Array.isArray(app.allowed_apps) || !app.allowed_apps.includes(APP_NAME)) {
        router.replace("/no-access");
        router.refresh();
        return;
      }

      const mustChange = app.must_change_password === true;
      router.replace(mustChange ? "/change-password" : DEFAULT_LANDING);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full border border-slate-200 rounded-xl px-4 py-3 text-sm placeholder:text-slate-400 " +
    "focus:outline-none focus:ring-2 focus:ring-[#001A40]/20";
  const labelClass = "block text-sm font-semibold text-[#001A40] mb-1";

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
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div>
              <label htmlFor="email" className={labelClass}>Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@supremelending.com"
                className={inputClass}
                required
              />
            </div>

            <div>
              <label htmlFor="password" className={labelClass}>Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                required
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="mt-6 w-full rounded-full bg-[#FF4040] py-3.5 font-bold text-white transition-colors hover:bg-[#e03535] disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign In"}
            </button>

            {/* Reserved below the button so an error never shifts the form. */}
            {error && (
              <p role="alert" className="mt-2 text-sm text-rose-600">
                {error}
              </p>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
