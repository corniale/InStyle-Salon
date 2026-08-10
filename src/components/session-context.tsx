"use client";

// Session-wide state: who is signed in, which branches they may see, and
// which branch view is selected. "Consolidated" (branchId null) is only
// offered to the owner; everyone else is pinned to their branch by RLS and
// the switcher simply reflects that (edge case 35 is enforced server-side).

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Branch, Profile } from "@/lib/types";

interface SessionState {
  profile: Profile;
  branches: Branch[];
  /** null = consolidated (owner only) */
  branchId: string | null;
  setBranchId: (id: string | null) => void;
  branch: Branch | null;
  isOwner: boolean;
  isManagerUp: boolean;
  canSeeAnalytics: boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ profile, branches, children }: {
  profile: Profile;
  branches: Branch[];
  children: ReactNode;
}) {
  const [branchId, setBranchId] = useState<string | null>(
    profile.role === "owner" ? null : profile.branch_id,
  );

  const value = useMemo<SessionState>(() => {
    const isOwner = profile.role === "owner";
    return {
      profile,
      branches,
      branchId,
      setBranchId: (id) => {
        // Non-owners cannot leave their branch; the UI never offers it, and
        // RLS would return nothing if it did.
        if (!isOwner && id !== profile.branch_id) return;
        setBranchId(id);
      },
      branch: branches.find((b) => b.id === branchId) ?? null,
      isOwner,
      isManagerUp: isOwner || profile.role === "manager",
      // Front desk: ticket entry, clients, expenses. No analytics (spec §3).
      canSeeAnalytics: isOwner || profile.role === "manager",
    };
  }, [profile, branches, branchId]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
