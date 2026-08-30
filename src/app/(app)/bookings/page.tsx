"use client";

// Booking calendar (booking spec, phase 1): real holds against
// people-capacity. Two bucket columns (Hair / Nails & Foot), half-hour
// rows 8:00–18:00, remaining capacity per row, and a form that mirrors
// the paper notebook. Capacity is enforced server-side (save_booking);
// this page shows conflicts before they happen and surfaces the server's
// refusal when two tablets race.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import { DateInput } from "@/components/date-input";
import type { Client, Service, ServiceType } from "@/lib/types";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Truncate,
} from "@/components/ui";

interface BookingRow {
  id: string;
  booking_date: string;
  starts_at: string;
  ends_at: string;
  bucket: "hair" | "nail_foot";
  technician_id: string | null;
  status: string;
  deposit_cents: number | null;
  deposit_method: string | null;
  deposit_reference: string | null;
  note: string | null;
  ticket_id: string | null;
  clients: { id: string; full_name: string | null; phone: string; phone_declined: boolean } | null;
  booking_services: {
    service_id: string;
    duration_min: number;
    services: { name: string } | null;
  }[];
}

interface CapacityRow {
  bucket: "hair" | "nail_foot";
  capacity: number;
  approved: boolean;
  technician_ids: string[];
  technician_names: string[];
}

const STATUS_LABEL: Record<string, string> = {
  booked: "Booked", confirmed: "Confirmed", arrived: "Arrived",
  billed: "Billed", moved: "Moved", cancelled: "Cancelled", no_show: "No-show",
};

const ACTIVE = new Set(["booked", "confirmed", "arrived"]);

function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
}

