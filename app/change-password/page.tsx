"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";

const DEFAULT_LANDING = "/pl-all";
const MIN_LENGTH = 8;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();

      // The password itself is changed by the user's own session.
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }

      // The flag lives in app_metadata and only the service role can write it,
      // so releasing the gate goes through our own route. If this call fails the
      // password IS already changed — the user simply stays gated and can retry,
      // which is the safe direction to fail in.
      const res = await fetch("/api/auth/complete-password-change", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Password changed, but the account could not be unlocked. Try again.");
        return;
      }

      // The gate reads app_metadata from the token, so it needs a fresh one.
      await supabase.auth.refreshSession();
      router.replace(DEFAULT_LANDING);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.");
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
          <h1 className="text-lg font-bold text-[#001A40]">Choose a new password</h1>
          <p className="mt-1 mb-6 text-sm text-slate-500">
            Your account uses a temporary password. Set your own to continue.
          </p>

          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div>
              <label htmlFor="password" className={labelClass}>New password</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_LENGTH} characters`}
                className={inputClass}
                required
              />
            </div>

            <div>
              <label htmlFor="confirm" className={labelClass}>Confirm new password</label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputClass}
                required
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="mt-6 w-full rounded-full bg-[#FF4040] py-3.5 font-bold text-white transition-colors hover:bg-[#e03535] disabled:opacity-50"
            >
              {busy ? "Saving…" : "Set password"}
            </button>

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
