"use client";

// Dashboard (spec §2). Every tile runs its own query through its own
// useQuery instance, so one failed query renders one inline error and the
// other tiles still populate (§5, partial failure).
//
// Every place that shows revenue also shows what was kept (§1.1).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, formatCount, formatPct } from "@/lib/money";
import { Card, ErrorState, SkeletonRows, SkeletonStat, Stat } from "@/components/ui";
import { BarList, LineChart } from "@/components/charts";

function monthStartISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

type Range = "today" | "month" | string; // string = a past month, "2026-07"

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

function monthEndISO(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export default function DashboardPage() {
  const { branchId, canSeeAnalytics } = useSession();
  const router = useRouter();
  const [range, setRange] = useState<Range>("today");

  // Front desk has no analytics (spec §3); their home is the ticket list.
  useEffect(() => {
    if (!canSeeAnalytics) router.replace("/tickets");
  }, [canSeeAnalytics, router]);

  const isPastMonth = range !== "today" && range !== "month";
  const from =
    range === "today" ? todayISO()
    : range === "month" ? monthStartISO()
    : `${range}-01`;
  const to = isPastMonth ? monthEndISO(range) : todayISO();

  if (!canSeeAnalytics) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Dashboard</h1>
        <div className="flex rounded-[4px] border border-border">
          {(["today", "month"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`h-8 px-4 text-[13px] ${
                range === r ? "bg-ink font-bold text-white" : "hover:bg-surface-page"
              }`}
            >
              {r === "today" ? "Today" : "This month"}
            </button>
          ))}
          <select
            aria-label="Past month"
            value={isPastMonth ? range : ""}
            onChange={(e) => { if (e.target.value) setRange(e.target.value); }}
            className={`h-8 border-l border-border px-2 text-[13px] outline-none ${
              isPastMonth ? "bg-ink font-bold text-white" : "bg-surface-card text-text-body"
            }`}
          >
            <option value="">Past month…</option>
            {pastMonths().map(([ym, label]) => (
              <option key={ym} value={ym}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      <SummaryTiles branchId={branchId} from={from} to={to} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PaceTile branchId={branchId} month={isPastMonth ? `${range}-01` : null} />
        <SalesTrendTile branchId={branchId}
          from={isPastMonth ? from : null} to={isPastMonth ? to : null} />
        <ServiceTile branchId={branchId} from={from} to={to} />
        <PaymentMixTile branchId={branchId} from={from} to={to} />
        <RetentionTile branchId={branchId} />
        <DataQualityTile branchId={branchId} from={from} to={to} />
      </div>

      <PriceDivergenceTile />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Summary {
  revenue_cents: number;
  company_share_cents: number;
  technician_share_cents: number;
  margin_pct: number | null;
  discount_pct: number | null;
  tickets: number;
  treatments: number;
  clients: number;
  new_clients: number;
  returning_clients: number;
  avg_ticket_cents: number | null;
  upsell_pct: number | null;
  avg_rating: number | null;
  rated_pct: number | null;
}

function SummaryTiles({ branchId, from, to }: { branchId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_sales_summary", {
      p_branch: branchId, p_from: from, p_to: to,
    });
    return unwrap(res) as Summary;
  }, [branchId, from, to]);

  if (q.status === "error") {
    return <ErrorState message="The sales summary did not load." onRetry={q.retry} />;
  }

  const s = q.status === "ready" ? q.data : null;

  return (
    <Card>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
        {s == null ? (
          Array.from({ length: 6 }, (_, i) => <SkeletonStat key={i} />)
        ) : (
          <>
            <Stat label="Sales" value={formatCentavos(s.revenue_cents)} hero />
            <Stat
              label="Company share"
              value={formatCentavos(s.company_share_cents)}
              sub={s.margin_pct != null ? `${formatPct(s.margin_pct)} margin` : undefined}
              hero
            />
            <Stat label="Tickets" value={formatCount(s.tickets)}
              sub={`${formatCount(s.treatments)} treatments`} />
            <Stat
              label="Clients"
              value={formatCount(s.clients)}
              sub={`${formatCount(s.new_clients)} new · ${formatCount(s.returning_clients)} returning`}
            />
            <Stat label="Average ticket" value={formatCentavos(s.avg_ticket_cents)}
              sub={s.upsell_pct != null ? `${formatPct(s.upsell_pct)} multi-service` : undefined} />
            <Stat
              label="Rating"
              value={s.avg_rating != null ? s.avg_rating.toFixed(2) : "—"}
              sub={s.rated_pct != null ? `${formatPct(s.rated_pct)} of lines rated` : "no ratings"}
            />
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface Pace {
  target_cents: number;
  revenue_cents: number;
  company_share_cents: number;
  expected_to_date_cents: number | null;
  pace_pct: number | null;
  target_pct: number | null;
  days_elapsed: number;
  days_in_month: number;
}

function PaceTile({ branchId, month }: { branchId: string | null; month: string | null }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_pace_vs_target", { p_branch: branchId, p_month: month });
    return unwrap(res) as Pace;
  }, [branchId, month]);

  return (
    <Card title={month ? "Result vs monthly target" : "Pace vs monthly target"}>
      {q.status === "loading" && <SkeletonRows rows={3} cols={2} />}
      {q.status === "error" && <ErrorState message="Pace did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        q.data.target_cents === 0 ? (
          <p className="text-[13px] text-text-muted">
            No monthly target set. Set one in Settings to see pace.
          </p>
        ) : (
          <PaceBody p={q.data} past={month != null} />
        )
      )}
    </Card>
  );
}

function PaceBody({ p, past }: { p: Pace; past: boolean }) {
  const behind = p.pace_pct != null && p.pace_pct < 95;
  const ahead = p.pace_pct != null && p.pace_pct >= 105;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Stat label={past ? "Month total" : "Month to date"} value={formatCentavos(p.revenue_cents)} />
        <Stat
          label={past ? "Target" : "Expected by today"}
          value={formatCentavos(p.expected_to_date_cents)}
          sub={past ? `${p.days_in_month} days` : `day ${p.days_elapsed} of ${p.days_in_month}`}
        />
        <Stat
          label="Pace"
          value={formatPct(p.pace_pct, 0)}
          tone={behind ? "negative" : ahead ? "positive" : undefined}
          sub={`${formatPct(p.target_pct, 0)} of ${formatCentavos(p.target_cents)}`}
        />
      </div>
      <div className="h-2 w-full rounded-[4px] bg-surface-page" aria-hidden>
        <div
          className="h-2 rounded-[4px]"
          style={{
            width: `${Math.min(p.target_pct ?? 0, 100)}%`,
            background: behind ? "var(--color-data-amber)" : "var(--color-data-teal)",
          }}
        />
      </div>
      <p className="text-[11px] text-text-muted">
        Pace compares month-to-date sales with the day-weighted share of target.
        No forecasting — twelve clean months first.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface DailyRow { day: string; revenue_cents: number | null; company_share_cents: number | null; tickets: number | null }

function SalesTrendTile({ branchId, from, to }: {
  branchId: string | null;
  from: string | null;
  to: string | null;
}) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_daily_series", {
      p_branch: branchId, p_from: from, p_to: to,
    });
    return unwrap(res) as DailyRow[];
  }, [branchId, from, to]);

  return (
    <Card title={from ? "Daily sales" : "Last 30 days"}>
      {q.status === "loading" && <SkeletonRows rows={5} cols={3} />}
      {q.status === "error" && <ErrorState message="The sales trend did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        <LineChart
          height={190}
          series={[
            {
              name: "Sales",
              color: "var(--color-ink)",
              points: q.data.map((d) => ({ label: d.day, value: d.revenue_cents })),
            },
            {
              name: "Kept",
              color: "var(--color-data-teal)",
              dashed: true,
              points: q.data.map((d) => ({ label: d.day, value: d.company_share_cents })),
            },
          ]}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface ServiceRow {
  service_id: string;
  service_name: string;
  service_type_name: string;
  units: number;
  revenue_cents: number;
  company_share_cents: number;
  margin_pct: number | null;
}

function ServiceTile({ branchId, from, to }: { branchId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_sales_by_service", {
      p_branch: branchId, p_from: from, p_to: to, p_limit: 8,
    });
    return unwrap(res) as ServiceRow[];
  }, [branchId, from, to]);

  return (
    <Card title="Sales and company share by service">
      {q.status === "loading" && <SkeletonRows rows={6} cols={2} />}
      {q.status === "error" && <ErrorState message="Service sales did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">No sales in this range yet.</p>
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <BarList
          items={q.data.map((s) => ({
            label: s.service_name,
            value: s.revenue_cents,
            sub: `kept ${formatCentavos(s.company_share_cents)} · ${formatPct(s.margin_pct)} · ${s.units}×`,
          }))}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface PayRow { method: string; tickets: number; amount_cents: number; share_pct: number | null }

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash", gcash: "GCash", maya: "Maya", bank: "Bank", card: "Card",
  package: "Package", comp: "Comp",
};

function PaymentMixTile({ branchId, from, to }: { branchId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_payment_mix", {
      p_branch: branchId, p_from: from, p_to: to,
    });
    return unwrap(res) as PayRow[];
  }, [branchId, from, to]);

  return (
    <Card title="Payment mix">
      {q.status === "loading" && <SkeletonRows rows={4} cols={2} />}
      {q.status === "error" && <ErrorState message="The payment mix did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">No payments in this range yet.</p>
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <BarList
          items={q.data.map((p) => ({
            label: METHOD_LABEL[p.method] ?? p.method,
            value: p.amount_cents,
            sub: `${formatCount(p.tickets)} tickets · ${formatPct(p.share_pct)}`,
          }))}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface Retention {
  new_clients: number;
  mature_cohort: number;
  converted_to_second: number;
  second_visit_pct: number | null;
  active_clients: number;
  at_risk_clients: number;
  lapsed_clients: number;
  never_returned: number;
}

function RetentionTile({ branchId }: { branchId: string | null }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_retention_summary", {
      p_branch: branchId, p_from: null, p_to: null,
    });
    return unwrap(res) as Retention;
  }, [branchId]);

  return (
    <Card title="Retention">
      {q.status === "loading" && <SkeletonRows rows={3} cols={3} />}
      {q.status === "error" && <ErrorState message="Retention did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Second-visit rate"
            value={formatPct(q.data.second_visit_pct, 0)}
            sub={`${formatCount(q.data.converted_to_second)} of ${formatCount(q.data.mature_cohort)} came back`}
          />
          <Stat label="Active" value={formatCount(q.data.active_clients)} tone="positive" />
          <Stat label="At risk" value={formatCount(q.data.at_risk_clients)} tone="warning" />
          <Stat label="Lapsed" value={formatCount(q.data.lapsed_clients)} tone="negative" />
        </div>
      )}
      <p className="mt-4 text-[11px] text-text-muted">
        At risk = past their own usual gap. Lapsed = past twice their gap. Full list under Analytics.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface Quality {
  tickets: number;
  declined_phone_pct: number | null;
  unrated_lines_pct: number | null;
  missing_times_pct: number | null;
}

