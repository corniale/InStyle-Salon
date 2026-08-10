"use client";

// Technician analytics (spec §2, §7.2). The ranking is normalised against
// service mix: expected margin (what the price list would keep on this mix)
// sits next to actual, so nail technicians are not punished for 50-58%
// services. Technicians under the ticket threshold are shown separately so
// a new hire's three tickets never top the leaderboard (edge case 27).

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, formatCount, formatPct } from "@/lib/money";
import {
  Card, EmptyState, ErrorState, Input, SkeletonRows, Table, Td, Th, Truncate,
} from "@/components/ui";

interface TechRow {
  technician_id: string;
  technician_name: string;
  branch_id: string;
  branch_code: string;
  tickets: number;
  lines: number;
  revenue_cents: number;
  company_share_cents: number;
  distinct_clients: number;
  repeat_clients: number;
  client_retention_pct: number | null;
  avg_rating: number | null;
  rated_pct: number | null;
  expected_margin_pct: number | null;
  actual_margin_pct: number | null;
  margin_vs_expected_pts: number | null;
  busy_minutes: number | null;
  scheduled_minutes: number | null;
  utilisation_pct: number | null;
  ranked: boolean;
}

function monthStartISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export default function TechniciansPage() {
  const { branchId, canSeeAnalytics } = useSession();
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());

  const q = useQuery(async () => {
    const res = await createClient().rpc("f_technician_ranking", {
      p_branch: branchId, p_from: from, p_to: to, p_min_tickets: 10,
    });
    return unwrap(res) as TechRow[];
  }, [branchId, from, to]);

  if (!canSeeAnalytics) {
    return <EmptyState message="Technician analytics are available to the owner and branch managers." />;
  }

  const ranked = q.status === "ready" ? q.data.filter((t) => t.ranked) : [];
  const unranked = q.status === "ready" ? q.data.filter((t) => !t.ranked) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Technicians</h1>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="w-40" aria-label="From" />
          <span className="text-[13px] text-text-muted">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="w-40" aria-label="To" />
        </div>
      </div>

      <Card title="Ranking">
        {q.status === "loading" && <SkeletonRows rows={8} cols={7} />}
        {q.status === "error" && (
          <ErrorState message="Technician figures did not load." onRetry={q.retry} />
        )}
        {q.status === "ready" && ranked.length === 0 && unranked.length === 0 && (
          <p className="text-[13px] text-text-muted">No ticket lines in this range.</p>
        )}
        {q.status === "ready" && ranked.length === 0 && unranked.length > 0 && (
          <p className="text-[13px] text-text-muted">
            Nobody reaches 10 tickets in this range yet — everyone is listed below under fewer tickets.
          </p>
        )}
        {q.status === "ready" && ranked.length > 0 && <TechTable rows={ranked} />}
      </Card>

      {q.status === "ready" && unranked.length > 0 && (
        <Card title="Fewer than 10 tickets in range">
          <p className="mb-2 text-[11px] text-text-muted">
            Too few tickets to rank fairly — shown separately, not mixed into the leaderboard.
          </p>
          <TechTable rows={unranked} />
        </Card>
      )}

      <p className="text-[11px] text-text-muted">
        &ldquo;Margin vs expected&rdquo; compares what the company kept with what the price list would
        keep on that exact service mix. Positive means the technician outperforms their mix; a raw
        margin ranking would only re-rank the price list. Utilisation is approximated from ticket
        times against the shift table until Stage 2 brings real scheduling.
      </p>
    </div>
  );
}

function TechTable({ rows }: { rows: TechRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Technician</Th>
          <Th>Branch</Th>
          <Th align="right">Tickets</Th>
          <Th align="right">Sales</Th>
          <Th align="right">Company share</Th>
          <Th align="right">Margin vs expected</Th>
          <Th align="right">Client retention</Th>
          <Th align="right">Rating</Th>
          <Th align="right">Utilisation</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={`${t.technician_id}-${t.branch_id}`}>
            <Td className="font-bold"><Truncate text={t.technician_name} /></Td>
            <Td>{t.branch_code}</Td>
            <Td align="right" className="tnum">{formatCount(t.tickets)}</Td>
            <Td align="right" className="tnum">{formatCentavos(t.revenue_cents)}</Td>
            <Td align="right" className="tnum">
              {formatCentavos(t.company_share_cents)}
              <span className="ml-1 text-[11px] text-text-muted">
                {formatPct(t.actual_margin_pct, 0)}
              </span>
            </Td>
            <Td align="right" className="tnum">
              <MarginDelta pts={t.margin_vs_expected_pts} />
            </Td>
            <Td align="right" className="tnum">
              {formatPct(t.client_retention_pct, 0)}
              <span className="ml-1 text-[11px] text-text-muted">
                {t.repeat_clients}/{t.distinct_clients}
              </span>
            </Td>
            <Td align="right" className="tnum">
              {t.avg_rating != null ? t.avg_rating.toFixed(2) : "—"}
              {t.rated_pct != null && (
                <span className="ml-1 text-[11px] text-text-muted">
                  ({formatPct(t.rated_pct, 0)} rated)
                </span>
              )}
            </Td>
            <Td align="right" className="tnum">
              {t.utilisation_pct != null ? formatPct(t.utilisation_pct, 0) : "no shifts"}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function MarginDelta({ pts }: { pts: number | null }) {
  if (pts == null) return <span>—</span>;
  const rounded = Math.round(pts * 10) / 10;
  if (Math.abs(rounded) < 0.05) return <span>0.0 pts</span>;
  const positive = rounded > 0;
  return (
    <span className={positive ? "text-data-teal" : "text-data-amber"}>
      {positive ? "+" : ""}{rounded.toFixed(1)} pts
    </span>
  );
}
