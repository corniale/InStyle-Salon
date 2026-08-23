"use client";

// Ticket list: browse by period (Today · This month · Year to date · a
// chosen day) or search the whole history by ticket number, client name or
// phone; plus the offline queue — pending and needs-attention — so nothing
// queued is ever invisible (spec §9).

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, SkeletonRows,
  Table, Td, Th, Textarea, Truncate, useSort,
} from "@/components/ui";
import { csvPesos, downloadCsv } from "@/lib/csv";
import { Pagination } from "@/components/client-bits";
import { PeriodPicker, periodPreset, type Period } from "@/components/period-picker";
import { listQueue, removeFromQueue, type QueuedTicket } from "@/lib/offline/queue";
import { drainQueue } from "@/lib/offline/sync";
import { onQueueChanged } from "@/lib/offline/queue";

interface TicketRow {
  id: string;
  series_no: string | null;
  ticket_date: string;
  status: "open" | "closed";
  payment_method: string;
  is_new_client: boolean;
  voided_at: string | null;
  void_reason: string | null;
  clients: { id: string; full_name: string | null; phone: string; phone_declined: boolean } | null;
  ticket_lines: {
    total_cents: number;
    company_share_cents: number;
    qty: number;
    rating: number | null;
    services: { name: string } | null;
    technicians: { full_name: string } | null;
  }[];
}

function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
}

const clientLabel = (t: TicketRow) =>
  t.clients?.full_name ?? (t.clients?.phone_declined ? "Walk-in" : (t.clients?.phone ?? "—"));

const PAYMENT_LABEL: Record<string, string> = {
  cash: "Cash", online: "Online", split: "Split",
  package: "Package", comp: "Comp", gift_cert: "Gift cert",
};

const TICKET_ACC: Record<string, (t: TicketRow) => unknown> = {
  ticket: (t) => t.series_no,
  date: (t) => t.ticket_date,
  client: clientLabel,
  services: (t) => t.ticket_lines.map((l) => l.services?.name ?? "?").join(", "),
  technician: (t) => t.ticket_lines.map((l) => l.technicians?.full_name ?? "?").join(", "),
  payment: (t) => t.payment_method,
  total: (t) => t.ticket_lines.reduce((s, l) => s + l.total_cents, 0),
  share: (t) => t.ticket_lines.reduce((s, l) => s + l.company_share_cents, 0),
};

const TICKET_COLS =
  "id, series_no, ticket_date, status, payment_method, is_new_client, voided_at, void_reason, branch_id, clients(id, full_name, phone, phone_declined), ticket_lines(total_cents, company_share_cents, qty, rating, services(name), technicians!ticket_lines_technician_id_fkey(full_name))";
// Same columns, but the client join is inner so the query can filter the
// ticket by the client's name or phone.
const TICKET_COLS_INNER = TICKET_COLS.replace("clients(", "clients!inner(");

const TICKETS_PAGE = 50;
const SEARCH_CAP = 200;

