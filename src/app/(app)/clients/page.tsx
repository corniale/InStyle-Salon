"use client";

// Client database (spec §2). Paginated — the list exceeds 50 rows
// (edge case 31) — searchable by name or phone, with lapsed status from
// v_client_retention where the caller can see analytics. Page and search
// live in the URL so a detail visit (or a merge) can come straight back
// to the same spot in the list.

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Input, SkeletonRows, Table, Td, Th, Truncate, useSort,
} from "@/components/ui";
import { Pagination, StatusBadge, formatBirthday, CLIENTS_PAGE_SIZE as PAGE } from "@/components/client-bits";

interface ClientRow {
  id: string;
  phone: string;
  phone_declined: boolean;
  full_name: string | null;
  town: string | null;
  inquiry_source: string | null;
  first_visit_on: string | null;
}

interface RetentionRow {
  client_id: string;
  visit_count: number;
  last_visit: string;
  lifetime_spend_cents: number;
  status: string;
}

type ClientListRow = ClientRow & { ret: RetentionRow | null };

const CLIENT_ACC: Record<string, (c: ClientListRow) => unknown> = {
  name: (c) => c.full_name ?? (c.phone_declined ? "Walk-in" : c.phone),
  phone: (c) => (c.phone_declined ? null : c.phone),
  town: (c) => c.town,
  discovery: (c) => c.inquiry_source,
  type: (c) => (c.ret == null ? null : c.ret.visit_count > 1 ? "Returning" : "New"),
  visits: (c) => c.ret?.visit_count ?? null,
  spend: (c) => c.ret?.lifetime_spend_cents ?? null,
  status: (c) => c.ret?.status ?? null,
};

export default function ClientsPage() {
  return (
    <Suspense>
      <ClientsList />
    </Suspense>
  );
}

function ClientsList() {
  const { canSeeAnalytics } = useSession();
  const router = useRouter();
  const sp = useSearchParams();

  // URL is the source of truth ("page" is 1-based there); the input keeps
  // local state so typing never fights the router.
  const urlQ = sp.get("q") ?? "";
  const page = Math.max(0, (Number(sp.get("page")) || 1) - 1);
  const [search, setSearch] = useState(urlQ);
  useEffect(() => { setSearch(urlQ); }, [urlQ]);

  const listParams = new URLSearchParams();
  if (urlQ.trim() !== "") listParams.set("q", urlQ);
  if (page > 0) listParams.set("page", String(page + 1));
  const listQS = listParams.toString();

  function syncUrl(nextQ: string, nextPage: number) {
    const params = new URLSearchParams();
    if (nextQ.trim() !== "") params.set("q", nextQ);
    if (nextPage > 0) params.set("page", String(nextPage + 1));
    router.replace(params.toString() ? `/clients?${params.toString()}` : "/clients",
      { scroll: false });
  }

  const q = useQuery(async () => {
    const supabase = createClient();
    let query = supabase
      .from("clients")
      .select("id, phone, phone_declined, full_name, town, inquiry_source, first_visit_on", { count: "exact" })
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

    return {
      rows: rows.map((c) => ({ ...c, ret: retention.get(c.id) ?? null })),
      total: res.count ?? rows.length,
    };
  }, [search, page, canSeeAnalytics]);

  const { rows, th } = useSort(q.status === "ready" ? q.data.rows : null, CLIENT_ACC);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Clients</h1>
        <Input
          placeholder="Search name or phone"
          value={search}
          onChange={(e) => { setSearch(e.target.value); syncUrl(e.target.value, 0); }}
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
        {q.status === "ready" && rows != null && rows.length > 0 && (
          <>
            <Table>
              <thead>
                <tr>
                  <Th {...th("name")}>Name</Th>
                  <Th {...th("phone")}>Phone</Th>
                  <Th {...th("town")}>Town</Th>
                  <Th {...th("discovery")}>Client discovery method</Th>
                  {canSeeAnalytics && (
                    <>
                      <Th {...th("type")}>Client type</Th>
                      <Th align="right" {...th("visits")}>Visits</Th>
                      <Th align="right" {...th("spend")}>Lifetime spend</Th>
                      <Th {...th("status")}>Status</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const r = c.ret;
                  return (
                    <tr key={c.id}>
                      <Td>
                        <Link
                          href={`/clients/detail?id=${c.id}${listQS ? `&${listQS}` : ""}`}
                          className="font-bold hover:underline"
                        >
                          <Truncate text={c.full_name ?? (c.phone_declined ? "Walk-in" : c.phone)} />
                        </Link>
                      </Td>
                      <Td className="tnum">{c.phone_declined ? "declined" : c.phone}</Td>
                      <Td>{c.town ?? "—"}</Td>
                      <Td>{c.inquiry_source ?? "—"}</Td>
                      {canSeeAnalytics && (
                        <>
                          <Td>
                            {r == null ? "—" : r.visit_count > 1 ? "Returning" : (
                              <span className="font-bold text-data-teal">New</span>
                            )}
                          </Td>
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
            <Pagination page={page} total={q.data.total}
              onPage={(p) => syncUrl(search, p)} noun="clients" />
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

const BIRTHDAY_ACC: Record<string, (r: BirthdayRow) => unknown> = {
  client: (r) => r.full_name ?? r.phone,
  birthday: (r) => r.birth_month * 100 + r.birth_day,
  days: (r) => r.days_until,
  phone: (r) => (r.phone_declined ? null : r.phone),
  visits: (r) => r.visit_count,
  spend: (r) => r.lifetime_spend_cents,
};

function BirthdaysCard() {
  const q = useQuery(async () => {
    const res = await createClient().rpc("f_upcoming_birthdays", { p_days: 30 });
    return unwrap(res) as BirthdayRow[];
  }, []);
  const { rows, th } = useSort(q.status === "ready" ? q.data : null, BIRTHDAY_ACC);

  if (rows == null || rows.length === 0) return null;

  return (
    <Card title="Birthdays in the next 30 days">
      <Table>
        <thead>
          <tr>
            <Th {...th("client")}>Client</Th>
            <Th {...th("birthday")}>Birthday</Th>
            <Th align="right" {...th("days")}>In</Th>
            <Th {...th("phone")}>Phone</Th>
            <Th align="right" {...th("visits")}>Visits</Th>
            <Th align="right" {...th("spend")}>Lifetime spend</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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
