"use client";

// Lands here from the "Reset password" email link. The Supabase client
// exchanges the code in the URL for a session automatically; this page
// waits for that, then lets the person set a new password. An expired
// or reused link shows a way back to request a fresh one.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button, Field, Input } from "@/components/ui";

type Stage = "checking" | "form" | "done" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // An expired or already-used link arrives as error params, not a code.
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    if (url.searchParams.get("error") || hashParams.get("error")) {
      setStage("invalid");
      return;
    }
    const supabase = createClient();
    const settle = () => setStage((s) => (s === "checking" ? "form" : s));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) settle();
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) settle();
    });
    // The code exchange is asynchronous; if no session appears, the link
    // did not carry a usable code.
    const timer = setTimeout(
      () => setStage((s) => (s === "checking" ? "invalid" : s)),
      5000,
    );
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    const { error: err } = await createClient().auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(/different from the old/i.test(err.message)
        ? "That is already the current password — pick a new one."
        : "The password was not changed. Try again.");
      return;
    }
    setStage("done");
    setTimeout(() => router.replace("/"), 1500);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page p-4">
      <div className="w-full max-w-sm rounded-[4px] border border-border bg-surface-card p-8">
        <div className="mb-4">
          <span className="text-[20px] font-bold tracking-tight">
            in<span className="text-brand-red">Style</span>
          </span>
          <p className="mt-1 text-[13px] text-text-muted">Set a new password</p>
        </div>

        {stage === "checking" && (
          <p className="text-[13px] text-text-muted">Checking the reset link…</p>
        )}

        {stage === "invalid" && (
          <div className="space-y-3 text-[13px]">
            <p>
              This reset link is expired or was already used. Request a fresh
              one from the sign-in page.
            </p>
            <Button className="w-full" onClick={() => router.replace("/login")}>
              Back to sign in
            </Button>
          </div>
        )}

        {stage === "done" && (
          <p className="text-[13px]">Password changed — signing you in…</p>
        )}

        {stage === "form" && (
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="New password" hint="At least 8 characters">
              <div className="relative">
                <Input
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-9"
                  required
                  autoFocus
                />
                <button
                  type="button"
                  aria-label={show ? "Hide password" : "Show password"}
                  title={show ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted hover:text-text-body"
                  onClick={() => setShow((s) => !s)}
                >
                  {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                </button>
              </div>
            </Field>
            <Field label="Repeat it" error={error ?? undefined}>
              <Input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" variant="primary" busy={busy}
              busyLabel="Saving" className="w-full">
              Change password
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
