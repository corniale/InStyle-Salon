"use client";

// Shared period filter: Today · This month · Year to date, plus either a
// single-date picker (Dashboard, Daily cash) or a from/to pair (Technicians),
// and optionally the past-months dropdown. Every analytics-style page uses
// this same control so the filters read identically everywhere.

import { Input } from "@/components/ui";

export interface Period {
  kind: "today" | "month" | "ytd" | "day" | "pastmonth" | "range";
  from: string; // inclusive ISO date
  to: string;   // inclusive ISO date
}

export function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export function monthStartISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function yearStartISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function monthEndISO(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export function periodPreset(kind: "today" | "month" | "ytd"): Period {
  const to = todayISO();
  return {
    kind,
    from: kind === "today" ? to : kind === "month" ? monthStartISO() : yearStartISO(),
    to,
  };
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The 12 months before the current one, newest first: [["2026-07", "Jul 2026"], …] */
function pastMonths(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const d = new Date();
  for (let i = 1; i <= 12; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push([
      `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`,
      `${MONTH_LABELS[m.getMonth()]} ${m.getFullYear()}`,
    ]);
  }
  return out;
}

export function PeriodPicker({ value, onChange, withPastMonths, withRange }: {
  value: Period;
  onChange: (p: Period) => void;
  /** Adds the "Past month…" dropdown (Dashboard). */
  withPastMonths?: boolean;
  /** From/to inputs instead of a single-date input (Technicians). */
  withRange?: boolean;
}) {
  const presets: Array<["today" | "month" | "ytd", string]> = [
    ["today", "Today"], ["month", "This month"], ["ytd", "Year to date"],
  ];
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="flex rounded-[4px] border border-border">
        {presets.map(([k, label]) => (
          <button
            key={k}
            onClick={() => onChange(periodPreset(k))}
            className={`h-8 px-3 text-[13px] ${
              value.kind === k ? "bg-ink font-bold text-white" : "hover:bg-surface-page"
            }`}
          >
            {label}
          </button>
        ))}
        {withPastMonths && (
          <select
            aria-label="Past month"
            value={value.kind === "pastmonth" ? value.from.slice(0, 7) : ""}
            onChange={(e) => {
              const ym = e.target.value;
              if (ym) onChange({ kind: "pastmonth", from: `${ym}-01`, to: monthEndISO(ym) });
            }}
            className={`h-8 border-l border-border px-2 text-[13px] outline-none ${
              value.kind === "pastmonth"
                ? "bg-ink font-bold text-white"
                : "bg-surface-card text-text-body"
            }`}
          >
            <option value="">Past month…</option>
            {pastMonths().map(([ym, label]) => (
              <option key={ym} value={ym}>{label}</option>
            ))}
          </select>
        )}
      </div>

      {withRange ? (
        <div className="flex items-center gap-2">
          <Input type="date" value={value.from} className="w-40" aria-label="From"
            onChange={(e) => {
              const from = e.target.value;
              if (from) onChange({ kind: "range", from, to: value.to < from ? from : value.to });
            }} />
          <span className="text-[13px] text-text-muted">to</span>
          <Input type="date" value={value.to} className="w-40" aria-label="To"
            onChange={(e) => {
              const to = e.target.value;
              if (to) onChange({ kind: "range", from: value.from > to ? to : value.from, to });
            }} />
        </div>
      ) : (
        <Input
          type="date"
          value={value.kind === "day" ? value.from : ""}
          max={todayISO()}
          className="w-40"
          aria-label="Date"
          onChange={(e) => {
            const d = e.target.value;
            if (d) onChange({ kind: "day", from: d, to: d });
          }}
        />
      )}
    </div>
  );
}
