"use client";

// Branch scope for per-branch operational pages (Bookings, Schedule,
// Settings → Costing). The header's global Main/Branch switcher drives
// these pages directly — a page-local dropdown appears only while the
// header shows "All", because a per-branch view still needs exactly one
// branch. This replaces the old pattern of snapshotting branchId into
// local state, which silently ignored the header switcher afterwards.

import { useState, type ReactNode } from "react";
import { useSession } from "@/components/session-context";
import { Select } from "@/components/ui";

export function useBranchScope(): { branch: string; picker: ReactNode } {
  const { branches, branchId } = useSession();
  const [local, setLocal] = useState(branches[0]?.id ?? "");
  const picker = branchId == null && branches.length > 1 ? (
    <Select value={local} className="w-36" aria-label="Branch"
      onChange={(e) => setLocal(e.target.value)}>
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </Select>
  ) : null;
  return { branch: branchId ?? local, picker };
}
