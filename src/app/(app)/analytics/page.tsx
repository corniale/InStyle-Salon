"use client";

// Retention analytics (spec §2): first→second visit conversion, rebooking
// interval by service, the at-risk client list, and the 12-month trend with
// gaps for months that have no data (edge case 24). The imported history
// answered the spec's open question 4: May's sales were fully recorded —
// it was the client names that went missing that month.

import { Fragment, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, formatCount, formatPct } from "@/lib/money";
import {
  Card, EmptyState, ErrorState, SkeletonRows, Stat, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";
import { LineChart } from "@/components/charts";
import { Pagination, StatusBadge } from "@/components/client-bits";

export default function AnalyticsPage() {
  const { branchId, canSeeAnalytics } = useSession();

  if (!canSeeAnalytics) {
    return <EmptyState message="Analytics are available to the owner and branch managers." />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-[20px] font-bold">Analytics</h1>
      <RetentionSummary branchId={branchId} />
      <MonthlyTrend branchId={branchId} />
      <PeakPeriods branchId={branchId} />
      <RebookingByService branchId={branchId} />
      <AtRiskList branchId={branchId} />
    </div>
  );
}

interface MonthlyRow {
  month: string;
  revenue_cents: number | null;
  company_share_cents: number | null;
  tickets: number | null;
  clients: number | null;
}

function MonthlyTrend({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_monthly_series", { p_branch: branchId, p_months: 12 });
    return unwrap(res) as MonthlyRow[];
  }, [branchId]);

  return (
    <Card title="Twelve months">
      {q.status === "loading" && <SkeletonRows rows={5} cols={3} />}
      {q.status === "error" && <ErrorState message="The monthly trend did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        <>
          <LineChart
            height={150}
            series={[
              {
                name: "Sales",
                color: "var(--color-ink)",
                points: q.data.map((m) => ({ label: m.month.slice(0, 7), value: m.revenue_cents })),
              },
              {
                name: "Sales, net of commissions",
                color: "var(--color-data-teal)",
                dashed: true,
                points: q.data.map((m) => ({ label: m.month.slice(0, 7), value: m.company_share_cents })),
              },
            ]}
          />
          <p className="mt-2 text-[11px] text-text-muted">
            A break in the line is a month with no recorded tickets — shown as a gap, not smoothed over.
          </p>
        </>
      )}
    </Card>
  );
}

interface Retention {
  new_clients: number;
  mature_cohort: number;
  converted_to_second: number;
  second_visit_pct: number | null;
  median_interval_days: number | null;
  active_clients: number;
  at_risk_clients: number;
  lapsed_clients: number;
  never_returned: number;
}

function RetentionSummary({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_retention_summary", {
      p_branch: branchId, p_from: null, p_to: null,
    });
    return unwrap(res) as Retention;
  }, [branchId]);

  return (
    <Card title="First visit to second visit">
      {q.status === "loading" && <SkeletonRows rows={3} cols={3} />}
      {q.status === "error" && <ErrorState message="Retention did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Second-visit conversion"
              value={formatPct(q.data.second_visit_pct, 0)}
              sub={`${formatCount(q.data.converted_to_second)} of ${formatCount(q.data.mature_cohort)} clients with 60+ days to return`}
              hero
            />
            <Stat
              label="Typical rebooking gap"
              value={q.data.median_interval_days != null ? `${q.data.median_interval_days} days` : "—"}
              sub="median of each client's own median"
            />
          </div>
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Active" value={formatCount(q.data.active_clients)} tone="positive" />
            <Stat label="At risk" value={formatCount(q.data.at_risk_clients)} tone="warning" />
            <Stat label="Lapsed" value={formatCount(q.data.lapsed_clients)} tone="negative" />
            <Stat label="Never returned" value={formatCount(q.data.never_returned)} />
          </div>
          <p className="text-[11px] text-text-muted">
            One-visit clients count toward new, not retention (their interval is undefined, not zero).
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Peak periods — when the salon is actually busy. Month view is a proper
// heatmap (month × weekday); day-of-week and hour views are intensity
// strips. Hour data comes from ticket start times, so it fills in as the
// POS captures them (July's imported times seed it).
// ---------------------------------------------------------------------------

interface PeakRow {
  dim: string;
  bucket: number;
  dow: number | null;
  tickets: number;
  revenue_cents: number;
}

const PEAK_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PEAK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "transparent";
  const pct = Math.max(8, Math.round((value / max) * 100));
  return `color-mix(in srgb, var(--color-data-teal) ${pct}%, transparent)`;
}

function PeakPeriods({ branchId }: { branchId: string | null }) {
  const [mode, setMode] = useState<"month" | "dow" | "hour">("month");

  const q = useQuery(async () => {
    const res = await createClient().rpc("f_peak_periods", { p_branch: branchId });
    return unwrap(res) as PeakRow[];
  }, [branchId]);

  return (
    <Card title="Peak periods">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-[11px] text-text-muted">
          Ticket traffic across all recorded history — darker is busier.
        </p>
        <div className="flex rounded-[4px] border border-border">
          {([["month", "Month"], ["dow", "Day of the week"], ["hour", "Time"]] as const).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={`h-8 px-3 text-[13px] ${
                  mode === key ? "bg-ink font-bold text-white" : "hover:bg-surface-page"
                }`}
              >
                {label}
              </button>
            ),
          )}
        </div>
      </div>

      {q.status === "loading" && <SkeletonRows rows={4} cols={7} />}
      {q.status === "error" && (
        <ErrorState message="Peak periods did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && (
        <>
          {mode === "month" && (
            <HeatStrip
              cells={PEAK_MONTHS.map((label, i) => ({
                label,
                value: q.data
                  .filter((r) => r.dim === "month_dow" && r.bucket === i + 1)
                  .reduce((s, r) => s + r.tickets, 0),
              }))}
            />
          )}
          {mode === "dow" && <MonthDowHeatmap rows={q.data} />}
          {mode === "hour" && <HourStrip rows={q.data} />}
        </>
      )}
    </Card>
  );
}

