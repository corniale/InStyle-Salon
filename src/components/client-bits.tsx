"use client";

import { Button } from "@/components/ui";

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatBirthday(month: number | null, day: number | null): string | null {
  if (month == null || day == null) return null;
  return `${MONTH_SHORT[month - 1]} ${day}`;
}

export const CLIENTS_PAGE_SIZE = 50;

export function formatClientNo(n: number | null | undefined): string {
  if (n == null) return "—";
  return `C-${String(n).padStart(6, "0")}`;
}

export function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-text-muted">—</span>;
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Active", cls: "text-data-teal" },
    at_risk: { label: "At risk", cls: "text-data-amber" },
    lapsed: { label: "Lapsed", cls: "text-brand-red" },
    never_returned: { label: "Never returned", cls: "text-text-muted" },
    unknown: { label: "—", cls: "text-text-muted" },
  };
  const m = map[status] ?? map.unknown;
  return <span className={`text-[11px] font-bold ${m.cls}`}>{m.label}</span>;
}

/** First, last and current ±2, with ellipses over the gaps. */
function pageWindow(page: number, pages: number): (number | "…")[] {
  if (pages <= 9) return Array.from({ length: pages }, (_, i) => i);
  const shown = new Set<number>([0, pages - 1]);
  for (let i = page - 2; i <= page + 2; i++) {
    if (i >= 0 && i < pages) shown.add(i);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("…");
    out.push(sorted[i]);
  }
  return out;
}

export function Pagination({ page, total, onPage, noun = "rows", pageSize = CLIENTS_PAGE_SIZE }: {
  page: number;
  total: number;
  onPage: (p: number) => void;
  noun?: string;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-[13px]">
      <span className="text-text-muted tnum">
        Page {page + 1} of {pages} · {total.toLocaleString()} {noun}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        <Button disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
        {pageWindow(page, pages).map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-text-muted" aria-hidden>…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              aria-label={`Page ${p + 1}`}
              className={`h-8 min-w-8 rounded-[4px] border px-2 text-[13px] tnum ${
                p === page
                  ? "border-ink bg-ink font-bold text-white"
                  : "border-border hover:bg-surface-page"
              }`}
            >
              {p + 1}
            </button>
          ),
        )}
        <Button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