/** "13:30" → minutes since midnight. */
function mins(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function fmtTime(t: string): string {
  const h = Number(t.slice(0, 2));
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${t.slice(3, 5)} ${ampm}`;
}

// 15-minute grid: services like a 45-minute haircut land on clean
// boundaries instead of rounding to the half hour.
const SLOT_MIN = 15;
const SLOTS = Array.from({ length: (18 - 8) * (60 / SLOT_MIN) }, (_, i) => {
  const m = 8 * 60 + i * SLOT_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

export default function BookingsPage() {
  const { branches, branchId } = useSession();
  const router = useRouter();
  const [branch, setBranch] = useState(branchId ?? branches[0]?.id ?? "");
  const [date, setDate] = useState(todayISO());
  const [nonce, setNonce] = useState(0);
  const [formOpen, setFormOpen] = useState<null | { edit?: BookingRow; move?: BookingRow; slot?: string }>(null);

  const q = useQuery(async () => {
    const supabase = createClient();
    const [bookings, capacity] = await Promise.all([
      supabase
        .from("bookings")
        .select("id, booking_date, starts_at, ends_at, bucket, technician_id, status, deposit_cents, deposit_method, deposit_reference, note, ticket_id, clients(id, full_name, phone, phone_declined), booking_services(service_id, duration_min, services(name))")
        .eq("branch_id", branch)
        .eq("booking_date", date)
        .order("starts_at"),
      supabase.rpc("f_day_capacity", { p_branch: branch, p_date: date }),
    ]);
    return {
      bookings: unwrap(bookings) as unknown as BookingRow[],
      capacity: unwrap(capacity) as CapacityRow[],
    };
  }, [branch, date, nonce]);

  function refresh() { setNonce((n) => n + 1); }

  const techNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of q.status === "ready" ? q.data.capacity : []) {
      c.technician_ids.forEach((id, i) => map.set(id, c.technician_names[i]));
    }
    return map;
  }, [q.status === "ready" ? q.data : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const nowMins = (() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Bookings</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {branches.length > 1 && (
            <Select value={branch} className="w-36" aria-label="Branch"
              onChange={(e) => setBranch(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          )}
          <div className="flex items-center rounded-[4px] border border-border">
            <button className="h-8 px-3 text-[13px] hover:bg-surface-page"
              onClick={() => setDate(addDays(date, -1))}>←</button>
            <button
              className={`h-8 px-2 text-[13px] ${date === todayISO() ? "font-bold" : "hover:bg-surface-page"}`}
              onClick={() => setDate(todayISO())}
            >
              Today
            </button>
            <DateInput className="w-32 shrink-0" value={date}
              onChange={setDate} aria-label="Booking date" />
            <button className="h-8 px-3 text-[13px] hover:bg-surface-page"
              onClick={() => setDate(addDays(date, 1))}>→</button>
          </div>
          <Button variant="primary" onClick={() => setFormOpen({})}>
            New booking
          </Button>
        </div>
      </div>

      {q.status === "loading" && <Card><SkeletonRows rows={10} cols={4} /></Card>}
      {q.status === "error" && (
        <Card><ErrorState message="Bookings did not load." onRetry={q.retry} /></Card>
      )}
      {q.status === "ready" && (
        <>
          {!q.data.capacity.some((c) => c.approved) && (
            <p className="text-[11px] text-brand-red">
              This day&apos;s schedule is not approved yet — capacity below assumes
              the full roster. Confirm the week on the Schedule page.
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {(["hair", "nail_foot"] as const).map((bucket) => {
              const cap = q.data.capacity.find((c) => c.bucket === bucket);
              const rows = q.data.bookings.filter((b) => b.bucket === bucket);
              return (
                <BucketColumn
                  key={bucket}
                  title={bucket === "hair" ? "Hair" : "Nails & Foot"}
                  cap={cap}
                  bookings={rows}
                  date={date}
                  nowMins={date === todayISO() ? nowMins : null}
                  techNames={techNames}
                  onSlot={(slot) => setFormOpen({ slot })}
                  onEdit={(b) => setFormOpen({ edit: b })}
                  onMove={(b) => setFormOpen({ move: b })}
                  onStatus={async (b, status) => {
                    const { error } = await createClient()
                      .rpc("set_booking_status", { p_booking: b.id, p_status: status });
                    if (!error && status === "arrived") {
                      router.push(`/tickets/new?booking=${b.id}`);
                      return;
                    }
                    refresh();
                  }}
                />
              );
            })}
          </div>
        </>
      )}

      <BookingModal
        state={formOpen}
        branch={branch}
        date={date}
        capacity={q.status === "ready" ? q.data.capacity : []}
        onClose={() => setFormOpen(null)}
        onDone={() => { setFormOpen(null); refresh(); }}
      />
    </div>
  );
}

function BucketColumn({ title, cap, bookings, date, nowMins, techNames, onSlot, onEdit, onMove, onStatus }: {
  title: string;
  cap: CapacityRow | undefined;
  bookings: BookingRow[];
  date: string;
  nowMins: number | null;
  techNames: Map<string, string>;
  onSlot: (slot: string) => void;
  onEdit: (b: BookingRow) => void;
  onMove: (b: BookingRow) => void;
  onStatus: (b: BookingRow, status: string) => void;
}) {
  const capacity = cap?.capacity ?? 0;
  const active = bookings.filter((b) => ACTIVE.has(b.status));

  function freeAt(slot: string): number {
    const t = mins(slot) + 1;
    const busy = active.filter((b) => mins(b.starts_at) <= t && mins(b.ends_at) > t).length;
    return Math.max(capacity - busy, 0);
  }

  return (
    <Card title={`${title} — ${capacity} on duty`}>
      <p className="mb-2 text-[11px] text-text-muted">
        {cap && cap.technician_names.length > 0
          ? cap.technician_names.join(" · ")
          : "Nobody scheduled."}
      </p>
      <div className="divide-y divide-border">
        {SLOTS.map((slot) => {
          const starting = bookings.filter((b) => {
            const m = mins(b.starts_at);
            return m >= mins(slot) && m < mins(slot) + SLOT_MIN;
          });
          const free = freeAt(slot);
          const onHour = slot.endsWith(":00");
          return (
            // The whole empty stretch of a row is a tap target for a new
            // booking at that time; booking cards swallow their own taps.
            <div
              key={slot}
              className={`flex items-start gap-2 py-0.5 hover:bg-surface-page ${
                starting.length > 0 ? "min-h-9" : "min-h-6 cursor-pointer"
              }`}
              onClick={() => onSlot(slot)}
              title={`New booking at ${fmtTime(slot)}`}
            >
              <span
                className={`w-16 shrink-0 pt-1 text-left text-[11px] tnum ${
                  onHour ? "text-text-body" : "text-text-muted"
                }`}
              >
                {fmtTime(slot)}
              </span>
              <div
                className="min-w-0 flex-1 space-y-1"
                onClick={(e) => { if (starting.length > 0) e.stopPropagation(); }}
              >
                {starting.map((b) => (
                  <BookingCardRow
                    key={b.id} b={b} nowMins={nowMins} techNames={techNames}
                    onEdit={onEdit} onMove={onMove} onStatus={onStatus}
                  />
                ))}
              </div>
              <span
                className={`shrink-0 pt-1 text-[10px] tnum ${
                  free === 0 ? "font-bold text-brand-red" : "text-text-muted"
                }`}
              >
                {free} free
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-text-muted">
        {date === todayISO()
          ? "A red LATE badge appears 15 minutes past a booking's start."
          : ""}
      </p>
    </Card>
  );
}

function BookingCardRow({ b, nowMins, techNames, onEdit, onMove, onStatus }: {
  b: BookingRow;
  nowMins: number | null;
  techNames: Map<string, string>;
  onEdit: (b: BookingRow) => void;
  onMove: (b: BookingRow) => void;
  onStatus: (b: BookingRow, status: string) => void;
}) {
  const inactive = !ACTIVE.has(b.status);
  const late = nowMins != null
    && (b.status === "booked" || b.status === "confirmed")
    && nowMins > mins(b.starts_at) + 15;
  const clientLabel = b.clients?.full_name
    ?? (b.clients?.phone_declined ? "Walk-in" : b.clients?.phone ?? "—");
  return (
    <div
      className={`rounded-[4px] border px-2 py-1 text-[12px] ${
        inactive ? "border-border opacity-50"
        : late ? "border-brand-red"
        : b.status === "arrived" ? "border-ink"
        : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="tnum text-[11px] text-text-muted">
          {fmtTime(b.starts_at)}–{fmtTime(b.ends_at)}
        </span>
        <span className="font-bold"><Truncate text={clientLabel} max={22} /></span>
        {b.technician_id && (
          <span className="rounded-[4px] bg-surface-page px-1 text-[10px]">
            {techNames.get(b.technician_id) ?? "named"}
          </span>
        )}
        {late && (
          <span className="rounded-[4px] bg-brand-red-tint px-1 text-[10px] font-bold text-brand-red-deep">
            LATE
          </span>
        )}
        {(inactive || b.status === "confirmed" || b.status === "arrived") && (
          <span className="rounded-[4px] bg-surface-page px-1 text-[10px]">
            {STATUS_LABEL[b.status]}
          </span>
        )}
        {b.deposit_cents != null && b.deposit_cents > 0 && (
          <span className="rounded-[4px] bg-surface-page px-1 text-[10px]"
            title={`Deposit via ${b.deposit_method ?? "?"}${b.deposit_reference ? ` (${b.deposit_reference})` : ""}`}>
            dep {formatCentavos(b.deposit_cents)}
          </span>
        )}
      </div>
      <div className="text-[11px] text-text-muted">
        <Truncate
          text={b.booking_services.map((s) => s.services?.name ?? "?").join(", ")}
          max={44}
        />
      </div>
      {!inactive && (
        <div className="mt-0.5 flex flex-wrap gap-3 text-[11px]">
          {b.status === "booked" && (
            <button className="hover:underline" onClick={() => onStatus(b, "confirmed")}>
              Confirm
            </button>
          )}
          {b.status !== "arrived" && (
            <button className="font-bold hover:underline" onClick={() => onStatus(b, "arrived")}>
              Arrived → ticket
            </button>
          )}
          {b.status === "arrived" && !b.ticket_id && (
            <button className="font-bold hover:underline" onClick={() => onStatus(b, "arrived")}>
              Open ticket
            </button>
          )}
          {b.status !== "arrived" && (
            <>
              <button className="hover:underline" onClick={() => onEdit(b)}>Edit</button>
              <button className="hover:underline" onClick={() => onMove(b)}>Move</button>
              <button className="text-brand-red hover:underline"
                onClick={() => onStatus(b, "no_show")}>
                No-show
              </button>
              <button className="text-brand-red hover:underline"
                onClick={() => onStatus(b, "cancelled")}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form: the notebook page. Client search identical in spirit to the POS.
// ---------------------------------------------------------------------------

interface SvcDraft {
  key: number;
  service_id: string;
  durationInput: string;
}

let keyCounter = 1;
const nextKey = () => keyCounter++;

function BookingModal({ state, branch, date, capacity, onClose, onDone }: {
  state: null | { edit?: BookingRow; move?: BookingRow; slot?: string };
  branch: string;
  date: string;
  capacity: CapacityRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { businessId } = useSession();
  const open = state != null;
  const editing = state?.edit ?? null;
  const moving = state?.move ?? null;
  const source = editing ?? moving;

  const refQ = useQuery(async () => {
    if (!open) return null;
    const supabase = createClient();
    const [services, types] = await Promise.all([
      supabase.from("services").select("*").eq("active", true).order("name"),
      supabase.from("service_types").select("*"),
    ]);
    const typeRows = (unwrap(types) as ServiceType[])
      .filter((t) => t.business_id === businessId);
    const typeIds = new Set(typeRows.map((t) => t.id));
    return {
      services: (unwrap(services) as Service[]).filter((s) => typeIds.has(s.service_type_id)),
      types: typeRows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, businessId]);
  const services = refQ.status === "ready" && refQ.data ? refQ.data.services : [];

  // Client
  const [clientSearch, setClientSearch] = useState("");
  const [results, setResults] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  // Booking
  const [bookDate, setBookDate] = useState(date);
  const [time, setTime] = useState("10:00");
  const [lines, setLines] = useState<SvcDraft[]>([{ key: nextKey(), service_id: "", durationInput: "" }]);
  const [techId, setTechId] = useState("");
  const [depositInput, setDepositInput] = useState("");
  const [depositMethod, setDepositMethod] = useState("gcash");
  const [depositRef, setDepositRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setClientSearch("");
    setResults([]);
    setError(null);
    setBusy(false);
    if (source) {
      setSelected(source.clients as unknown as Client ?? null);
      setNewName(""); setNewPhone("");
      setBookDate(moving ? date : source.booking_date);
      setTime(moving ? (state?.slot ?? source.starts_at.slice(0, 5)) : source.starts_at.slice(0, 5));
      setLines(source.booking_services.map((s) => ({
        key: nextKey(), service_id: s.service_id, durationInput: String(s.duration_min),
      })));
      setTechId(source.technician_id ?? "");
      setDepositInput(source.deposit_cents != null ? String(source.deposit_cents / 100) : "");
      setDepositMethod(source.deposit_method ?? "gcash");
      setDepositRef(source.deposit_reference ?? "");
      setNote(source.note ?? "");
    } else {
      setSelected(null);
      setNewName(""); setNewPhone("");
      setBookDate(date);
      setTime(state?.slot ?? "10:00");
      setLines([{ key: nextKey(), service_id: "", durationInput: "" }]);
      setTechId("");
      setDepositInput(""); setDepositMethod("gcash"); setDepositRef("");
      setNote("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Client search, debounced with a stale guard (same rules as the POS).
  useEffect(() => {
    const term = clientSearch.trim();
    if (!open || selected || term.length < 2) { setResults([]); return; }
    let alive = true;
    const handle = setTimeout(() => {
      void (async () => {
        let query = createClient()
          .from("clients").select("*")
          .is("merged_into_id", null).eq("is_pool", false)
          .order("full_name", { ascending: true, nullsFirst: false })
          .limit(8);
        query = /^[\d\s-]+$/.test(term)
          ? query.like("phone", `%${term.replace(/\D/g, "")}%`)
          : query.ilike("full_name", `%${term}%`);
        const { data } = await query;
        if (alive) setResults((data ?? []) as Client[]);
      })();
    }, 250);
    return () => { alive = false; clearTimeout(handle); };
  }, [clientSearch, selected, open]);

  const totalMinutes = lines.reduce((sum, l) => {
    const svc = services.find((s) => s.id === l.service_id);
    const d = l.durationInput !== "" ? Number(l.durationInput)
      : (svc?.default_duration_min ?? 0);
    return sum + (Number.isFinite(d) ? d : 0);
  }, 0);

  const bucket = (() => {
    const first = services.find((s) => s.id === lines[0]?.service_id);
    if (!first || refQ.status !== "ready" || !refQ.data) return null;
    const type = refQ.data.types.find((t) => t.id === first.service_type_id);
    return type?.name === "Nail & Foot" ? "nail_foot" : "hair";
  })();
  const bucketTechs = capacity.find((c) => c.bucket === (bucket ?? "hair"));

  async function submit() {
    setError(null);
    if (!selected && newPhone.trim() === "" && newName.trim() === "") {
      setError("Pick a client, or enter the new client's name and phone.");
      return;
    }
    if (!selected && newPhone.trim() !== "" && !/^\d{11}$/.test(newPhone.trim())) {
      setError("Phone number must be 11 digits (or leave it blank).");
      return;
    }
    if (lines.some((l) => l.service_id === "")) {
      setError("Pick every service, or remove the empty line.");
      return;
    }
    const deposit = depositInput.trim() === "" ? null : parsePesos(depositInput);
    if (depositInput.trim() !== "" && (deposit == null || deposit < 0)) {
      setError("The deposit must be a peso amount, or blank.");
      return;
    }
    setBusy(true);
    const payload = {
      branch_id: branch,
      client: selected
        ? { id: selected.id }
        : newPhone.trim() !== ""
          ? { phone: newPhone.trim(), full_name: newName.trim() || undefined }
          : { phone_declined: true, full_name: newName.trim() || undefined },
      booking_date: bookDate,
      starts_at: time,
      technician_id: techId || undefined,
      deposit_cents: deposit ?? undefined,
      deposit_method: deposit != null ? depositMethod : undefined,
      deposit_reference: depositRef.trim() || undefined,
      note: note.trim() || undefined,
      services: lines.map((l) => ({
        service_id: l.service_id,
        duration_min: l.durationInput !== "" ? Number(l.durationInput) : undefined,
      })),
    };
    const supabase = createClient();
    const { error: err } = moving
      ? await supabase.rpc("move_booking", { p_original: moving.id, p_payload: payload })
      : await supabase.rpc("save_booking", {
          p_payload: payload,
          ...(editing ? { p_booking: editing.id } : {}),
        });
    setBusy(false);
    if (err) {
      setError(/full|booked in this window/i.test(err.message)
        ? err.message.replace(/^.*?:\s*/, "")
        : /horizon/i.test(err.message) || /past/i.test(err.message)
          ? err.message
          : "The booking was not saved. Check the fields and try again.");
      return;
    }
    onDone();
  }

  return (
    <Modal
      title={editing ? "Edit booking" : moving ? "Move booking" : "New booking"}
      open={open}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field label="Client">
          {selected ? (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-bold">
                {selected.full_name ?? (selected.phone_declined ? "Walk-in" : selected.phone)}
              </span>
              {!selected.phone_declined && (
                <span className="text-text-muted tnum">{selected.phone}</span>
              )}
              <button className="text-[11px] text-text-muted hover:underline"
                onClick={() => setSelected(null)}>
                change
              </button>
            </div>
          ) : (
            <div className="relative">
              <Input placeholder="Search name or phone" value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)} />
              {results.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-[4px] border border-border bg-surface-card shadow">
                  {results.map((c) => (
                    <button key={c.id}
                      className="flex w-full items-center justify-between px-2 py-1 text-left text-[13px] hover:bg-surface-page"
                      onClick={() => { setSelected(c); setResults([]); setClientSearch(""); }}>
                      <span><Truncate text={c.full_name ?? "Walk-in"} max={24} /></span>
                      <span className="text-[11px] text-text-muted tnum">
                        {c.phone_declined ? "no phone" : c.phone}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
        {!selected && (
          <div className="flex flex-wrap gap-4">
            <Field label="New client name">
              <Input value={newName} className="w-48"
                onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Field label="Phone (11 digits)">
              <Input inputMode="numeric" value={newPhone} className="w-40"
                onChange={(e) => setNewPhone(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="flex flex-wrap items-end gap-2">
              <Field label="Service">
                <Select value={l.service_id} className="w-64"
                  onChange={(e) => {
                    const id = e.target.value;
                    setLines((ls) => ls.map((x) => x.key === l.key
                      ? { ...x, service_id: id, durationInput: "" } : x));
                  }}>
                  <option value="">Pick a service…</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Minutes">
                <Input inputMode="numeric" className="w-20"
                  value={l.durationInput}
                  placeholder={String(services.find((s) => s.id === l.service_id)?.default_duration_min ?? "")}
                  onChange={(e) => setLines((ls) => ls.map((x) => x.key === l.key
                    ? { ...x, durationInput: e.target.value } : x))} />
              </Field>
              {lines.length > 1 && (
                <button className="pb-2 text-[11px] text-brand-red hover:underline"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <Button onClick={() => setLines((ls) => [...ls, { key: nextKey(), service_id: "", durationInput: "" }])}>
            Add service
          </Button>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field label="Date">
            <DateInput value={bookDate} className="w-40"
              min={todayISO()} max={addDays(todayISO(), 14)}
              onChange={setBookDate} />
          </Field>
          <Field label="Start">
            <Select value={time} className="w-28"
              onChange={(e) => setTime(e.target.value)}>
              {SLOTS.map((s) => (
                <option key={s} value={s}>{fmtTime(s)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Preferred technician" hint="Optional">
            <Select value={techId} className="w-44"
              onChange={(e) => setTechId(e.target.value)}>
              <option value="">Any available</option>
              {(bucketTechs?.technician_ids ?? []).map((id, i) => (
                <option key={id} value={id}>{bucketTechs?.technician_names[i]}</option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field label="Deposit (₱)" hint="Blank if none">
            <Input inputMode="decimal" value={depositInput} className="w-28"
              onChange={(e) => setDepositInput(e.target.value)} />
          </Field>
          {depositInput.trim() !== "" && (
            <>
              <Field label="Via">
                <Select value={depositMethod} className="w-28"
                  onChange={(e) => setDepositMethod(e.target.value)}>
                  <option value="gcash">GCash</option>
                  <option value="maya">Maya</option>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                  <option value="card">Card</option>
                </Select>
              </Field>
              <Field label="Reference">
                <Input value={depositRef} className="w-36"
                  onChange={(e) => setDepositRef(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <p className="text-[11px] text-text-muted">
          {totalMinutes > 0 ? `About ${totalMinutes} minutes` : ""}
          {bucket ? ` · ${bucket === "nail_foot" ? "Nails & Foot" : "Hair"} slot` : ""}
        </p>
        {error && <p className="text-[11px] text-brand-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void submit()}>
            {editing ? "Save changes" : moving ? "Move booking" : "Book"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
