"use client";

// One ticket, fully opened up: every service line with its technician,
// price, discount, shares, rating and times; every payment leg with its
// reference; status, void reason, and the client it belongs to.
// Addressed as /tickets/detail?id=… (static export — no dynamic segments).

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import {
  Button, Card, EmptyState, ErrorState, SkeletonRows, Stat, Table, Td, Th, Truncate,
} from "@/components/ui";
import { formatClientNo } from "@/components/client-bits";

interface DetailLine {
  id: string;
  line_number: number;
  qty: number;
  unit_price_cents: number;
  discount_type: string | null;
  discount_cents: number;
  total_cents: number;
  company_share_cents: number;
  technician_share_cents: number;
  rating: number | null;
  is_upsell: boolean;
  started_at: string | null;
  ended_at: string | null;
  services: { name: string } | null;
  technician: { full_name: string } | null;
  assist: { full_name: string } | null;
}

interface DetailPayment {
  id: string;
  method: string;
  amount_cents: number;
  reference: string | null;
}

interface DetailTicket {
  id: string;
  series_no: string | null;
  ticket_date: string;
  status: "open" | "closed";
  payment_method: string;
  is_new_client: boolean;
  started_at: string | null;
  ended_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  branches: { name: string } | null;
  clients: {
    id: string; client_no: number; full_name: string | null;
    phone: string; phone_declined: boolean;
  } | null;
  ticket_lines: DetailLine[];
  ticket_payments: DetailPayment[];
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash", gcash: "GCash", maya: "Maya", bank: "Bank transfer", card: "Card",
  package: "Package", comp: "Comp", gift_cert: "Gift cert",
  online: "Online", split: "Split",
};

