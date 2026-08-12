"use client";

// Branch comparison — a primary view, not a filter (spec §1.1). Side-by-side
// headline figures, then the per-service matrix where a service sold at only
// one branch reads "not offered", never zero (edge case 28).

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, formatCount, formatPct } from "@/lib/money";
import {
  Card, EmptyState, ErrorState, Input, SkeletonRows, Table, Td, Th, Truncate,
} from "@/components/ui";

const accentColor: Record<string, string> = {
  slate: "var(--color-data-slate)",
  plum: "var(--color-data-plum)",
};

interface BranchRow {
  branch_id: string;
  branch_code: string;
  branch_name: string;
  accent: string;
  revenue_cents: number;
  company_share_cents: number;
  margin_pct: number | null;
  tickets: number;
  treatments: number;
  clients: number;
  new_clients: number;
  avg_ticket_cents: number | null;
  discount_pct: number | null;
  avg_rating: number | null;
  monthly_target_cents: number;
}

interface MatrixRow {
  service_id: string;
  service_name: string;
  service_type_name: string;
  branch_id: string;
  branch_code: string;
  offered: boolean;
  units: number | null;
  revenue_cents: number | null;
  company_share_cents: number | null;
  margin_pct: number | null;
  list_price_cents: number | null;
}

function monthStartISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export default function ComparePage() {
  const { canSeeAnalytics, isOwner, businessId, business, businesses } = useSession();
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());

  if (!canSeeAnalytics) {
    return <EmptyState message="Branch comparison is available to the owner and branch managers." />;
  }
  if (!isOwner) {
    return <EmptyState message="Branch comparison spans both branches, so it is an owner view." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">
          Branch comparison
          {businesses.length > 1 && business ? ` — ${business.name}` : ""}
        </h1>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="w-40" aria-label="From" />
          <span className="text-[13px] text-text-muted">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="w-40" aria-label="To" />
        </div>
      </div>

      {/* Scoped to one business on purpose: a spa vs a barbershop row would
          compare nothing meaningful. Cross-business is the dashboard's job. */}
      <HeadToHead businessId={businessId} from={from} to={to} />
      <ServiceMatrix businessId={businessId} from={from} to={to} />
    </div>
  );
}

function HeadToHead({ businessId, from, to }: { businessId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_branch_comparison", {
      p_business: businessId, p_from: from, p_to: to,
    });
    return unwrap(res) as BranchRow[];
  }, [businessId, from, to]);

  return (
    <Card title="Head to head">
      {q.status === "loading" && <SkeletonRows rows={8} cols={3} />}
      {q.status === "error" && <ErrorState message="The comparison did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">No branches visible.</p>
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th></Th>
              {q.data.map((b) => (
                <Th key={b.branch_id} align="right">
                  <span className="inline-flex items-center gap-1">
                    {/* Branch accent, chart-series use (3 of 3). */}
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: accentColor[b.accent] ?? "var(--color-ink)" }}
                    />
                    {b.branch_name}
                  </span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            <CompareRow label="Sales" values={q.data.map((b) => formatCentavos(b.revenue_cents))} bold />
            <CompareRow
              label="Company share"
              values={q.data.map((b) => `${formatCentavos(b.company_share_cents)} (${formatPct(b.margin_pct)})`)}
              bold
            />
            <CompareRow label="Tickets" values={q.data.map((b) => formatCount(b.tickets))} />
            <CompareRow label="Treatments" values={q.data.map((b) => formatCount(b.treatments))} />
            <CompareRow label="Clients" values={q.data.map((b) => formatCount(b.clients))} />
            <CompareRow label="New clients" values={q.data.map((b) => formatCount(b.new_clients))} />
            <CompareRow label="Average ticket" values={q.data.map((b) => formatCentavos(b.avg_ticket_cents))} />
            <CompareRow label="Discount rate" values={q.data.map((b) => formatPct(b.discount_pct))} />
            <CompareRow
              label="Rating"
              values={q.data.map((b) => (b.avg_rating != null ? b.avg_rating.toFixed(2) : "—"))}
            />
            <CompareRow
              label="Monthly target"
              values={q.data.map((b) => formatCentavos(b.monthly_target_cents))}
            />
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function CompareRow({ label, values, bold }: { label: string; values: string[]; bold?: boolean }) {
  return (
    <tr>
      <Td className="text-text-muted">{label}</Td>
      {values.map((v, i) => (
        <Td key={i} align="right" className={`tnum ${bold ? "font-bold" : ""}`}>{v}</Td>
      ))}
    </tr>
  );
}

function ServiceMatrix({ businessId, from, to }: { businessId: string | null; from: string; to: string }) {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_service_branch_matrix", {
      p_business: businessId, p_from: from, p_to: to,
    });
    return unwrap(res) as MatrixRow[];
  }, [businessId, from, to]);

  return (
    <Card title="Service by branch">
      {q.status === "loading" && <SkeletonRows rows={10} cols={5} />}
      {q.status === "error" && <ErrorState message="The service matrix did not load." onRetry={q.retry} />}
      {q.status === "ready" && q.data.length === 0 && (
        <p className="text-[13px] text-text-muted">No services configured yet.</p>
      )}
      {q.status === "ready" && q.data.length > 0 && <MatrixTable rows={q.data} />}
    </Card>
  );
}

function MatrixTable({ rows }: { rows: MatrixRow[] }) {
  const branches = [...new Map(rows.map((r) => [r.branch_id, r.branch_code])).entries()];
  const services = [...new Map(rows.map((r) => [r.service_id, r])).values()];
  const cell = new Map(rows.map((r) => [`${r.service_id}:${r.branch_id}`, r]));

  return (
    <Table>
      <thead>
        <tr>
          <Th>Service</Th>
          {branches.map(([id, code]) => (
            <Th key={id} align="right">{code} price</Th>
          ))}
          {branches.map(([id, code]) => (
            <Th key={`${id}-rev`} align="right">{code} sales · kept</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {services.map((s) => (
          <tr key={s.service_id}>
            <Td>
              <Truncate text={s.service_name} />
              <span className="ml-2 text-[11px] text-text-muted">{s.service_type_name}</span>
            </Td>
            {branches.map(([id]) => {
              const c = cell.get(`${s.service_id}:${id}`);
              return (
                <Td key={id} align="right" className="tnum">
                  {c?.offered ? formatCentavos(c.list_price_cents) : (
                    <span className="text-text-muted">not offered</span>
                  )}
                </Td>
              );
            })}
            {branches.map(([id]) => {
              const c = cell.get(`${s.service_id}:${id}`);
              if (!c?.offered) {
                return (
                  <Td key={`${id}-rev`} align="right">
                    <span className="text-text-muted">—</span>
                  </Td>
                );
              }
              return (
                <Td key={`${id}-rev`} align="right" className="tnum">
                  {c.revenue_cents != null
                    ? `${formatCentavos(c.revenue_cents)} · ${formatCentavos(c.company_share_cents)}`
                    : "no sales"}
                </Td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