export default function TicketsPage() {
  const { branchId, branches, isManagerUp, isAdminUp } = useSession();
  const [period, setPeriod] = useState<Period>(periodPreset("today"));
  const [voidTarget, setVoidTarget] = useState<TicketRow | null>(null);

  // Search finds a ticket anywhere in history — ticket number, client name,
  // or phone. It deliberately ignores the period filter: hunting last
  // month's ticket must not silently come up empty because "Today" is on.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);
  const searching = search.length >= 2;

  const { from, to } = period;
  const single = from === to;

  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [branchId, from, to, search]);

  const q = useQuery(async () => {
    const supabase = createClient();

    if (!searching) {
      // Browse: one server page of the period, with the exact total.
      let query = supabase
        .from("tickets")
        .select(TICKET_COLS, { count: "exact" })
        .gte("ticket_date", from)
        .lte("ticket_date", to)
        .order("ticket_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(page * TICKETS_PAGE, page * TICKETS_PAGE + TICKETS_PAGE - 1);
      if (branchId) query = query.eq("branch_id", branchId);
      const res = await query;
      const rows = unwrap(res) as unknown as TicketRow[];
      return { rows, total: res.count ?? rows.length, capped: false };
    }

    // Search: ticket-number matches and client matches, merged. Digits
    // search phones as well as ticket numbers; text searches names.
    const digits = search.replace(/\D/g, "");
    const isDigits = /^[\d\s-]+$/.test(search) && digits.length > 0;

    let bySeries = supabase.from("tickets").select(TICKET_COLS)
      .ilike("series_no", `%${search}%`);
    if (branchId) bySeries = bySeries.eq("branch_id", branchId);
    let byClient = isDigits
      ? supabase.from("tickets").select(TICKET_COLS_INNER)
          .like("clients.phone", `%${digits}%`)
      : supabase.from("tickets").select(TICKET_COLS_INNER)
          .ilike("clients.full_name", `%${search}%`);
    if (branchId) byClient = byClient.eq("branch_id", branchId);

    const [seriesRes, clientRes] = await Promise.all([
      bySeries.order("ticket_date", { ascending: false })
        .order("created_at", { ascending: false }).limit(SEARCH_CAP),
      byClient.order("ticket_date", { ascending: false })
        .order("created_at", { ascending: false }).limit(SEARCH_CAP),
    ]);
    const seriesRows = unwrap(seriesRes) as unknown as TicketRow[];
    const clientRows = unwrap(clientRes) as unknown as TicketRow[];

    const seen = new Set<string>();
    const rows: TicketRow[] = [];
    for (const t of [...seriesRows, ...clientRows]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        rows.push(t);
      }
    }
    rows.sort((a, b) => (a.ticket_date < b.ticket_date ? 1 : a.ticket_date > b.ticket_date ? -1 : 0));
    return {
      rows,
      total: rows.length,
      capped: seriesRows.length >= SEARCH_CAP || clientRows.length >= SEARCH_CAP,
    };
    // While browsing, page is a server-side input; while searching, the
    // slice is client-side, so the dep pins to 0 and page turns skip refetch.
  }, [branchId, from, to, search, searching ? 0 : page]);

  // Open tickets are shown whatever day they were parked on — one parked
  // just before midnight must still be findable (and billable) tomorrow,
  // or it silently blocks that day's cash close.
  const openQ = useQuery(async () => {
    const supabase = createClient();
    let query = supabase
      .from("tickets")
      .select(TICKET_COLS)
      .eq("status", "open")
      .is("voided_at", null)
      .order("created_at", { ascending: true });
    if (branchId) query = query.eq("branch_id", branchId);
    return unwrap(await query) as unknown as TicketRow[];
  }, [branchId]);

  const { rows, th } = useSort(q.status === "ready" ? q.data.rows : null, TICKET_ACC);
  // Browsing is server-paginated (rows already ARE one page); search results
  // arrive whole and page client-side.
  const displayRows = rows == null
    ? null
    : searching
      ? rows.slice(page * TICKETS_PAGE, page * TICKETS_PAGE + TICKETS_PAGE)
      : rows;
  const total = q.status === "ready" ? q.data.total : 0;
  const showDate = searching || !single;

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  // CSV of the whole filtered set — every ticket of the period while
  // browsing (fetched in 1,000-row pages), or every match while searching.
  async function exportCsv() {
    if (q.status !== "ready") return;
    setExporting(true);
    setExportError(false);
    try {
      let all: TicketRow[];
      if (searching) {
        all = q.data.rows;
      } else {
        const supabase = createClient();
        const PAGE = 1000;
        all = [];
        for (let offset = 0; ; offset += PAGE) {
          let query = supabase
            .from("tickets")
            .select(TICKET_COLS)
            .gte("ticket_date", from)
            .lte("ticket_date", to)
            .order("ticket_date", { ascending: true })
            .order("id", { ascending: true })
            .range(offset, offset + PAGE - 1);
          if (branchId) query = query.eq("branch_id", branchId);
          const chunk = unwrap(await query) as unknown as TicketRow[];
          all.push(...chunk);
          if (chunk.length < PAGE) break;
        }
      }
      downloadCsv(
        searching
          ? `tickets-search-${search.replace(/[^\w-]+/g, "-")}.csv`
          : `tickets-${from}-to-${to}.csv`,
        ["Ticket", "Date", "Client", "Phone", "Services", "Technicians", "Payment",
         "Total", "Company share", "New client", "Status", "Void reason"],
        all.map((t) => [
          t.series_no,
          t.ticket_date,
          clientLabel(t),
          t.clients?.phone_declined ? "declined" : t.clients?.phone,
          t.ticket_lines.map((l) =>
            l.qty > 1 ? `${l.services?.name ?? "?"} ×${l.qty}` : (l.services?.name ?? "?")).join(", "),
          [...new Set(t.ticket_lines.map((l) => l.technicians?.full_name ?? "?"))].join(", "),
          PAYMENT_LABEL[t.payment_method] ?? t.payment_method,
          csvPesos(t.ticket_lines.reduce((s, l) => s + l.total_cents, 0)),
          csvPesos(t.ticket_lines.reduce((s, l) => s + l.company_share_cents, 0)),
          t.is_new_client ? "yes" : "",
          t.voided_at != null ? "void" : t.status,
          t.void_reason,
        ]),
      );
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Tickets</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className="w-64 shrink-0">
            <Input
              placeholder="Search ticket #, name or phone"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search tickets"
            />
          </span>
          <PeriodPicker value={period} onChange={setPeriod} />
          {exportError && (
            <span className="text-[11px] text-brand-red">Export failed — try again.</span>
          )}
          {isAdminUp && (
            <Button
              busy={exporting}
              busyLabel="Exporting"
              disabled={q.status !== "ready" || q.data.rows.length === 0}
              onClick={() => void exportCsv()}
            >
              Export CSV
            </Button>
          )}
          <Link href="/tickets/new">
            <Button variant="primary">Add ticket</Button>
          </Link>
        </div>
      </div>

      <OfflineQueuePanel />

      {openQ.status === "ready" && openQ.data.length > 0 && (
        <Card title="Open tickets — waiting to be billed">
          <Table>
            <thead>
              <tr>
                <Th>Ticket</Th>
                <Th>Parked on</Th>
                <Th>Client</Th>
                <Th>Services so far</Th>
                <Th align="right">Running total</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {openQ.data.map((t) => (
                <tr key={t.id}>
                  <Td className="tnum">
                    <Link href={`/tickets/detail?id=${t.id}`} className="font-bold hover:underline">
                      {t.series_no ?? "—"}
                    </Link>
                  </Td>
                  <Td className={`tnum${t.ticket_date !== todayISO() ? " font-bold text-brand-red" : ""}`}>
                    {t.ticket_date}
                  </Td>
                  <Td>
                    {t.clients ? (
                      <Link href={`/clients/detail?id=${t.clients.id}`}
                        className="hover:underline">
                        <Truncate text={clientLabel(t)} />
                      </Link>
                    ) : (
                      <Truncate text={clientLabel(t)} />
                    )}
                  </Td>
                  <Td>
                    <Truncate
                      text={t.ticket_lines.map((l) => l.services?.name ?? "?").join(", ") || "—"}
                      max={44}
                    />
                  </Td>
                  <Td align="right" className="tnum">
                    {formatCentavos(t.ticket_lines.reduce((s, l) => s + l.total_cents, 0))}
                  </Td>
                  <Td align="right">
                    <Link href={`/tickets/new?resume=${t.id}`}>
                      <Button variant="primary">Resume</Button>
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-text-muted">
            Open tickets count nowhere until billed, and the cash day cannot close while any
            remain.
          </p>
        </Card>
      )}

      <Card>
        {q.status === "loading" && <SkeletonRows rows={8} cols={6} />}
        {q.status === "error" && (
          <ErrorState
            message="Tickets did not load. The connection may be down."
            onRetry={q.retry}
          />
        )}
        {q.status === "ready" && q.data.rows.length === 0 && (
          <EmptyState
            message={
              searching
                ? "No tickets match this search — any date, any status."
                : single && from === todayISO()
                  ? "No tickets today. Add ticket."
                  : single
                    ? "No tickets on this day."
                    : "No tickets in this period."
            }
            action={
              !searching && single && from === todayISO() ? (
                <Link href="/tickets/new">
                  <Button variant="primary">Add ticket</Button>
                </Link>
              ) : undefined
            }
          />
        )}
        {q.status === "ready" && searching && q.data.rows.length > 0 && (
          <p className="mb-2 text-[11px] text-text-muted">
            {q.data.capped
              ? `Showing the first ${q.data.rows.length} matches across all dates — narrow the search to see the rest.`
              : `Matches across all dates, newest first.`}
          </p>
        )}
        {rows != null && rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th {...th("ticket")}>Ticket</Th>
                {showDate && <Th {...th("date")}>Date</Th>}
                <Th {...th("client")}>Client</Th>
                <Th {...th("services")}>Services</Th>
                <Th {...th("technician")}>Technician</Th>
                <Th {...th("payment")}>Payment</Th>
                <Th align="right" {...th("total")}>Total</Th>
                <Th align="right" {...th("share")}>Company share</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {(displayRows ?? []).map((t) => {
                const rowTotal = t.ticket_lines.reduce((s, l) => s + l.total_cents, 0);
                const share = t.ticket_lines.reduce((s, l) => s + l.company_share_cents, 0);
                const voided = t.voided_at != null;
                return (
                  <tr key={t.id} className={voided ? "opacity-50" : ""}>
                    <Td>
                      <Link href={`/tickets/detail?id=${t.id}`}
                        className="tnum font-bold hover:underline">
                        {t.series_no ?? "—"}
                      </Link>
                      {t.is_new_client && !voided && (
                        <span className="ml-2 rounded-[4px] bg-surface-page px-1 text-[11px] text-text-muted">
                          new client
                        </span>
                      )}
                      {voided && (
                        <span
                          className="ml-2 rounded-[4px] bg-brand-red-tint px-1 text-[11px] text-brand-red-deep"
                          title={t.void_reason ?? undefined}
                        >
                          void
                        </span>
                      )}
                      {!voided && t.status === "open" && (
                        <span className="ml-2 rounded-[4px] bg-surface-page px-1 text-[11px] font-bold">
                          open
                        </span>
                      )}
                    </Td>
                    {showDate && <Td className="tnum">{t.ticket_date}</Td>}
                    <Td>
                      {t.clients ? (
                        <Link href={`/clients/detail?id=${t.clients.id}`}
                          className="hover:underline">
                          <Truncate text={clientLabel(t)} />
                        </Link>
                      ) : (
                        <Truncate text={clientLabel(t)} />
                      )}
                    </Td>
                    <Td>
                      <Truncate
                        text={t.ticket_lines
                          .map((l) =>
                            l.qty > 1
                              ? `${l.services?.name ?? "?"} ×${l.qty}`
                              : (l.services?.name ?? "?"),
                          )
                          .join(", ") || "—"}
                        max={40}
                      />
                    </Td>
                    <Td>
                      <Truncate
                        text={[...new Set(t.ticket_lines.map((l) => l.technicians?.full_name ?? "?"))].join(", ")}
                        max={22}
                      />
                    </Td>
                    <Td>{t.status === "open" && !voided
                      ? "—"
                      : (PAYMENT_LABEL[t.payment_method] ?? t.payment_method)}</Td>
                    <Td align="right" className="tnum">{formatCentavos(rowTotal)}</Td>
                    <Td align="right" className="tnum">{formatCentavos(share)}</Td>
                    <Td align="right">
                      {!voided && (
                        <span className="flex items-center justify-end gap-3">
                          {t.status === "open" ? (
                            <Link
                              href={`/tickets/new?resume=${t.id}`}
                              className="text-[11px] font-bold hover:underline"
                            >
                              Resume
                            </Link>
                          ) : (
                            isManagerUp && (
                              <Link
                                href={`/tickets/new?revise=${t.id}`}
                                className="text-[11px] hover:underline"
                              >
                                Revise
                              </Link>
                            )
                          )}
                          {isManagerUp && (
                            <button
                              className="text-[11px] text-brand-red hover:underline"
                              onClick={() => setVoidTarget(t)}
                            >
                              Void
                            </button>
                          )}
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {q.status === "ready" && (
          <Pagination
            page={page}
            total={total}
            onPage={setPage}
            noun="tickets"
            pageSize={TICKETS_PAGE}
          />
        )}
      </Card>

      <VoidModal
        ticket={voidTarget}
        onClose={() => setVoidTarget(null)}
        onDone={() => {
          setVoidTarget(null);
          q.retry();
          openQ.retry();
        }}
      />

      {branches.length === 0 && (
        <p className="text-[11px] text-text-muted">No branches are visible to this account.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Void: destructive confirm through a modal, reason required (spec §4.4)
// ---------------------------------------------------------------------------

function VoidModal({ ticket, onClose, onDone }: {
  ticket: TicketRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmVoid() {
    if (!ticket) return;
    if (reason.trim() === "") {
      setError("A void needs a reason.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("void_ticket", {
      p_ticket: ticket.id,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) {
      setError(
        /closed/i.test(error.message)
          ? "This day's cash is closed. Reopen the day first, then void."
          : "Could not void the ticket. It may already be void.",
      );
      return;
    }
    setReason("");
    onDone();
  }

  return (
    <Modal title={`Void ticket ${ticket?.series_no ?? ""}`} open={ticket != null} onClose={onClose}>
      <p className="mb-4 text-[13px] text-text-muted">
        The ticket stays on record and drops out of sales and cash figures.
      </p>
      <Field label="Reason" error={error ?? undefined}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="destructive" busy={busy} busyLabel="Voiding" onClick={confirmVoid}>
          Void ticket
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Offline queue: pending sync + needs attention, never hidden (spec §9)
// ---------------------------------------------------------------------------

function OfflineQueuePanel() {
  const [queue, setQueue] = useState<QueuedTicket[]>([]);

  useEffect(() => {
    const refresh = () => void listQueue().then(setQueue);
    refresh();
    return onQueueChanged(refresh);
  }, []);

  if (queue.length === 0) return null;

  const attention = queue.filter((q) => q.status === "needs_attention");
  const pending = queue.filter((q) => q.status !== "needs_attention");

  return (
    <Card title="Waiting to sync">
      {pending.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-[11px] text-text-muted">
            Recorded on this device and not yet on the server. They sync automatically when the
            connection returns.
          </p>
          <QueueTable items={pending} />
          <div className="mt-2">
            <Button onClick={() => void drainQueue()}>Sync now</Button>
          </div>
        </div>
      )}
      {attention.length > 0 && (
        <div>
          <p className="mb-2 text-[13px] font-bold text-brand-red">Needs attention</p>
          <p className="mb-2 text-[11px] text-text-muted">
            These were rejected on sync. Re-enter the ticket, then remove the failed copy.
          </p>
          <QueueTable items={attention} showError removable />
        </div>
      )}
    </Card>
  );
}

function QueueTable({ items, showError, removable }: {
  items: QueuedTicket[];
  showError?: boolean;
  removable?: boolean;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Queued</Th>
          <Th>Client</Th>
          <Th align="right">Total</Th>
          {showError && <Th>Reason</Th>}
          {removable && <Th></Th>}
        </tr>
      </thead>
      <tbody>
        {items.map((q) => (
          <tr key={q.key}>
            <Td className="tnum">{new Date(q.queuedAt).toLocaleTimeString()}</Td>
            <Td><Truncate text={q.summary.clientLabel} /></Td>
            <Td align="right" className="tnum">{formatCentavos(q.summary.totalCents)}</Td>
            {showError && (
              <Td className="text-brand-red-deep">
                <Truncate text={q.lastError ?? "Rejected"} max={48} />
              </Td>
            )}
            {removable && (
              <Td align="right">
                <button
                  className="text-[11px] text-brand-red hover:underline"
                  onClick={() => void removeFromQueue(q.key)}
                >
                  Remove
                </button>
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
