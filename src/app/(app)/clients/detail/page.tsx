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
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, SkeletonRows,
  Table, Td, Th, Truncate,
} from "@/components/ui";
import { StatusBadge } from "@/components/client-bits";

interface VisitRow {
  visit_date: string;
  tickets: number;
  spend_cents: number;
  days_since_previous: number | null;
  branch_id: string;
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
    const [client, visits, packages, retention] = await Promise.all([
      supabase.from("clients").select("*").eq("id", id).single(),
      supabase
        .from("v_client_visits")
        .select("visit_date, tickets, spend_cents, days_since_previous, branch_id")
        .eq("client_id", id)
        .order("visit_date", { ascending: false })
        .limit(100),
      supabase.from("packages").select("*, services(name)").eq("client_id", id),
      canSeeAnalytics
        ? supabase.from("v_client_retention").select("*").eq("client_id", id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    return {
      client: unwrap(client) as Client,
      visits: unwrap(visits) as VisitRow[],
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

  const { client, visits, packages, retention } = q.data;
  const branchName = (bid: string) => branches.find((b) => b.id === bid)?.name ?? "";

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
          </p>
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

      {packages.length > 0 && (
        <Card title="Packages">
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th align="right">Sessions left</Th>
                <Th>Purchased</Th>
                <Th>Expires</Th>
                <Th align="right">Paid</Th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
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
        </Card>
      )}

      <Card title="Visit history">
        {visits.length === 0 ? (
          <EmptyState
            message="No visits yet. The first ticket creates one."
            action={<Link href="/tickets/new"><Button variant="primary">Add ticket</Button></Link>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Branch</Th>
                <Th align="right">Spend</Th>
                <Th align="right">Gap (days)</Th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.visit_date}>
                  <Td className="tnum">{v.visit_date}</Td>
                  <Td>{branchName(v.branch_id)}</Td>
                  <Td align="right" className="tnum">{formatCentavos(v.spend_cents)}</Td>
                  <Td align="right" className="tnum">{v.days_since_previous ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
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
