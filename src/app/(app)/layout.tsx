"use client";

// Client-side auth gate. The app is statically hosted (GitHub Pages), so
// there is no server to redirect from — this layout checks the session in
// the browser, loads the profile and branches, and only then renders the
// shell. The gate is a convenience; RLS is the control (spec §3): an
// unauthenticated visitor who bypasses it sees an app with no data.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SessionProvider } from "@/components/session-context";
import { Shell } from "@/components/shell";
import { ErrorState } from "@/components/ui";
import type { Branch, Profile } from "@/lib/types";

type GateState =
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: Profile; branches: Branch[] };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<GateState>({ status: "checking" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();

    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!alive) return;

      if (!user) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }

      const [profileRes, branchesRes] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).single(),
        supabase.from("branches").select("*").eq("active", true).order("code"),
      ]);

      if (!alive) return;

      if (profileRes.error || !profileRes.data?.active) {
        // No active profile: the account cannot use the app at all.
        await supabase.auth.signOut();
        router.replace("/login");
        return;
      }
      if (branchesRes.error) {
        setState({ status: "error", message: "The branch list did not load." });
        return;
      }

      setState({
        status: "ready",
        profile: profileRes.data as Profile,
        branches: (branchesRes.data ?? []) as Branch[],
      });
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  if (state.status === "checking") {
    // Matches the shell's frame so nothing jumps when the profile lands.
    return (
      <div className="flex min-h-screen">
        <div className="w-52 shrink-0 border-r border-border bg-surface-card" />
        <div className="flex-1">
          <div className="h-12 border-b border-border bg-surface-card" />
          <div className="space-y-4 p-6">
            <div className="skeleton h-5 w-40" />
            <div className="skeleton h-32 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="p-6">
        <ErrorState message={state.message} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }

  return (
    <SessionProvider profile={state.profile} branches={state.branches}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
