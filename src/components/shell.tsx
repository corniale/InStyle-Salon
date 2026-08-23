"use client";

// App chrome: sidebar nav, branch switcher, pending-sync indicator.
// Branch accents appear in exactly three places (spec §4.1): the switcher,
// the small identity marker in the header, and dual-branch chart series.
// Consolidated has no accent — it is the absence of a branch identity.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Receipt, Users, Banknote, LineChart, UserRound,
  Settings, Scale, LogOut, Package,
} from "lucide-react";
import { useSession } from "@/components/session-context";
import { Wordmark } from "@/components/wordmark";
import { usePendingSyncCount } from "@/lib/offline/use-pending-sync";
import { createClient } from "@/lib/supabase/client";

const accentColor: Record<string, string> = {
  slate: "var(--color-data-slate)",
  plum: "var(--color-data-plum)",
};

export function Shell({ children }: { children: React.ReactNode }) {
  const {
    profile, businesses, businessId, setBusinessId, business,
    branches, branchId, setBranchId, branch, isOwner, canSeeAnalytics,
  } = useSession();
  const pathname = usePathname();
  const pending = usePendingSyncCount();

  const nav = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, show: canSeeAnalytics },
    { href: "/tickets", label: "Tickets", icon: Receipt, show: true },
    { href: "/clients", label: "Clients", icon: Users, show: true },
    { href: "/cash", label: "Daily cash", icon: Banknote, show: true },
    { href: "/inventory", label: "Inventory", icon: Package, show: true },
    { href: "/analytics", label: "Analytics", icon: LineChart, show: canSeeAnalytics },
    { href: "/technicians", label: "Technicians", icon: UserRound, show: canSeeAnalytics },
    { href: "/compare", label: "Branch comparison", icon: Scale, show: canSeeAnalytics },
    { href: "/settings", label: "Settings", icon: Settings, show: isOwner },
  ].filter((n) => n.show);

  async function signOut() {
    await createClient().auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-surface-card">
        <div className="flex items-center px-4 py-4">
          <Wordmark business={business} />
        </div>

        <nav className="flex-1 space-y-1 px-2">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex h-8 items-center gap-2 rounded-[4px] px-2 text-[13px] ${
                  active
                    ? "bg-ink font-bold text-white"
                    : "text-text-body hover:bg-surface-page"
                }`}
              >
                <Icon size={16} aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-4">
          <div className="text-[13px]">{profile.full_name}</div>
          <div className="text-[11px] text-text-muted">
            {profile.role === "owner" ? "Owner"
              : profile.role === "manager" ? "Branch manager"
              : "Front desk"}
          </div>
          <button
            onClick={signOut}
            className="mt-2 flex items-center gap-1 text-[11px] text-text-muted hover:text-text-body"
          >
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between gap-4 border-b border-border bg-surface-card px-6">
          <div className="flex items-center gap-2">
            {/* Branch identity marker (accent use 2 of 3). */}
            {branch ? (
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: accentColor[branch.accent] }}
              />
            ) : (
              <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-ink" />
            )}
            <span className="text-[13px] text-text-muted">
              {businesses.length > 1 && business ? `${business.name} · ` : ""}
              {branch ? branch.name : "All branches"}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Business picker appears only once a second business exists. */}
            {businesses.length > 1 && (
              <select
                aria-label="Business"
                value={businessId ?? ""}
                onChange={(e) => setBusinessId(e.target.value)}
                className="h-8 rounded-[4px] border border-border bg-surface-card px-2 text-[13px]"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}
            {pending > 0 && (
              <span
                className="rounded-[4px] bg-brand-red-tint px-2 py-1 text-[11px] text-brand-red-deep"
                title="Tickets recorded on this device and not yet synced"
              >
                {pending} pending sync
              </span>
            )}

            {/* Branch switcher (accent use 1 of 3). */}
            <div className="flex items-center rounded-[4px] border border-border">
              {isOwner && (
                <SwitcherButton
                  label="All"
                  active={branchId === null}
                  onClick={() => setBranchId(null)}
                />
              )}
              {branches.map((b) => (
                <SwitcherButton
                  key={b.id}
                  label={b.name}
                  accent={accentColor[b.accent]}
                  active={branchId === b.id}
                  onClick={() => setBranchId(b.id)}
                  disabled={!isOwner && b.id !== profile.branch_id}
                />
              ))}
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function SwitcherButton({ label, accent, active, onClick, disabled }: {
  label: string;
  accent?: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 items-center gap-2 px-4 text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-ink font-bold text-white" : "text-text-body hover:bg-surface-page"
      }`}
    >
      {accent && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: active ? "white" : accent }}
        />
      )}
      {label}
    </button>
  );
}
