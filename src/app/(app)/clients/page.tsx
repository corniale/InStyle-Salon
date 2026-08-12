"use client";

// Client database (spec §2). Paginated — the list exceeds 50 rows
// (edge case 31) — searchable by name or phone, with lapsed status from
// v_client_retention where the caller can see analytics.

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Input, SkeletonRows, Table, Td, Th, Truncate,
} from "@/components/ui";
import { Pagination, StatusBadge, formatBirthday, CLIENTS_PAGE_SIZE as PAGE } from "@/components/client-bits";

interface ClientRow {
  id: string;
  phone: string;
  phone_declined: boolean;
  full_name: string | null;
  town: string | null;
  first_visit_on: string | null;
}

interface RetentionRow {
  client_id: string;
  visit_count: number;
  last_visit: string;
  lifetime_spend_cents: number;
  status: string;
}

export default function ClientsPage() {
  const { canSeeAnalytics } = useSession();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const q = useQuery(async () => {
    const supabase = createClient();
    let query = supabase
      .from("clients")
      .select("id, phone, phone_declined, full_name, town, first_visit_on", { count: "exact" })
      .is("merged_into_id", null)
      .order("full_name", { ascending: true, nullsFirst: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    const s = search.trim();
    if (s !== "") {
      query = /^\d+$/.test(s)
        ? query.like("phone", `%${s}%`)
        : query.ilike("full_name", `%${s}%`);
    }

    const res = await query;
    const rows = unwrap(res) as ClientRow[];

    let retention = new Map<string, RetentionRow>();
    if (canSeeAnalytics && rows.length > 0) {
      const { data } = await supabase
        .from("v_client_retention")
        .select("client_id, visit_count, last_visit, lifetime_spend_cents, status")
        .in("client_id", rows.map((r) => r.id));
      retention = new Map(((data ?? []) as RetentionRow[]).map((r) => [r.client_id, r]));
    }

    return { rows, retention, total: res.count ?? rows.length };
  }, [search, page, canSeeAnalytics]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Clients</h1>
        <Input
          placeholder="Search name or phone"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="w-64"
          aria-label="Search clients"
        />
      </div>

      <BirthdaysCard />

      <Card>
        {q.status === "loading" && <SkeletonRows rows={10} cols={5} />}
        {q.status === "error" && (
          <ErrorState message="Clients did not load." onRetry={q.retry} />
        )}
        {q.status === "ready" && q.data.rows.length === 0 && (
          <EmptyState
            message={
              search.trim() !== ""
                ? "No clients match this search."
                : "No clients yet. They are created with their first ticket."
            }
            action={
              search.trim() === "" ? (
                <Link href="/tickets/new"><Button variant="primary">Add ticket</Button></Link>
              ) : undefined
            }
          />
        )}
        {q.status === "ready" && q.data.rows.length > 0 && (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Town</Th>
                  {canSeeAnalytics && (
                    <>
                      <Th align="right">Visits</Th>
                      <Th align="right">Lifetime spend</Th>
                      <Th>Status</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((c) => {
                  const r = q.data.retention.get(c.id);
                  return (
                    <tr key={c.id}>
                      <Td>
                        <Link href={`/clients/detail?id=${c.id}`} className="font-bold hover:underline">
                          <Truncate text={c.full_name ?? (c.phone_declined ? "Walk-in" : c.phone)} />
                        </Link>
                      </Td>
                      <Td className="tnum">{c.phone_declined ? "declined" : c.phone}</Td>
                      <Td>{c.town ?? "—"}</Td>
                      {canSeeAnalytics && (
                        <>
                          <Td align="right" className="tnum">{r?.visit_count ?? "—"}</Td>
                          <Td align="right" className="tnum">
                            {r ? formatCentavos(r.lifetime_spend_cents) : "—"}
                          </Td>
                          <Td><StatusBadge status={r?.status} /></Td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} total={q.data.total} onPage={setPage} noun="clients" />
          </>
        )}
      </Card>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Birthdays in the next 30 days — the reason the birthday field exists:
// front desk greets, offers the birthday discount, or makes the call.
// ---------------------------------------------------------------------------

interface BirthdayRow {
  client_id: string;
  full_name: string | null;
  phone: string;
  phone_declined: boolean;
  birth_month: number;
  birth_day: number;
  days_until: number;
  visit_count: number;
  last_visit: string | null;
  lifetime_spend_cents: number;
}

function BirthdaysCard() {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_upcoming_birthdays", { p_days: 30 });
    return unwrap(res) as BirthdayRow[];
  }, []);

  if (q.status !== "ready" || q.data.length === 0) return null;

  return (
    <Card title="Birthdays in the next 30 days">
      <Table>
        <thead>
          <tr>
            <Th>Client</Th>
            <Th>Birthday</Th>
            <Th align="right">In</Th>
            <Th>Phone</Th>
            <Th align="right">Visits</Th>
            <Th align="right">Lifetime spend</Th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((r) => (
            <tr key={r.client_id}>
              <Td>
                <Link href={`/clients/detail?id=${r.client_id}`} className="font-bold hover:underline">
                  <Truncate text={r.full_name ?? r.phone} />
                </Link>
              </Td>
              <Td className="tnum">{formatBirthday(r.birth_month, r.birth_day)}</Td>
              <Td align="right" className="tnum">
                {r.days_until === 0 ? (
                  <span className="font-bold text-brand-red">today</span>
                ) : (
                  `${r.days_until}d`
                )}
              </Td>
              <Td className="tnum">{r.phone_declined ? "—" : r.phone}</Td>
              <Td align="right" className="tnum">{r.visit_count}</Td>
              <Td align="right" className="tnum">{formatCentavos(r.lifetime_spend_cents)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="mt-2 text-[11px] text-text-muted">
        Birthday discounts are recorded with the &ldquo;Birthday&rdquo; discount type on the ticket,
        so their cost shows up in the discount analytics.
      </p>
    </Card>
  );
}