function DataQualityTile({ branchId, from, to }: { branchId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_data_quality", {
      p_branch: branchId, p_from: from, p_to: to,
    });
    return unwrap(res) as Quality;
  }, [branchId, from, to]);

  return (
    <Card title="Data quality">
      {q.status === "loading" && <SkeletonRows rows={3} cols={3} />}
      {q.status === "error" && <ErrorState message="Data quality did not load." onRetry={q.retry} />}
      {q.status === "ready" && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Stat
              label="Phone declined"
              value={formatPct(q.data.declined_phone_pct, 0)}
              tone={(q.data.declined_phone_pct ?? 0) > 10 ? "warning" : undefined}
            />
            <Stat label="Lines unrated" value={formatPct(q.data.unrated_lines_pct, 0)} />
            <Stat label="Times missing" value={formatPct(q.data.missing_times_pct, 0)} />
          </div>
          <p className="mt-4 text-[11px] text-text-muted">
            Every declined phone is a visit the retention numbers cannot see.
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface Divergence {
  service_id: string;
  service_name: string;
  min_price_cents: number;
  max_price_cents: number;
  spread_pct: number | null;
}

function PriceDivergenceTile() {
  const { isOwner, businessId } = useSession();
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_price_divergence", { p_business: businessId });
    return unwrap(res) as Divergence[];
  }, [businessId]);

  if (!isOwner || q.status !== "ready" || q.data.length === 0) return null;

  return (
    <Card title="Branch prices diverge">
      <p className="mb-2 text-[11px] text-text-muted">
        These services are priced differently per branch. Fine if deliberate — this list keeps it deliberate.
      </p>
      <div className="flex flex-wrap gap-2">
        {q.data.map((d) => (
          <span key={d.service_id} className="rounded-[4px] bg-brand-red-tint px-2 py-1 text-[11px]">
            {d.service_name}: {formatCentavos(d.min_price_cents)}–{formatCentavos(d.max_price_cents)}
            {" "}({formatPct(d.spread_pct, 0)})
          </span>
        ))}
      </div>
    </Card>
  );
}
