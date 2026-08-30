"use client";

import { useEffect, useState, type FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button, Field, Input } from "@/components/ui";

/** Only same-site paths — a full URL in ?next= would let a crafted link
 *  bounce someone to an attacker's page right after a genuine sign-in. */
function safeNext(next: string | null): string {
  return next && /^\/(?!\/)/.test(next) ? next : "/";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Statically hosted, so no server redirect: an already-signed-in visitor
  // is sent through to the app from here.
  useEffect(() => {
    void createClient()
      .auth.getUser()
      .then(({ data: { user } }) => {
        if (user) router.replace(safeNext(params.get("next")));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().auth.signInWithPassword({ email, password });

    if (error) {
      // Specific, not raw (spec §4.5): say what happened, what to do next.
      setError(
        error.message.includes("Invalid login credentials")
          ? "Email or password is wrong. Check both and try again."
          : "Could not sign in. Check the connection and try again.",
      );
      setBusy(false);
      return;
    }

    router.replace(safeNext(params.get("next")));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <div>
        <span className="text-[20px] font-bold tracking-tight">
          in<span className="text-brand-red">Style</span>
        </span>
        <p className="mt-1 text-[13px] text-text-muted">Sign in to continue</p>
      </div>

      <Field label="Email">
        <Input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
      </Field>

      <Field label="Password" error={error ?? undefined}>
        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-9"
            required
          />
          <button
            type="button"
            aria-label={showPassword ? "Hide password" : "Show password"}
            title={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted hover:text-text-body"
            onClick={() => setShowPassword((s) => !s)}
          >
            {showPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
          </button>
        </div>
      </Field>

      <Button type="submit" variant="primary" busy={busy} busyLabel="Signing in" className="w-full">
        Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page p-4">
      <div className="w-full max-w-sm rounded-[4px] border border-border bg-surface-card p-8">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
