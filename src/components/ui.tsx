"use client";

// The component vocabulary (spec §4.4, §4.5, §5).
// Two button styles. One radius. No card shadows. Skeletons match layout.

import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// Buttons — primary (ink) and secondary (bordered). There is no third style.
// Destructive = secondary with red text; confirmation happens in a modal.
// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "destructive";
  busy?: boolean;
  busyLabel?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ variant = "secondary", busy, busyLabel, disabled, children, className = "", ...rest }, ref) {
    const base =
      "inline-flex h-8 items-center justify-center gap-2 rounded-[4px] px-4 text-[13px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50";
    const styles = {
      primary: "bg-ink font-bold text-white hover:bg-black",
      secondary:
        "border border-border bg-surface-card text-text-body hover:bg-surface-page",
      destructive:
        "border border-border bg-surface-card text-brand-red hover:bg-brand-red-tint",
    }[variant];
    return (
      <button
        ref={ref}
        className={`${base} ${styles} ${className}`}
        disabled={disabled || busy}
        {...rest}
      >
        {busy ? (busyLabel ?? children) : children}
      </button>
    );
  },
);

// ---------------------------------------------------------------------------
// Card — flat, bordered, no elevation
// ---------------------------------------------------------------------------

export function Card({ title, action, children, className = "" }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[4px] border border-border bg-surface-card p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-4">
          {title && <h2 className="text-[15px] font-bold leading-tight">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen states (spec §5): every data view renders one of these four.
// ---------------------------------------------------------------------------

/** Skeleton rows matching the layout's real shape. Never a spinner on a page. */
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-hidden className="space-y-2">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="skeleton h-4"
              style={{ width: `${[30, 20, 15, 25, 10][c % 5]}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonStat() {
  return (
    <div aria-hidden className="space-y-2">
      <div className="skeleton h-3 w-24" />
      <div className="skeleton h-6 w-32" />
    </div>
  );
}

/** Empty names the action; it does not apologise. Distinguish "no data yet"
    from "no results for this filter" by passing the right message. */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="py-8 text-center">
      <p className="text-[13px] text-text-muted">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Error states what failed and offers Retry. Never a raw exception string. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-[4px] bg-brand-red-tint p-4">
      <AlertCircle size={16} className="mt-px shrink-0 text-brand-red" aria-hidden />
      <div>
        <p className="text-[13px] text-text-body">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 text-[13px] font-bold text-text-body underline underline-offset-2"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table — 32px rows, 8/16 cell padding, 11px bold headers
// ---------------------------------------------------------------------------

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full border-collapse text-[13px] ${className}`}>{children}</table>
    </div>
  );
}

const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

export function Th({ children, align = "left", className = "", sortDir, onSort }: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  /** Current sort direction when this column drives the sort; null otherwise. */
  sortDir?: SortDir | null;
  /** Makes the header clickable; wired by useSort's th() helper. */
  onSort?: () => void;
}) {
  return (
    <th
      className={`border-b border-border px-4 py-2 text-[11px] font-bold text-text-muted ${alignClass[align]} ${className}`}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={`inline-flex items-center gap-1 hover:text-text-body ${
            sortDir ? "text-text-body" : ""
          }`}
        >
          {children}
          <span aria-hidden className={sortDir ? "" : "opacity-30"}>
            {sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕"}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Column sorting. Pages define an accessor per sortable column (module-level
// or memoized, so the map identity is stable) and spread th("key") onto the
// matching <Th>. First click sorts numbers largest-first and text A-first;
// clicking again flips. Nulls always sink to the bottom.
// ---------------------------------------------------------------------------

export type SortDir = "asc" | "desc";

export function useSort<T>(
  rows: readonly T[] | null | undefined,
  accessors: Record<string, (row: T) => unknown>,
) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);

  const sorted = useMemo(() => {
    if (!rows) return null;
    if (!sort || !accessors[sort.key]) return [...rows];
    const acc = accessors[sort.key];
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = acc(a);
      const vb = acc(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [rows, sort, accessors]);

  function th(key: string) {
    return {
      sortDir: sort?.key === key ? sort.dir : null,
      onSort: () =>
        setSort((s) => {
          if (s?.key === key) {
            return { key, dir: s.dir === "asc" ? ("desc" as const) : ("asc" as const) };
          }
          const sample = rows?.map(accessors[key]).find((v) => v != null);
          return { key, dir: typeof sample === "number" ? "desc" : "asc" };
        }),
    };
  }

  return { rows: sorted, th };
}

export function Td({ children, align = "left", className = "", colSpan, title }: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={`h-8 border-b border-border px-4 py-1 align-middle ${alignClass[align]} ${className}`}
    >
      {children}
    </td>
  );
}

/** Long names truncate with a tooltip; they never break layout (edge case 5). */
export function Truncate({ text, max = 32 }: { text: string; max?: number }) {
  if (text.length <= max) return <>{text}</>;
  return <span title={text}>{text.slice(0, max - 1)}…</span>;
}

// ---------------------------------------------------------------------------
// Form fields — errors are specific and attached to the field (spec §6)
// ---------------------------------------------------------------------------

export function Field({ label, error, children, hint }: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] text-brand-red">{error}</span>}
    </label>
  );
}

const inputClass =
  "h-8 w-full rounded-[4px] border border-border bg-surface-card px-2 text-[13px] text-text-body outline-none focus:border-ink disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, className = "", ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`${inputClass} ${invalid ? "border-brand-red" : ""} ${className}`}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ invalid, className = "", children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={`${inputClass} ${invalid ? "border-brand-red" : ""} ${className}`}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ invalid, className = "", ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={`min-h-16 w-full rounded-[4px] border border-border bg-surface-card p-2 text-[13px] text-text-body outline-none focus:border-ink disabled:opacity-50 ${invalid ? "border-brand-red" : ""} ${className}`}
        {...rest}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Modal — the one surface with elevation
// ---------------------------------------------------------------------------

export function Modal({ title, open, onClose, children }: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-lg rounded-[4px] border border-border bg-surface-card p-4 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-[15px] font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat — dashboard figures
// ---------------------------------------------------------------------------

export function Stat({ label, value, sub, tone, hero }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "positive" | "warning" | "negative";
  hero?: boolean;
}) {
  const toneClass =
    tone === "positive" ? "text-data-teal"
    : tone === "warning" ? "text-data-amber"
    : tone === "negative" ? "text-brand-red"
    : "";
  return (
    <div data-stat>
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className={`${hero ? "text-[28px]" : "text-[20px]"} font-bold leading-tight ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}
