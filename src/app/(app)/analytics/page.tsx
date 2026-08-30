"use client";

// Retention analytics (spec §2): first→second visit conversion, rebooking
// interval by service, the at-risk client list, and the 12-month trend with
// gaps for months that have no data (edge case 24). The imported history
// answered the spec's open question 4: May's sales were fully recorded —
// it was the client names that went missing that month.

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, formatCount, formatPct } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import {
  Card, EmptyState, ErrorState, Select, SkeletonRows, Stat, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";
import { BarList, LineChart } from "@/components/charts";
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
      <BookingFunnelCard branchId={branchId} />
      <MonthlyTrend branchId={branchId} />
      <PeakPeriods branchId={branchId} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TechnicianServiceCard branchId={branchId} />
        <UtilisationCard branchId={branchId} />
      </div>
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

// ---------------------------------------------------------------------------
// Booking funnel: inquiry → booked → showed, per channel — what each
// discovery channel is actually worth — plus how bookings end, and
// whether deposits change the no-show rate (the data behind the pending
// deposit policy).
// ---------------------------------------------------------------------------

interface FunnelRow { channel: string; inquiries: number; booked: number; showed: number }
interface OutcomeRow {
  total: number; billed: number; no_show: number; cancelled: number; moved: number;
  with_deposit: number; no_show_with_deposit: number;
}

const FUNNEL_CHANNEL: Record<string, string> = {
  call: "Calls", fb: "Facebook", walk_in: "Walk-in", other: "Other",
};

function BookingFunnelCard({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const supabase = createClient();
    const [funnel, outcomes] = await Promise.all([
      supabase.rpc("f_booking_funnel", { p_branch: branchId }),
      supabase.rpc("f_booking_outcomes", { p_branch: branchId }),
    ]);
    return {
      funnel: unwrap(funnel) as FunnelRow[],
      outcomes: (unwrap(outcomes) as OutcomeRow[])[0] ?? null,
    };
  }, [branchId]);

  if (q.status === "error") {
    return (
      <Card title="Booking funnel">
        <ErrorState message="The booking funnel did not load." onRetry={q.retry} />
      </Card>
    );
  }
  if (q.status !== "ready") {
    return <Card title="Booking funnel"><SkeletonRows rows={3} cols={4} /></Card>;
  }
  const { funnel, outcomes } = q.data;
  if (funnel.length === 0 && (outcomes == null || outcomes.total === 0)) {
    return null; // nothing yet — the card appears once bookings/inquiries exist
  }
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  return (
    <Card title="Booking funnel">
      <p className="mb-2 text-[11px] text-text-muted">
        Since bookings began. Inquiry → booked → showed measures what each
        channel is worth; log every inquiry to keep it honest.
      </p>
      {funnel.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Channel</Th>
              <Th align="right">Inquiries</Th>
              <Th align="right">Booked</Th>
              <Th align="right">Showed</Th>
              <Th align="right">Inquiry → showed</Th>
            </tr>
          </thead>
          <tbody>
            {funnel.map((f) => (
              <tr key={f.channel}>
                <Td>{FUNNEL_CHANNEL[f.channel] ?? f.channel}</Td>
                <Td align="right" className="tnum">{f.inquiries}</Td>
                <Td align="right" className="tnum">{f.booked}</Td>
                <Td align="right" className="tnum">{f.showed}</Td>
                <Td align="right" className="tnum">{pct(f.showed, f.inquiries)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {outcomes != null && outcomes.total > 0 && (
        <p className="mt-2 text-[11px] text-text-muted">
          Bookings overall: {outcomes.total} made · {outcomes.billed} billed ·{" "}
          {outcomes.no_show} no-shows
          {outcomes.with_deposit > 0 && (
            <> ({outcomes.no_show_with_deposit} of {outcomes.with_deposit} with a
            deposit — the number that will settle the deposit policy)</>
          )}
          {" "}· {outcomes.cancelled} cancelled · {outcomes.moved} moved.
        </p>
      )}
    </Card>
  );
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

// ---------------------------------------------------------------------------
// Technician performance per service: pick a service, see who does it
// most, how clients rate them at it, and how long they actually take
// (timed tickets only — the efficiency figure is real or absent).
// ---------------------------------------------------------------------------

interface TechServiceRow {
  service_id: string;
  service_name: string;
  technician_id: string;
  technician_name: string;
  branch_code: string;
  treatments: number;
  revenue_cents: number;
  avg_rating: number | null;
  rated: number;
  timed: number;
  avg_minutes: number | null;
  standard_minutes: number;
}

const TECH_SERVICE_ACC: Record<string, (r: TechServiceRow) => unknown> = {
  technician: (r) => r.technician_name,
  treatments: (r) => r.treatments,
  rating: (r) => r.avg_rating,
  minutes: (r) => r.avg_minutes,
};

function TechnicianServiceCard({ branchId }: { branchId: string | null }) {
  const [serviceId, setServiceId] = useState("");

  const q = useQuery(async () => {
    const res = await createClient().rpc("f_technician_service_stats", { p_branch: branchId });
    return unwrap(res) as TechServiceRow[];
  }, [branchId]);

  // Alphabetical for findability; the initial selection is still the
  // busiest service so the card opens on something meaningful.
  const services = useMemo(() => {
    if (q.status !== "ready") return [];
    const byService = new Map<string, { id: string; name: string; treatments: number }>();
    for (const r of q.data) {
      const s = byService.get(r.service_id) ?? { id: r.service_id, name: r.service_name, treatments: 0 };
      s.treatments += r.treatments;
      byService.set(r.service_id, s);
    }
    return [...byService.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [q.status, q.data]);

  const busiest = useMemo(
    () => services.reduce((top, s) => (s.treatments > (top?.treatments ?? -1) ? s : top),
      undefined as { id: string; treatments: number } | undefined),
    [services],
  );
  const activeService = serviceId || busiest?.id || "";
  const serviceRows = useMemo(
    () => (q.status === "ready"
      ? q.data.filter((r) => r.service_id === activeService)
          .sort((a, b) => b.treatments - a.treatments)
      : null),
    [q.status, q.data, activeService],
  );
  const { rows, th } = useSort(serviceRows, TECH_SERVICE_ACC);
  const standard = serviceRows?.[0]?.standard_minutes;

  return (
    <Card title="Technicians by service">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-text-muted">
          Who does this service most, how clients rate them at it, and how
          long they actually take.
        </p>
        <Select value={activeService} className="w-56" aria-label="Service"
          onChange={(e) => setServiceId(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.treatments.toLocaleString()})</option>
          ))}
        </Select>
      </div>

      {q.status === "loading" && <SkeletonRows rows={5} cols={4} />}
      {q.status === "error" && (
        <ErrorState message="Technician service stats did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && rows != null && rows.length === 0 && (
        <p className="text-[13px] text-text-muted">No recorded treatments for this service.</p>
      )}
      {q.status === "ready" && rows != null && rows.length > 0 && (
        <>
          <Table>
            <thead>
              <tr>
                <Th {...th("technician")}>Technician</Th>
                <Th align="right" {...th("treatments")}>Treatments</Th>
                <Th align="right" {...th("rating")}>Avg rating</Th>
                <Th align="right" {...th("minutes")}>Avg minutes</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.technician_id}>
                  <Td className="font-bold">
                    <Truncate text={r.technician_name} max={22} />
                    <span className="ml-1 text-[11px] text-text-muted">{r.branch_code}</span>
                  </Td>
                  <Td align="right" className="tnum">{r.treatments.toLocaleString()}</Td>
                  <Td align="right" className="tnum">
                    {r.avg_rating != null ? Number(r.avg_rating).toFixed(2) : "—"}
                    {r.rated > 0 && (
                      <span className="ml-1 text-[11px] text-text-muted">({r.rated})</span>
                    )}
                  </Td>
                  <Td align="right" className="tnum">
                    {r.avg_minutes != null ? Number(r.avg_minutes).toFixed(0) : "—"}
                    {r.timed > 0 && (
                      <span className="ml-1 text-[11px] text-text-muted">({r.timed})</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-text-muted">
            Standard duration {standard} min. Minutes come only from tickets with recorded
            times (counts in parentheses) — coverage grows as the POS captures them.
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Utilisation preview: busy hours per technician from recorded service
// times. The real measure (busy vs scheduled hours) needs the Stage 2
// shift schedule; this fills from what the POS already captures.
// ---------------------------------------------------------------------------

interface UtilRow {
  technician_name: string;
  branch_code: string;
  tickets: number;
  busy_minutes: number | null;
  utilisation_pct: number | null;
}

function UtilisationCard({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const to = new Date().toLocaleDateString("sv-SE");
    const from = new Date(Date.now() - 29 * 86400000).toLocaleDateString("sv-SE");
    const res = await createClient().rpc("f_technician_ranking", {
      p_branch: branchId, p_from: from, p_to: to, p_min_tickets: 1,
    });
    return unwrap(res) as UtilRow[];
  }, [branchId]);

  return (
    <Card title="Utilisation by technician (preview)">
      {q.status === "loading" && <SkeletonRows rows={5} cols={2} />}
      {q.status === "error" && (
        <ErrorState message="Utilisation did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">No service activity in the last 30 days.</p>
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <>
          <BarList
            money={false}
            items={[...q.data]
              .sort((a, b) => (b.busy_minutes ?? 0) - (a.busy_minutes ?? 0))
              .slice(0, 10)
              .map((r) => ({
                label: `${r.technician_name} (${r.branch_code})`,
                value: Math.round((r.busy_minutes ?? 0) / 60),
                sub: `${r.tickets} tickets`,
              }))}
          />
          <p className="mt-2 text-[11px] text-text-muted">
            Busy hours over the last 30 days, from recorded service times. True utilisation —
            busy against scheduled hours — arrives with Stage 2 shift scheduling; this preview
            sharpens as the POS captures times.
          </p>
        </>
      )}
    </Card>
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
  useEffect(() => { setPage(0); }, [branchId]);

  // Fetch the whole list once (it is a call list, realistically a few
  // hundred rows) so the sortable headers order the full set, not just the
  // visible page. Display still pages at 25.
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_at_risk_clients", {
      p_branch: branchId, p_limit: 1000, p_offset: 0,
    });
    return unwrap(res) as AtRiskRow[];
  }, [branchId]);
  const { rows, th } = useSort(q.status === "ready" ? q.data : null, AT_RISK_ACC);
  const pagedRows = rows?.slice(page * AT_RISK_PAGE, page * AT_RISK_PAGE + AT_RISK_PAGE) ?? null;

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
              {(pagedRows ?? []).map((r) => (
                <tr key={r.client_id}>
                  <Td>
                    <Link href={`/clients/detail?id=${r.client_id}`} className="font-bold hover:underline">
                      <Truncate text={r.full_name ?? (r.phone_declined ? "Walk-in" : r.phone)} />
                    </Link>
                  </Td>
                  <Td className="tnum">{r.phone_declined ? "declined" : r.phone}</Td>
                  <Td align="right" className="tnum">{r.visit_count}</Td>
                  <Td className="tnum">{fmtDate(r.last_visit)}</Td>
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
            total={q.data.length}
            onPage={setPage}
            noun="clients"
            pageSize={AT_RISK_PAGE}
          />
        </>
      )}
    </Card>
  );
}
