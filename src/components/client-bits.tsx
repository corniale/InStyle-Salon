"use client";

import { Button } from "@/components/ui";

export const CLIENTS_PAGE_SIZE = 50;

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
    <div className="mt-4 flex items-center justify-between text-[13px]">
      <span className="text-text-muted tnum">
        Page {page + 1} of {pages} · {total.toLocaleString()} {noun}
      </span>
      <div className="flex gap-2">
        <Button disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