const DISCOUNT_LABEL: Record<string, string> = {
  senior: "Senior", pwd: "PWD", staff: "Staff", promo: "Promo",
  negotiated: "Negotiated", package: "Package", birthday: "Birthday", special: "Special",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TicketDetailPage() {
  return (
    <Suspense>
      <TicketDetail />
    </Suspense>
  );
}

function TicketDetail() {
  const id = useSearchParams().get("id") ?? "";
  const { isManagerUp } = useSession();

  const q = useQuery(async () => {
    const res = await createClient()
      .from("tickets")
      .select(`
        id, series_no, ticket_date, status, payment_method, is_new_client,
        started_at, ended_at, voided_at, void_reason, created_at,
        branches(name),
        clients(id, client_no, full_name, phone, phone_declined),
        ticket_lines(
          id, line_number, qty, unit_price_cents, discount_type, discount_cents,
          total_cents, company_share_cents, technician_share_cents, rating,
          is_upsell, started_at, ended_at,
          services(name),
          technician:technicians!ticket_lines_technician_id_fkey(full_name),
          assist:technicians!ticket_lines_assist_technician_id_fkey(full_name)
        ),
        ticket_payments(id, method, amount_cents, reference)
      `)
      .eq("id", id)
      .maybeSingle();
    return unwrap(res) as unknown as DetailTicket | null;
  }, [id]);

  if (q.status === "loading") return <Card><SkeletonRows rows={8} cols={5} /></Card>;
  if (q.status === "error") {
    return <ErrorState message="This ticket did not load." onRetry={q.retry} />;
  }
  const t = q.data;
  if (!t) return <EmptyState message="No ticket with this id." />;

  const voided = t.voided_at != null;
  const lines = [...t.ticket_lines].sort((a, b) => a.line_number - b.line_number);
  const total = lines.reduce((s, l) => s + l.total_cents, 0);
  const clientLabel =
    t.clients?.full_name ?? (t.clients?.phone_declined ? "Walk-in" : (t.clients?.phone ?? "—"));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/tickets"
        className="inline-block text-[13px] text-text-muted hover:text-text-body hover:underline">
        ← Back to tickets
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold tnum">
            Ticket {t.series_no ?? "—"}
            {voided ? (
              <span className="ml-2 rounded-[4px] bg-brand-red-tint px-2 py-px text-[11px] font-bold text-brand-red-deep align-middle">
                void
              </span>
            ) : t.status === "open" ? (
              <span className="ml-2 rounded-[4px] bg-surface-page px-2 py-px text-[11px] font-bold align-middle">
                open
              </span>
            ) : null}
          </h1>
          <p className="text-[13px] text-text-muted tnum">
            {fmtDate(t.ticket_date)} · {t.branches?.name ?? "—"}
            {" · "}
            {t.clients ? (
              <Link href={`/clients/detail?id=${t.clients.id}`} className="hover:underline">
                {clientLabel}
              </Link>
            ) : "—"}
            {t.clients && ` (${formatClientNo(t.clients.client_no)})`}
            {t.is_new_client && " · new client"}
            {t.started_at && ` · ${fmtTime(t.started_at)}–${fmtTime(t.ended_at)}`}
          </p>
        </div>
        {!voided && (
          <div className="flex gap-2">
            {t.status === "open" ? (
              <Link href={`/tickets/new?resume=${t.id}`}>
                <Button variant="primary">Resume</Button>
              </Link>
            ) : (
              isManagerUp && (
                <Link href={`/tickets/new?revise=${t.id}`}>
                  <Button>Revise</Button>
                </Link>
              )
            )}
          </div>
        )}
      </div>

      {voided && (
        <div className="rounded-[4px] bg-brand-red-tint p-3 text-[13px]">
          <span className="font-bold">Voided.</span> {t.void_reason ?? "No reason recorded."}
          <span className="text-text-muted"> · {new Date(t.voided_at!).toLocaleString()}</span>
        </div>
      )}

      <Card title="Services">
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Service</Th>
              <Th>Technician</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Price</Th>
              <Th align="right">Discount</Th>
              <Th align="right">Sub-total</Th>
              <Th align="right">Company share</Th>
              <Th align="right">Technician share</Th>
              <Th align="right">Rating</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td className="tnum">{l.line_number}</Td>
                <Td>
                  <Truncate text={l.services?.name ?? "?"} />
                  {l.is_upsell && (
                    <span className="ml-2 rounded-[4px] bg-surface-page px-1 text-[11px] text-text-muted">
                      upsell
                    </span>
                  )}
                </Td>
                <Td>
                  <Truncate text={l.technician?.full_name ?? "?"} max={22} />
                  {l.assist && (
                    <span className="text-[11px] text-text-muted">
                      {" "}+ {l.assist.full_name}
                    </span>
                  )}
                </Td>
                <Td align="right" className="tnum">{l.qty}</Td>
                <Td align="right" className="tnum">{formatCentavos(l.unit_price_cents)}</Td>
                <Td align="right" className="tnum">
                  {l.discount_cents > 0 ? (
                    <>
                      −{formatCentavos(l.discount_cents)}
                      {l.discount_type && (
                        <span className="ml-1 text-[11px] text-text-muted">
                          {DISCOUNT_LABEL[l.discount_type] ?? l.discount_type}
                        </span>
                      )}
                    </>
                  ) : "—"}
                </Td>
                <Td align="right" className="tnum font-bold">{formatCentavos(l.total_cents)}</Td>
                <Td align="right" className="tnum">{formatCentavos(l.company_share_cents)}</Td>
                <Td align="right" className="tnum">{formatCentavos(l.technician_share_cents)}</Td>
                <Td align="right" className="tnum">{l.rating ?? "—"}</Td>
                <Td className="tnum">
                  {l.started_at || l.ended_at
                    ? `${fmtTime(l.started_at)}–${fmtTime(l.ended_at)}`
                    : "—"}
                </Td>
              </tr>
            ))}
            <tr>
              <Td className="font-bold" colSpan={6}>Total</Td>
              <Td align="right" className="tnum font-bold">{formatCentavos(total)}</Td>
              <Td align="right" className="tnum font-bold">
                {formatCentavos(lines.reduce((s, l) => s + l.company_share_cents, 0))}
              </Td>
              <Td align="right" className="tnum font-bold">
                {formatCentavos(lines.reduce((s, l) => s + l.technician_share_cents, 0))}
              </Td>
              <Td colSpan={2}></Td>
            </tr>
          </tbody>
        </Table>
      </Card>

      <Card title="Payment">
        {t.ticket_payments.length === 0 ? (
          <EmptyState message={t.status === "open"
            ? "Not billed yet — payments are recorded at Bill & close."
            : "No payments recorded."} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {t.ticket_payments.map((p) => (
                <tr key={p.id}>
                  <Td>{METHOD_LABEL[p.method] ?? p.method}</Td>
                  <Td className="tnum"><Truncate text={p.reference ?? "—"} max={32} /></Td>
                  <Td align="right" className="tnum">{formatCentavos(p.amount_cents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Ticket total" value={formatCentavos(total)} hero />
          <Stat label="Payment summary"
            value={t.status === "open" ? "—" : (METHOD_LABEL[t.payment_method] ?? t.payment_method)} />
          <Stat label="Entered" value={new Date(t.created_at).toLocaleString()} />
        </div>
      </Card>
    </div>
  );
}
