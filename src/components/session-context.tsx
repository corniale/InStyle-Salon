"use client";

// Session-wide state: who is signed in, which branches they may see, and
// which branch view is selected. "Consolidated" (branchId null) is only
// offered to the owner; everyone else is pinned to their branch by RLS and
// the switcher simply reflects that (edge case 35 is enforced server-side).

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Branch, Business, Profile } from "@/lib/types";

interface SessionState {
  profile: Profile;
  /** Businesses the signed-in user can see at least one branch of. */
  businesses: Business[];
  /** The selected business. Never null once loaded. */
  businessId: string | null;
  setBusinessId: (id: string) => void;
  business: Business | null;
  /** Branches of the selected business. */
  branches: Branch[];
  /** null = consolidated across the selected business (owner only) */
  branchId: string | null;
  setBranchId: (id: string | null) => void;
  branch: Branch | null;
  isOwner: boolean;
  /** Owner or admin — cross-branch scope, exports. */
  isAdminUp: boolean;
  isManagerUp: boolean;
  canSeeAnalytics: boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ profile, businesses, branches, children }: {
  profile: Profile;
  businesses: Business[];
  branches: Branch[];
  children: ReactNode;
}) {
  const homeBranch = branches.find((b) => b.id === profile.branch_id) ?? null;
  // Owner and admin roam every branch; manager and front desk are pinned.
  const crossBranch = profile.role === "owner" || profile.role === "admin";
  const [businessId, setBusinessIdState] = useState<string | null>(
    homeBranch?.business_id ?? businesses[0]?.id ?? null,
  );
  const [branchId, setBranchId] = useState<string | null>(
    crossBranch ? null : profile.branch_id,
  );

  const value = useMemo<SessionState>(() => {
    const isOwner = profile.role === "owner";
    const visibleBranches = branches.filter((b) => b.business_id === businessId);
    return {
      profile,
      businesses,
      businessId,
      setBusinessId: (id) => {
        // Switching business resets the branch view to consolidated; a
        // branch-pinned role stays in their own business anyway.
        if (!crossBranch && id !== homeBranch?.business_id) return;
        setBusinessIdState(id);
        setBranchId(crossBranch ? null : profile.branch_id);
      },
      business: businesses.find((b) => b.id === businessId) ?? null,
      branches: visibleBranches,
      branchId,
      setBranchId: (id) => {
        // Branch-pinned roles cannot leave their branch; the UI never offers
        // it, and RLS would return nothing if it did.
        if (!crossBranch && id !== profile.branch_id) return;
        setBranchId(id);
      },
      branch: visibleBranches.find((b) => b.id === branchId) ?? null,
      isOwner,
      isAdminUp: crossBranch,
      isManagerUp: crossBranch || profile.role === "manager",
      // Front desk: ticket entry, clients, expenses. No analytics (spec §3).
      canSeeAnalytics: crossBranch || profile.role === "manager",
    };
  }, [profile, businesses, branches, businessId, branchId, homeBranch, crossBranch]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