function MonthDowHeatmap({ rows }: { rows: PeakRow[] }) {
  const cell = new Map<string, number>();
  const rowTotal = new Map<number, number>();
  let max = 0;
  for (const r of rows) {
    if (r.dim !== "month_dow" || r.dow == null) continue;
    cell.set(`${r.bucket}:${r.dow}`, r.tickets);
    rowTotal.set(r.dow, (rowTotal.get(r.dow) ?? 0) + r.tickets);
    max = Math.max(max, r.tickets);
  }
  // Totals live on their own scale — a year's sum would wash out the
  // monthly cells if they shared one.
  const maxTotal = Math.max(...rowTotal.values(), 0);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[700px] gap-px"
        style={{ gridTemplateColumns: "44px repeat(12, 1fr) 64px" }}>
        <div />
        {PEAK_MONTHS.map((m) => (
          <div key={m} className="pb-1 text-center text-[11px] font-bold text-text-muted">{m}</div>
        ))}
        <div className="pb-1 text-center text-[11px] font-bold">Total</div>
        {PEAK_DAYS.map((day, di) => {
          const total = rowTotal.get(di + 1) ?? 0;
          return (
            <Fragment key={day}>
              <div className="flex items-center text-[11px] font-bold text-text-muted">
                {day}
              </div>
              {PEAK_MONTHS.map((_, mi) => {
                const v = cell.get(`${mi + 1}:${di + 1}`) ?? 0;
                return (
                  <div
                    key={`${day}-${mi}`}
                    title={`${day} in ${PEAK_MONTHS[mi]}: ${v.toLocaleString()} tickets`}
                    className="flex h-9 items-center justify-center rounded-[2px] border border-border text-[11px] tnum"
                    style={{ backgroundColor: heatColor(v, max) }}
                  >
                    {v > 0 ? v : ""}
                  </div>
                );
              })}
              <div
                title={`${day}, whole period: ${total.toLocaleString()} tickets`}
                className="ml-1 flex h-9 items-center justify-center rounded-[2px] border border-border text-[11px] font-bold tnum"
                style={{ backgroundColor: heatColor(total, maxTotal) }}
              >
                {total > 0 ? total.toLocaleString() : ""}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function HeatStrip({ cells }: { cells: Array<{ label: string; value: number }> }) {
  const max = Math.max(...cells.map((c) => c.value), 0);
  return (
    <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}>
      {cells.map((c) => (
        <div key={c.label} className="text-center">
          <div
            title={`${c.label}: ${c.value.toLocaleString()} tickets`}
            className="flex h-14 items-center justify-center rounded-[2px] border border-border text-[13px] font-bold tnum"
            style={{ backgroundColor: heatColor(c.value, max) }}
          >
            {c.value > 0 ? c.value.toLocaleString() : ""}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function HourStrip({ rows }: { rows: PeakRow[] }) {
  const hours = rows.filter((r) => r.dim === "hour");
  const withTimes = hours.reduce((s, r) => s + r.tickets, 0);
  if (withTimes === 0) {
    return (
      <p className="text-[13px] text-text-muted">
        No ticket start times recorded yet — this view fills in as the POS captures service
        times on new tickets.
      </p>
    );
  }
  const fmtHour = (h: number) =>
    h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
  const byHour = new Map(hours.map((r) => [r.bucket, r.tickets]));
  const present = hours.map((r) => r.bucket);
  const lo = Math.min(8, ...present);
  const hi = Math.max(20, ...present);
  const cells = [];
  for (let h = lo; h <= hi; h++) {
    cells.push({ label: fmtHour(h), value: byHour.get(h) ?? 0 });
  }
  return (
    <>
      <HeatStrip cells={cells} />
      <p className="mt-2 text-[11px] text-text-muted">
        Based on the {withTimes.toLocaleString()} tickets that carry a start time — coverage
        grows as the POS records times.
      </p>
    </>
  );
}

interface RebookRow {
  service_id: string;
  service_name: string;
  samples: number;
  median_days: number | null;
  p25_days: number | null;
  p75_days: number | null;
}

const REBOOK_ACC: Record<string, (r: RebookRow) => unknown> = {
  service: (r) => r.service_name,
  median: (r) => r.median_days,
  middle: (r) => r.p25_days,
  samples: (r) => r.samples,
};

function RebookingByService({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_rebooking_by_service", {
      p_branch: branchId, p_min_samples: 5,
    });
    return unwrap(res) as RebookRow[];
  }, [branchId]);
  const { rows, th } = useSort(q.status === "ready" ? q.data : null, REBOOK_ACC);

  return (
    <Card title="Rebooking interval by service">
      {q.status === "loading" && <SkeletonRows rows={5} cols={3} />}
      {q.status === "error" && <ErrorState message="Rebooking intervals did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">
          Not enough repeat visits yet — this fills in as history accumulates.
        </p>
      )}
      {rows != null && rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th {...th("service")}>Service</Th>
              <Th align="right" {...th("median")}>Median days to return</Th>
              <Th align="right" {...th("middle")}>Middle half</Th>
              <Th align="right" {...th("samples")}>Samples</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.service_id}>
                <Td><Truncate text={r.service_name} /></Td>
                <Td align="right" className="tnum font-bold">{r.median_days ?? "—"}</Td>
                <Td align="right" className="tnum">
                  {r.p25_days != null && r.p75_days != null ? `${r.p25_days}–${r.p75_days}` : "—"}
                </Td>
                <Td align="right" className="tnum">{r.samples}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface AtRiskRow {
  client_id: string;
  full_name: string | null;
  phone: string;
  phone_declined: boolean;
  visit_count: number;
  last_visit: string;
  median_interval_days: number | null;
  days_overdue: number | null;
  lifetime_spend_cents: number;
  status: string;
  total_count: number;
}

const AT_RISK_PAGE = 25;

const AT_RISK_ACC: Record<string, (r: AtRiskRow) => unknown> = {
  client: (r) => r.full_name ?? (r.phone_declined ? "Walk-in" : r.phone),
  phone: (r) => (r.phone_declined ? null : r.phone),
  visits: (r) => r.visit_count,
  last: (r) => r.last_visit,
  gap: (r) => r.median_interval_days,
  overdue: (r) => r.days_overdue,
  spend: (r) => r.lifetime_spend_cents,
  status: (r) => r.status,
};

function AtRiskList({ branchId }: { branchId: string | null }) {
  const [page, setPage] = useState(0);

  const q = useQuery(async () => {
    const res = await createClient().rpc("f_at_risk_clients", {
      p_branch: branchId, p_limit: AT_RISK_PAGE, p_offset: page * AT_RISK_PAGE,
    });
    return unwrap(res) as AtRiskRow[];
  }, [branchId, page]);
  const { rows, th } = useSort(q.status === "ready" ? q.data : null, AT_RISK_ACC);

  return (
    <Card title="Clients going quiet">
      {q.status === "loading" && <SkeletonRows rows={8} cols={6} />}
      {q.status === "error" && <ErrorState message="The at-risk list did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">
          Nobody is overdue against their own rhythm. This list fills as clients pass their usual gap.
        </p>
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <>
          <p className="mb-2 text-[11px] text-text-muted">
            Measured against each client&apos;s own rebooking rhythm, highest-value first. Stage 3 sends
            these win-back messages automatically; today this is the call list.
          </p>
          <Table>
            <thead>
              <tr>
                <Th {...th("client")}>Client</Th>
                <Th {...th("phone")}>Phone</Th>
                <Th align="right" {...th("visits")}>Visits</Th>
                <Th {...th("last")}>Last visit</Th>
                <Th align="right" {...th("gap")}>Usual gap</Th>
                <Th align="right" {...th("overdue")}>Days overdue</Th>
                <Th align="right" {...th("spend")}>Lifetime spend</Th>
                <Th {...th("status")}>Status</Th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.client_id}>
                  <Td>
                    <Link href={`/clients/detail?id=${r.client_id}`} className="font-bold hover:underline">
                      <Truncate text={r.full_name ?? (r.phone_declined ? "Walk-in" : r.phone)} />
                    </Link>
                  </Td>
                  <Td className="tnum">{r.phone_declined ? "declined" : r.phone}</Td>
                  <Td align="right" className="tnum">{r.visit_count}</Td>
                  <Td className="tnum">{r.last_visit}</Td>
                  <Td align="right" className="tnum">
                    {r.median_interval_days != null ? `${r.median_interval_days}d` : "—"}
                  </Td>
                  <Td align="right" className="tnum font-bold">
                    {r.days_overdue != null ? r.days_overdue : "—"}
                  </Td>
                  <Td align="right" className="tnum">{formatCentavos(r.lifetime_spend_cents)}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination
            page={page}
            total={q.data[0]?.total_count ?? q.data.length}
            onPage={setPage}
            noun="clients"
            pageSize={AT_RISK_PAGE}
          />
        </>
      )}
    </Card>
  );
}
