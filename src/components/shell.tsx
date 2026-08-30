"use client";

// App chrome: sidebar nav, branch switcher, pending-sync indicator.
// Branch accents appear in exactly three places (spec §4.1): the switcher,
// the small identity marker in the header, and dual-branch chart series.
// Consolidated has no accent — it is the absence of a branch identity.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Receipt, Users, Banknote, LineChart, UserRound,
  Settings, Scale, LogOut, Package, Menu, PanelLeftClose, PanelLeft, X,
  CalendarDays, CalendarClock,
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
    { href: "/bookings", label: "Bookings", icon: CalendarDays, show: true },
    { href: "/schedule", label: "Schedule", icon: CalendarClock, show: true },
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

  // Sidebar state: on desktop it collapses to an icon rail (remembered per
  // device); on phones it is a drawer that opens from the hamburger and
  // closes on navigation.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("nav-collapsed") === "1");
    } catch { /* private mode etc. — default expanded */ }
  }, []);
  function toggleCollapsed() {
    setCollapsed((c) => {
      try { localStorage.setItem("nav-collapsed", c ? "0" : "1"); } catch { /* ignore */ }
      return !c;
    });
  }
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const sidebarContent = (railOnly: boolean) => (
    <>
      <div className={`flex items-center py-4 ${railOnly ? "justify-center px-2" : "px-4"}`}>
        {railOnly ? (
          <span className="text-[15px] font-bold" aria-hidden>
            i<span className="text-brand-red">S</span>
          </span>
        ) : (
          <Wordmark business={business} />
        )}
      </div>

      <nav className="flex-1 space-y-1 px-2">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={`flex h-8 items-center gap-2 rounded-[4px] px-2 text-[13px] ${
                railOnly ? "justify-center" : ""
              } ${
                active
                  ? "bg-ink font-bold text-white"
                  : "text-text-body hover:bg-surface-page"
              }`}
            >
              <Icon size={16} aria-hidden className="shrink-0" />
              {!railOnly && label}
            </Link>
          );
        })}
      </nav>

      <div className={`border-t border-border ${railOnly ? "p-2 text-center" : "p-4"}`}>
        {!railOnly && (
          <>
            <div className="text-[13px]">{profile.full_name}</div>
            <div className="text-[11px] text-text-muted">
              {profile.role === "owner" ? "Owner"
                : profile.role === "admin" ? "Admin"
                : profile.role === "manager" ? "Branch manager"
                : "Front desk"}
            </div>
          </>
        )}
        <button
          onClick={signOut}
          title="Sign out"
          className={`mt-2 flex items-center gap-1 text-[11px] text-text-muted hover:text-text-body ${
            railOnly ? "mx-auto" : ""
          }`}
        >
          <LogOut size={16} aria-hidden /> {!railOnly && "Sign out"}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop / tablet sidebar: full or icon rail. */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-border bg-surface-card md:flex ${
          collapsed ? "w-14" : "w-52"
        }`}
      >
        {sidebarContent(collapsed)}
      </aside>

      {/* Phone drawer. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-60 flex-col border-r border-border bg-surface-card shadow-lg">
            <button
              aria-label="Close menu"
              className="absolute right-2 top-4 p-1 text-text-muted hover:text-text-body"
              onClick={() => setMobileOpen(false)}
            >
              <X size={18} aria-hidden />
            </button>
            {sidebarContent(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-surface-card px-3 py-1 md:px-6">
          <div className="flex items-center gap-2">
            <button
              aria-label="Open menu"
              className="p-1 text-text-muted hover:text-text-body md:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={18} aria-hidden />
            </button>
            <button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden p-1 text-text-muted hover:text-text-body md:block"
              onClick={toggleCollapsed}
            >
              {collapsed ? <PanelLeft size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
            </button>
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

        <main className="min-w-0 flex-1 p-3 md:p-6">{children}</main>
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
