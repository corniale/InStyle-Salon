"use client";

// Client profile: identity, visit history, package balances, and the merge
// flow (edge case 3) — both histories kept, the loser marked merged_into_id.
// Addressed as /clients/detail?id=… because the app is statically exported;
// a dynamic segment would need every id known at build time.

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos } from "@/lib/money";
import type { Client, Package } from "@/lib/types";
import { useMemo } from "react";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";
import { StatusBadge, MONTH_SHORT, formatBirthday } from "@/components/client-bits";

interface VisitRow {
  visit_date: string;
  tickets: number;
  spend_cents: number;
  days_since_previous: number | null;
  branch_id: string;
}

interface LineRow {
  ticket_date: string;
  service_name: string;
  technician_name: string;
  qty: number;
  total_cents: number;
  rating: number | null;
  payment_method: string;
}

interface RetentionRow {
  visit_count: number;
  first_visit: string;
  last_visit: string;
  lifetime_spend_cents: number;
  median_interval_days: number | null;
  days_overdue: number | null;
  status: string;
}

export default function ClientDetailPage() {
  return (
    <Suspense>
      <ClientDetail />
    </Suspense>
  );
}

function ClientDetail() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const { isManagerUp, canSeeAnalytics, branches } = useSession();
  const [mergeOpen, setMergeOpen] = useState(false);

  const q = useQuery(async () => {
    const supabase = createClient();
    const [client, visits, lines, packages, retention] = await Promise.all([
      supabase.from("clients").select("*").eq("id", id).single(),
      supabase
        .from("v_client_visits")
        .select("visit_date, tickets, spend_cents, days_since_previous, branch_id")
        .eq("client_id", id)
        .order("visit_date", { ascending: false })
        .limit(100),
      supabase
        .from("v_ticket_lines_active")
        .select("ticket_date, service_name, technician_name, qty, total_cents, rating, payment_method")
        .eq("client_id", id)
        .order("ticket_date", { ascending: false })
        .limit(500),
      supabase.from("packages").select("*, services(name)").eq("client_id", id),
      canSeeAnalytics
        ? supabase.from("v_client_retention").select("*").eq("client_id", id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    return {
      client: unwrap(client) as Client,
      visits: unwrap(visits) as VisitRow[],
      lines: unwrap(lines) as LineRow[],
      packages: unwrap(packages) as (Package & { services: { name: string } })[],
      retention: (retention.data ?? null) as RetentionRow | null,
    };
  }, [id, canSeeAnalytics]);

  if (q.status === "loading") {
    return <Card><SkeletonRows rows={8} cols={4} /></Card>;
  }
  if (q.status === "error") {
    return <ErrorState message="This client did not load." onRetry={q.retry} />;
  }

  const { client, visits, lines, packages, retention } = q.data;
  const branchName = (bid: string) => branches.find((b) => b.id === bid)?.name ?? "";
  const linesByDate = new Map<string, LineRow[]>();
  for (const l of lines) {
    const arr = linesByDate.get(l.ticket_date) ?? [];
    arr.push(l);
    linesByDate.set(l.ticket_date, arr);
  }

  if (client.merged_into_id) {
    return (
      <Card>
        <EmptyState
          message="This record was merged into another client."
          action={
            <Link href={`/clients/detail?id=${client.merged_into_id}`}>
              <Button variant="primary">Open the surviving record</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold">
            {client.full_name ?? (client.phone_declined ? "Walk-in" : client.phone)}
          </h1>
          <p className="text-[13px] text-text-muted tnum">
            {client.phone_declined ? "Phone declined" : client.phone}
            {client.town && ` · ${client.town}`}
            {client.barangay && `, ${client.barangay}`}
            {client.first_visit_on && ` · first visit ${client.first_visit_on}`}
            {formatBirthday(client.birth_month, client.birth_day) &&
              ` · birthday ${formatBirthday(client.birth_month, client.birth_day)}`}
          </p>
          {client.birth_month == null && (
            <BirthdaySetter clientId={client.id} onSet={q.retry} />
          )}
        </div>
        {isManagerUp && (
          <Button onClick={() => setMergeOpen(true)}>Merge into another client</Button>
        )}
      </div>

      {retention && (
        <Card title="Retention">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Metric label="Visits" value={String(retention.visit_count)} />
            <Metric label="Lifetime spend" value={formatCentavos(retention.lifetime_spend_cents)} />
            <Metric
              label="Usual gap"
              value={retention.median_interval_days != null ? `${retention.median_interval_days} days` : "—"}
            />
            <Metric
              label="Days overdue"
              value={retention.days_overdue != null && retention.days_overdue > 0
                ? String(retention.days_overdue) : "—"}
            />
            <div>
              <div className="text-[11px] text-text-muted">Status</div>
              <div className="mt-1"><StatusBadge status={retention.status} /></div>
            </div>
          </div>
        </Card>
      )}

      {lines.length > 0 && <HabitsCard lines={lines} />}

      {packages.length > 0 && (
        <Card title="Packages">
          <PackagesTable packages={packages} />
        </Card>
      )}

      <Card title="Visit history">
        {visits.length === 0 ? (
          <EmptyState
            message="No visits yet. The first ticket creates one."
            action={<Link href="/tickets/new"><Button variant="primary">Add ticket</Button></Link>}
          />
        ) : (
          <VisitHistoryTable visits={visits} linesByDate={linesByDate} branchName={branchName} />
        )}
      </Card>

      {client.notes && (
        <Card title="Notes">
          <p className="whitespace-pre-wrap text-[13px]">{client.notes}</p>
        </Card>
      )}

      <MergeModal
        open={mergeOpen}
        loser={client}
        onClose={() => setMergeOpen(false)}
        onDone={(winnerId) => router.push(`/clients/detail?id=${winnerId}`)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Packages and visit history tables (sortable)
// ---------------------------------------------------------------------------

type PackageRow = Package & { services: { name: string } };

const PACKAGE_ACC: Record<string, (p: PackageRow) => unknown> = {
  service: (p) => p.services.name,
  left: (p) => p.sessions_total - p.sessions_used,
  purchased: (p) => p.purchased_on,
  expires: (p) => p.expires_on,
  paid: (p) => p.amount_paid_cents,
};

function PackagesTable({ packages }: { packages: PackageRow[] }) {
  const { rows, th } = useSort(packages, PACKAGE_ACC);
  if (rows == null) return null;
  return (
    <Table>
      <thead>
        <tr>
          <Th {...th("service")}>Service</Th>
          <Th align="right" {...th("left")}>Sessions left</Th>
          <Th {...th("purchased")}>Purchased</Th>
          <Th {...th("expires")}>Expires</Th>
          <Th align="right" {...th("paid")}>Paid</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            <Td><Truncate text={p.services.name} /></Td>
            <Td align="right" className="tnum">
              {p.sessions_total - p.sessions_used} of {p.sessions_total}
            </Td>
            <Td className="tnum">{p.purchased_on}</Td>
            <Td className="tnum">{p.expires_on ?? "—"}</Td>
            <Td align="right" className="tnum">{formatCentavos(p.amount_paid_cents)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

interface VisitTableRow {
  v: VisitRow;
  branch: string;
  services: string;
  techs: string;
  rating: number | null;
  paid: string;
}

const VISIT_ACC: Record<string, (r: VisitTableRow) => unknown> = {
  date: (r) => r.v.visit_date,
  branch: (r) => r.branch,
  services: (r) => r.services,
  techs: (r) => r.techs,
  rating: (r) => r.rating,
  paid: (r) => r.paid,
  spend: (r) => r.v.spend_cents,
  gap: (r) => r.v.days_since_previous,
};

function VisitHistoryTable({ visits, linesByDate, branchName }: {
  visits: VisitRow[];
  linesByDate: Map<string, LineRow[]>;
  branchName: (bid: string) => string;
}) {
  const enriched = useMemo(() => visits.map((v): VisitTableRow => {
    const vl = linesByDate.get(v.visit_date) ?? [];
    const rated = vl.filter((l) => l.rating != null);
    return {
      v,
      branch: branchName(v.branch_id),
      services: vl
        .map((l) => (l.qty > 1 ? `${l.service_name} ×${l.qty}` : l.service_name))
        .join(", "),
      techs: [...new Set(vl.map((l) => l.technician_name))].join(", "),
      rating: rated.length
        ? rated.reduce((s, l) => s + (l.rating ?? 0), 0) / rated.length
        : null,
      paid: [...new Set(vl.map((l) => l.payment_method))].join(", "),
    };
  }), [visits, linesByDate, branchName]);

  const { rows, th } = useSort(enriched, VISIT_ACC);
  if (rows == null) return null;

  return (
    <Table>
      <thead>
        <tr>
          <Th {...th("date")}>Date</Th>
          <Th {...th("branch")}>Branch</Th>
          <Th {...th("services")}>Services</Th>
          <Th {...th("techs")}>Technician</Th>
          <Th align="right" {...th("rating")}>Rating</Th>
          <Th {...th("paid")}>Paid by</Th>
          <Th align="right" {...th("spend")}>Spend</Th>
          <Th align="right" {...th("gap")}>Gap (days)</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ v, branch, services, techs, rating, paid }) => (
          <tr key={v.visit_date}>
            <Td className="tnum">{v.visit_date}</Td>
            <Td>{branch}</Td>
            <Td><Truncate text={services || "—"} max={44} /></Td>
            <Td><Truncate text={techs || "—"} max={24} /></Td>
            <Td align="right" className="tnum">{rating != null ? rating.toFixed(1) : "—"}</Td>
            <Td>{paid || "—"}</Td>
            <Td align="right" className="tnum">{formatCentavos(v.spend_cents)}</Td>
            <Td align="right" className="tnum">{v.days_since_previous ?? "—"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// What this client usually has, who usually serves them, and how they rate
// it — the profile a receptionist can act on when the client walks in.
function HabitsCard({ lines }: { lines: LineRow[] }) {
  const svc = new Map<string, number>();
  const tech = new Map<string, number>();
  let ratedSum = 0, ratedN = 0;
  const pay = new Map<string, number>();
  for (const l of lines) {
    svc.set(l.service_name, (svc.get(l.service_name) ?? 0) + l.qty);
    tech.set(l.technician_name, (tech.get(l.technician_name) ?? 0) + 1);
    if (l.rating != null) { ratedSum += l.rating; ratedN += 1; }
    pay.set(l.payment_method, (pay.get(l.payment_method) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const topSvc = top(svc, 3);
  const [regularTech] = top(tech, 1);
  const techShare = regularTech ? Math.round((regularTech[1] / lines.length) * 100) : 0;
  const [usualPay] = top(pay, 1);

  return (
    <Card title="Habits">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div data-stat>
          <div className="text-[11px] text-text-muted">Usual services</div>
          <div className="text-[13px] leading-relaxed">
            {topSvc.map(([name, n]) => (
              <div key={name}>
                <Truncate text={name} max={26} />{" "}
                <span className="text-text-muted tnum">×{n}</span>
              </div>
            ))}
          </div>
        </div>
        <Metric
          label="Regular technician"
          value={regularTech ? regularTech[0] : "—"}
        />
        <Metric
          label="Sticks with them"
          value={regularTech ? `${techShare}% of services` : "—"}
        />
        <Metric
          label="Average rating given"
          value={ratedN ? `${(ratedSum / ratedN).toFixed(2)} (${ratedN} rated)` : "none yet"}
        />
      </div>
      {usualPay && (
        <p className="mt-4 text-[11px] text-text-muted">
          Usually pays by {usualPay[0]}.
        </p>
      )}
    </Card>
  );
}

// Any staff member may fill in a missing birthday (heard at the register);
// changing a recorded one is manager-only, enforced server-side.
function BirthdaySetter({ clientId, onSet }: { clientId: string; onSet: () => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        className="mt-1 text-[11px] text-text-muted underline underline-offset-2 hover:text-text-body"
        onClick={() => setOpen(true)}
      >
        Add birthday
      </button>
    );
  }

  async function save() {
    const m = Number(month), d = Number(day);
    if (!m || !d || d < 1 || d > 31) {
      setError("Pick the month and enter the day.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("set_client_birthday", {
      p_client: clientId, p_month: m, p_day: d,
    });
    setBusy(false);
    if (error) {
      setError("That did not save. Check the day is valid for the month.");
      return;
    }
    setOpen(false);
    onSet();
  }

  return (
    <span className="mt-2 flex items-end gap-2">
      <Field label="Birthday" error={error ?? undefined}>
        <span className="flex gap-2">
          <Select value={month} className="w-28" aria-label="Birth month"
            onChange={(e) => setMonth(e.target.value)}>
            <option value="">Month</option>
            {MONTH_SHORT.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </Select>
          <Input inputMode="numeric" placeholder="Day" value={day} className="w-20"
            aria-label="Birth day"
            onChange={(e) => setDay(e.target.value.replace(/\D/g, "").slice(0, 2))} />
        </span>
      </Field>
      <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void save()}>
        Save
      </Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div data-stat>
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="text-[20px] font-bold leading-tight">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge: pick the surviving record, confirm through a modal
// ---------------------------------------------------------------------------

function MergeModal({ open, loser, onClose, onDone }: {
  open: boolean;
  loser: Client;
  onClose: () => void;
  onDone: (winnerId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<Client[]>([]);
  const [winner, setWinner] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(value: string) {
    setSearch(value);
    setWinner(null);
    if (value.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const supabase = createClient();
    const query = supabase
      .from("clients")
      .select("*")
      .is("merged_into_id", null)
      .neq("id", loser.id)
      .limit(8);
    const { data } = /^\d+$/.test(value.trim())
      ? await query.like("phone", `%${value.trim()}%`)
      : await query.ilike("full_name", `%${value.trim()}%`);
    setCandidates((data ?? []) as Client[]);
  }

  async function confirmMerge() {
    if (!winner) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("merge_clients", {
      p_loser: loser.id,
      p_winner: winner.id,
    });
    setBusy(false);
    if (error) {
      setError("The merge did not go through. Try again.");
      return;
    }
    onDone(winner.id);
  }

  return (
    <Modal title="Merge client" open={open} onClose={onClose}>
      <p className="mb-4 text-[13px] text-text-muted">
        All visits, tickets and packages from{" "}
        <span className="font-bold text-text-body">
          {loser.full_name ?? loser.phone}
        </span>{" "}
        move to the client picked below. Both histories are kept; this record is
        marked as merged.
      </p>

      <Field label="Surviving client (name or phone)">
        <Input value={search} onChange={(e) => void lookup(e.target.value)} autoFocus />
      </Field>

      {candidates.length > 0 && !winner && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-[4px] border border-border">
          {candidates.map((c) => (
            <li key={c.id}>
              <button
                className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] hover:bg-surface-page"
                onClick={() => setWinner(c)}
              >
                <span>{c.full_name ?? "—"}</span>
                <span className="tnum text-text-muted">{c.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {winner && (
        <div className="mt-2 rounded-[4px] bg-surface-page p-2 text-[13px]">
          Merging into <span className="font-bold">{winner.full_name ?? winner.phone}</span>{" "}
          <button className="ml-2 text-[11px] underline" onClick={() => setWinner(null)}>
            change
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-brand-red">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="destructive"
          disabled={!winner}
          busy={busy}
          busyLabel="Merging"
          onClick={() => void confirmMerge()}
        >
          Merge records
        </Button>
      </div>
    </Modal>
  );
}
