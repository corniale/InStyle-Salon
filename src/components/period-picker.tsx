"use client";

// Shared period filter: Today · This month · Year to date (optionally All
// time and the past-months dropdown), plus a from/to pair on every page —
// a single day is simply from = to. Every date-filtered page uses this same
// control so the filters read identically everywhere.

import { DateInput } from "@/components/date-input";

export interface Period {
  kind: "today" | "month" | "ytd" | "pastmonth" | "range" | "all";
  from: string; // inclusive ISO date; "" = no lower bound (only with "all")
  to: string;   // inclusive ISO date; "" = no upper bound (only with "all")
}

export const ALL_TIME: Period = { kind: "all", from: "", to: "" };

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

export function PeriodPicker({ value, onChange, withPastMonths, withAll }: {
  value: Period;
  onChange: (p: Period) => void;
  /** Adds the "Past month…" dropdown (Dashboard). */
  withPastMonths?: boolean;
  /** Adds an "All time" preset; either bound may then stay open. */
  withAll?: boolean;
}) {
  const presets: Array<["today" | "month" | "ytd", string]> = [
    ["today", "Today"], ["month", "This month"], ["ytd", "Year to date"],
  ];
  const today = todayISO();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="flex rounded-[4px] border border-border">
        {withAll && (
          <button
            onClick={() => onChange(ALL_TIME)}
            className={`h-8 px-3 text-[13px] ${
              value.kind === "all" ? "bg-ink font-bold text-white" : "hover:bg-surface-page"
            }`}
          >
            All time
          </button>
        )}
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

      {/* From/to on every page. While a single day is shown (Today, or
          from = to), changing "from" moves the whole view to that day — the
          old single-date behaviour, which closing a cash drawer relies on;
          changing "to" then widens it into a range. A "from" after "to" (or
          a "to" before "from") moves the other side with it. Under "All
          time" the untouched side stays open-ended. */}
      <div className="flex items-center gap-2">
        <DateInput className="w-36 shrink-0" value={value.from} max={today}
          aria-label="From"
          onChange={(from) => onChange({
            kind: "range",
            from,
            to: value.to === "" ? ""
              : value.from === value.to || value.to < from ? from : value.to,
          })} />
        <span className="text-[13px] text-text-muted">to</span>
        <DateInput className="w-36 shrink-0" value={value.to} max={today}
          aria-label="To"
          onChange={(to) => onChange({
            kind: "range",
            from: value.from === "" ? "" : value.from > to ? to : value.from,
            to,
          })} />
      </div>
    </div>
  );
}

/** First and last day when the period is exactly one calendar month. */
export function wholeMonth(p: Period): string | null {
  if (!p.from || !p.to || !p.from.endsWith("-01")) return null;
  return p.to === monthEndISO(p.from.slice(0, 7)) ? p.from : null;
}
