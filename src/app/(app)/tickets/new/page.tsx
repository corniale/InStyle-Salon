"use client";

// Ticket entry (spec §2 Light POS, §6 forms, §9 offline).
//
// - Client by phone: 11 digits required, existing client surfaced and reused
//   (edge case 2), explicit "walk-in, declined" escape hatch (open q. 1).
// - Lines: service, technician, assist, qty, price (prefilled from the branch
//   price list, editable for negotiated prices — edge case 7), discount,
//   rating, package redemption.
// - Payments: cash and online legs, split supported (edge case 19).
// - Submit carries a client-generated idempotency key. Offline or on network
//   failure the ticket queues locally and the UI confirms immediately.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import type {
  Client, DiscountType, Package, PaymentMethod, Service, ServiceType,
  Technician, TicketPayload,
} from "@/lib/types";
import {
  Button, Card, ErrorState, Field, Input, Select, SkeletonRows,
} from "@/components/ui";
import { enqueueTicket } from "@/lib/offline/queue";
import { MONTH_SHORT } from "@/components/client-bits";

interface PriceRow { service_id: string; price_cents: number; sharing_rate: number | null; effective_from: string }

interface LineDraft {
  key: number;
  service_id: string;
  technician_id: string;
  assist_technician_id: string;
  qty: number;
  priceInput: string; // pesos, as typed
  discount_type: "" | DiscountType;
  discountInput: string;
  rating: "" | number;
  package_id: string;
}

interface PaymentDraft {
  key: number;
  method: PaymentMethod;
  amountInput: string;
  reference: string;
}

let keyCounter = 1;
const nextKey = () => keyCounter++;

function emptyLine(): LineDraft {
  return {
    key: nextKey(), service_id: "", technician_id: "", assist_technician_id: "",
    qty: 1, priceInput: "", discount_type: "", discountInput: "", rating: "", package_id: "",
  };
}

export default function NewTicketPage() {
  const router = useRouter();
  const { branchId, branches, profile } = useSession();
  // Front desk / manager: their branch. Owner on consolidated: default to
  // the first branch — a sale always happens somewhere — with the picker
  // below to switch. An empty branch id would poison the price query.
  const [formBranchId, setFormBranchId] = useState(
    branchId ?? profile.branch_id ?? branches[0]?.id ?? "",
  );

  // ---- reference data -----------------------------------------------------
  const ref = useQuery(async () => {
    const supabase = createClient();
    const [types, services, technicians, prices] = await Promise.all([
      supabase.from("service_types").select("*").order("sort_order"),
      supabase.from("services").select("*").eq("active", true).order("name"),
      supabase.from("technicians").select("*").eq("active", true).order("full_name"),
      formBranchId
        ? supabase
            .from("branch_service_prices")
            .select("service_id, price_cents, sharing_rate, effective_from")
            .eq("branch_id", formBranchId)
            .lte("effective_from", new Date().toLocaleDateString("sv-SE"))
            .order("effective_from", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    return {
      types: unwrap(types) as ServiceType[],
      services: unwrap(services) as Service[],
      technicians: unwrap(technicians) as Technician[],
      prices: unwrap(prices as { data: PriceRow[] | null; error: { message: string } | null }) as PriceRow[],
    };
  }, [formBranchId]);

  // Latest price per service (list already sorted newest-first).
  const priceBook = useMemo(() => {
    const map = new Map<string, PriceRow>();
    for (const p of ref.data?.prices ?? []) {
      if (!map.has(p.service_id)) map.set(p.service_id, p);
    }
    return map;
  }, [ref.data]);

  const serviceById = useMemo(
    () => new Map((ref.data?.services ?? []).map((s) => [s.id, s])),
    [ref.data],
  );

  // ---- client -------------------------------------------------------------
  const [phone, setPhone] = useState("");
  const [phoneDeclined, setPhoneDeclined] = useState(false);
  const [clientName, setClientName] = useState("");
  const [town, setTown] = useState("");
  const [barangay, setBarangay] = useState("");
  const [inquirySource, setInquirySource] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [matched, setMatched] = useState<Client | null>(null);
  const [clientPackages, setClientPackages] = useState<(Package & { services: { name: string } })[]>([]);
  // Auto-follows the phone lookup (no match = new), editable when the front
  // desk knows better; the server stores whichever value is sent.
  const [isNewClient, setIsNewClient] = useState(true);

  // Live lookup once the phone is complete (edge case 2: surface, offer, reuse).
  useEffect(() => {
    let alive = true;
    setMatched(null);
    setClientPackages([]);
    setIsNewClient(true);
    if (phoneDeclined || !/^\d{11}$/.test(phone)) return;
    const supabase = createClient();
    void (async () => {
      const { data } = await supabase
        .from("clients").select("*").eq("phone", phone).maybeSingle();
      if (!alive || !data) return;
      const client = data as Client;
      setMatched(client);
      setIsNewClient(false);
      setClientName(client.full_name ?? "");
      setTown(client.town ?? "");
      setBarangay(client.barangay ?? "");
      const { data: pkgs } = await supabase
        .from("packages")
        .select("*, services(name)")
        .eq("client_id", client.id);
      if (alive && pkgs) {
        setClientPackages(
          (pkgs as (Package & { services: { name: string } })[]).filter(
            (p) =>
              p.sessions_used < p.sessions_total &&
              (!p.expires_on || p.expires_on >= new Date().toLocaleDateString("sv-SE")),
          ),
        );
      }
    })();
    return () => { alive = false; };
  }, [phone, phoneDeclined]);

  // ---- lines and payments -------------------------------------------------
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [payments, setPayments] = useState<PaymentDraft[]>([
    { key: nextKey(), method: "cash", amountInput: "", reference: "" },
  ]);
  const [startedAt, setStartedAt] = useState("");
  const [endedAt, setEndedAt] = useState("");
  const [ticketDate, setTicketDate] = useState(new Date().toLocaleDateString("sv-SE"));

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const idemKey = useRef<string>(crypto.randomUUID());

  // Warn before navigating away from unsaved work (spec §6).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function markDirty() { if (!dirty) setDirty(true); }

  function updateLine(key: number, patch: Partial<LineDraft>) {
    markDirty();
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickService(key: number, serviceId: string) {
    const price = priceBook.get(serviceId);
    updateLine(key, {
      service_id: serviceId,
      priceInput: price ? String(price.price_cents / 100) : "",
    });
  }

  // ---- derived totals -----------------------------------------------------
  // Discounts are entered as a percentage; the peso amount is computed here
  // and stored in centavos, so the books stay exact.
  function lineDiscountCents(l: LineDraft): number {
    const unit = parsePesos(l.priceInput) ?? 0;
    const pct = Number(l.discountInput || "0");
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.round((unit * l.qty * Math.min(pct, 100)) / 100);
  }
  const lineTotals = lines.map((l) => {
    const unit = parsePesos(l.priceInput) ?? 0;
    return Math.max(unit * l.qty - lineDiscountCents(l), 0);
  });
  const ticketTotal = lineTotals.reduce((a, b) => a + b, 0);
  const paymentTotal = payments.reduce((a, p) => a + (parsePesos(p.amountInput || "0") ?? 0), 0);

  // ---- validation (client-side for speed; the server is the truth) --------
  function validate(): boolean {
    const e: Record<string, string> = {};

    if (!formBranchId) e.branch = "Pick the branch this sale happened at.";

    if (!phoneDeclined) {
      if (!/^\d{11}$/.test(phone)) e.phone = "Phone number must be 11 digits.";
    }
    if (phoneDeclined && clientName.trim() === "") {
      // Walk-in with no name given (edge case 4): allowed, labelled Walk-in.
    }

    lines.forEach((l, i) => {
      const unit = parsePesos(l.priceInput);
      const pct = l.discountInput === "" ? 0 : Number(l.discountInput);
      if (!l.service_id) e[`line-${l.key}-service`] = "Pick a service.";
      if (!l.technician_id) e[`line-${l.key}-tech`] = "Pick a technician.";
      if (l.assist_technician_id && l.assist_technician_id === l.technician_id)
        e[`line-${l.key}-assist`] = "Assist must be a different person.";
      if (unit == null || unit < 0) e[`line-${l.key}-price`] = "Enter the price in pesos.";
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        e[`line-${l.key}-discount`] = "Discount must be 0 to 100 percent.";
      if (l.qty < 1) e[`line-${l.key}-qty`] = "Quantity must be at least 1.";
      void i;
    });

    if (startedAt && endedAt && endedAt < startedAt)
      e.times = "Time ended is before time started.";

    if (paymentTotal !== ticketTotal)
      e.payments = `Payments come to ${formatCentavos(paymentTotal)} but the ticket totals ${formatCentavos(ticketTotal)}.`;

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function buildPayload(): TicketPayload {
    return {
      idempotency_key: idemKey.current,
      branch_id: formBranchId,
      ticket_date: ticketDate,
      client: matched
        ? { id: matched.id }
        : phoneDeclined
          ? { phone_declined: true, full_name: clientName.trim() || undefined }
          : {
              phone,
              full_name: clientName.trim() || undefined,
              town: town.trim() || undefined,
              barangay: barangay.trim() || undefined,
              inquiry_source: inquirySource.trim() || undefined,
            },
      started_at: startedAt ? new Date(`${ticketDate}T${startedAt}`).toISOString() : undefined,
      ended_at: endedAt ? new Date(`${ticketDate}T${endedAt}`).toISOString() : undefined,
      is_new_client: isNewClient,
      lines: lines.map((l) => {
        const service = serviceById.get(l.service_id);
        const price = priceBook.get(l.service_id);
        return {
          service_id: l.service_id,
          technician_id: l.technician_id,
          assist_technician_id: l.assist_technician_id || undefined,
          qty: l.qty,
          unit_price_cents: parsePesos(l.priceInput) ?? 0,
          discount_type: l.discount_type || undefined,
          discount_cents: lineDiscountCents(l),
          // Copied at time of sale (spec §7.1): branch override, else default.
          sharing_rate: price?.sharing_rate ?? service?.default_sharing_rate ?? 0.5,
          rating: l.rating === "" ? undefined : l.rating,
          package_id: l.package_id || undefined,
        };
      }),
      payments: payments
        .filter((p) => (parsePesos(p.amountInput || "0") ?? 0) > 0 || payments.length === 1)
        .map((p) => ({
          method: p.method,
          amount_cents: parsePesos(p.amountInput || "0") ?? 0,
          reference: p.reference.trim() || undefined,
        })),
    };
  }

  async function submit() {
    setSubmitError(null);
    if (!validate()) return;
    setBusy(true);

    const payload = buildPayload();
    const clientLabel = clientName.trim() || (phoneDeclined ? "Walk-in" : phone);

    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("create_ticket", { p_payload: payload });

      if (!error && matched && matched.birth_month == null && birthMonth !== "" && birthDay !== "") {
        // Heard at the register: fill in a missing birthday on the existing
        // record. Failure here must not fail the sale.
        await supabase.rpc("set_client_birthday", {
          p_client: matched.id,
          p_month: Number(birthMonth),
          p_day: Number(birthDay),
        });
      }

      if (error) {
        // Network-ish failures queue; validation failures surface (spec §9).
        const transient =
          !navigator.onLine ||
          /fetch|network|timeout|failed to/i.test(error.message);
        if (transient) {
          await enqueueTicket(payload, {
            clientLabel,
            totalCents: ticketTotal,
            branchId: formBranchId,
          });
          setDirty(false);
          router.push("/tickets");
          return;
        }
        setSubmitError(friendlyDbError(error.message));
        setBusy(false);
        return;
      }

      setDirty(false);
      router.push("/tickets");
    } catch {
      // Complete transport failure — the queue, not an error (edge case 34).
      await enqueueTicket(payload, {
        clientLabel,
        totalCents: ticketTotal,
        branchId: formBranchId,
      });
      setDirty(false);
      router.push("/tickets");
    }
  }

  // ---- render -------------------------------------------------------------
  if (ref.status === "loading") {
    return (
      <div className="space-y-6">
        <h1 className="text-[20px] font-bold">Add ticket</h1>
        <Card><SkeletonRows rows={6} cols={4} /></Card>
      </div>
    );
  }
  if (ref.status === "error") {
    return (
      <div className="space-y-6">
        <h1 className="text-[20px] font-bold">Add ticket</h1>
        <ErrorState
          message="The service list did not load, so a ticket cannot be entered yet."
          onRetry={ref.retry}
        />
      </div>
    );
  }

  const { services, technicians } = ref.data;
  // The catalogue and roster are pinned to the branch's business — a spa
  // service or barbershop technician never appears on a salon ticket. The
  // database enforces the same rule (0009 business_mismatch guard).
  const formBusiness = branches.find((b) => b.id === formBranchId)?.business_id;
  const types = ref.data.types.filter((t) => t.business_id === formBusiness);
  const businessBranchIds = new Set(
    branches.filter((b) => b.business_id === formBusiness).map((b) => b.id),
  );
  const businessTechnicians = technicians.filter((t) => businessBranchIds.has(t.branch_id));
  const branchTechnicians = businessTechnicians.filter((t) => t.branch_id === formBranchId);
  // Technicians from the other branch may appear on this branch's tickets
  // (spec §7.1); they are listed after their own branch's people.
  const visitingTechnicians = businessTechnicians.filter((t) => t.branch_id !== formBranchId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-[20px] font-bold">Add ticket</h1>

      <Card title="Client">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Phone number"
            error={errors.phone}
            hint={phoneDeclined ? undefined : "Required. This is how visits link into one client record."}
          >
            <Input
              inputMode="numeric"
              placeholder="09XXXXXXXXX"
              value={phone}
              maxLength={11}
              disabled={phoneDeclined}
              invalid={!!errors.phone}
              onChange={(e) => {
                markDirty();
                setPhone(e.target.value.replace(/\D/g, ""));
              }}
            />
          </Field>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={phoneDeclined}
                onChange={(e) => {
                  markDirty();
                  setPhoneDeclined(e.target.checked);
                  if (e.target.checked) { setPhone(""); setMatched(null); }
                }}
              />
              Walk-in, declined to give a number
            </label>
          </div>

          {matched && (
            <div className="sm:col-span-2 rounded-[4px] bg-surface-page p-2 text-[13px]">
              Existing client: <span className="font-bold">{matched.full_name ?? matched.phone}</span>
              {matched.first_visit_on && (
                <span className="text-text-muted"> · first visit {matched.first_visit_on}</span>
              )}
              {clientPackages.length > 0 && (
                <span className="text-text-muted">
                  {" "}· {clientPackages.length} active package{clientPackages.length > 1 ? "s" : ""}
                </span>
              )}
              {matched.birth_month != null && matched.birth_day != null && (() => {
                const today = new Date();
                const bday = new Date(today.getFullYear(), matched.birth_month! - 1, matched.birth_day!);
                if (bday < today) bday.setFullYear(today.getFullYear() + 1);
                const days = Math.round((bday.getTime() - today.getTime()) / 86400000);
                return days <= 7 ? (
                  <span className="ml-2 rounded-[4px] bg-brand-red-tint px-2 py-px text-[11px] font-bold text-brand-red-deep">
                    Birthday {days === 0 ? "today" : `in ${days} day${days > 1 ? "s" : ""}`} — offer the birthday discount
                  </span>
                ) : null;
              })()}
            </div>
          )}

          <Field label="Name">
            <Input
              value={clientName}
              onChange={(e) => { markDirty(); setClientName(e.target.value); }}
              disabled={!!matched}
              placeholder={phoneDeclined ? "Walk-in" : ""}
            />
          </Field>
          <Field label="Town">
            <Input value={town} disabled={!!matched}
              onChange={(e) => { markDirty(); setTown(e.target.value); }} />
          </Field>
          <Field label="Barangay">
            <Input value={barangay} disabled={!!matched}
              onChange={(e) => { markDirty(); setBarangay(e.target.value); }} />
          </Field>
          {(!matched || matched.birth_month == null) && (
            <Field label="Birthday (optional)" hint="Month and day only — enough for the greeting and the discount">
              <div className="flex gap-2">
                <Select value={birthMonth} className="w-28" aria-label="Birth month"
                  onChange={(e) => { markDirty(); setBirthMonth(e.target.value); }}>
                  <option value="">Month</option>
                  {MONTH_SHORT.map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </Select>
                <Input inputMode="numeric" placeholder="Day" value={birthDay}
                  className="w-20" aria-label="Birth day"
                  onChange={(e) => { markDirty(); setBirthDay(e.target.value.replace(/\D/g, "").slice(0, 2)); }} />
              </div>
            </Field>
          )}
          {!matched && (
            <Field label="How did they hear about us">
              <Select value={inquirySource}
                onChange={(e) => { markDirty(); setInquirySource(e.target.value); }}>
                <option value="">—</option>
                <option>Calls</option>
                <option>Referral</option>
                <option>Social Media</option>
                <option>Walk-in</option>
                <option>Others</option>
              </Select>
            </Field>
          )}

          <div className="flex items-end pb-1 sm:col-span-2">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={isNewClient}
                onChange={(e) => { markDirty(); setIsNewClient(e.target.checked); }}
              />
              New client (first visit) — unticked means returning
            </label>
          </div>
        </div>
      </Card>

      <Card title="Services">
        <div className="space-y-4">
          {lines.map((line) => {
            const pkgOptions = clientPackages.filter((p) => p.service_id === line.service_id);
            return (
              <div key={line.key} className="rounded-[4px] border border-border p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Service" error={errors[`line-${line.key}-service`]}>
                    <Select
                      value={line.service_id}
                      invalid={!!errors[`line-${line.key}-service`]}
                      onChange={(e) => pickService(line.key, e.target.value)}
                    >
                      <option value="">—</option>
                      {types.map((t) => (
                        <optgroup key={t.id} label={t.name}>
                          {services
                            .filter((s) => s.service_type_id === t.id)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                                {priceBook.has(s.id)
                                  ? ` — ${formatCentavos(priceBook.get(s.id)!.price_cents)}`
                                  : " — not offered here"}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Technician" error={errors[`line-${line.key}-tech`]}>
                    <Select
                      value={line.technician_id}
                      invalid={!!errors[`line-${line.key}-tech`]}
                      onChange={(e) => updateLine(line.key, { technician_id: e.target.value })}
                    >
                      <option value="">—</option>
                      {branchTechnicians.map((t) => (
                        <option key={t.id} value={t.id}>{t.full_name}</option>
                      ))}
                      {visitingTechnicians.length > 0 && (
                        <optgroup label="Other branch">
                          {visitingTechnicians.map((t) => (
                            <option key={t.id} value={t.id}>{t.full_name}</option>
                          ))}
                        </optgroup>
                      )}
                    </Select>
                  </Field>
                  <Field label="Assist (optional)" error={errors[`line-${line.key}-assist`]}>
                    <Select
                      value={line.assist_technician_id}
                      invalid={!!errors[`line-${line.key}-assist`]}
                      onChange={(e) => updateLine(line.key, { assist_technician_id: e.target.value })}
                    >
                      <option value="">—</option>
                      {[...branchTechnicians, ...visitingTechnicians]
                        .filter((t) => t.id !== line.technician_id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>{t.full_name}</option>
                        ))}
                    </Select>
                  </Field>

                  <Field label="Qty" error={errors[`line-${line.key}-qty`]}>
                    <Input
                      type="number" min={1} value={line.qty}
                      invalid={!!errors[`line-${line.key}-qty`]}
                      onChange={(e) => updateLine(line.key, { qty: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </Field>
                  <Field label="Price (₱)" error={errors[`line-${line.key}-price`]}>
                    <Input
                      inputMode="decimal" value={line.priceInput}
                      invalid={!!errors[`line-${line.key}-price`]}
                      onChange={(e) => updateLine(line.key, { priceInput: e.target.value })}
                    />
                  </Field>
                  <Field label="Rating (optional)">
                    <Select
                      value={line.rating === "" ? "" : String(line.rating)}
                      onChange={(e) =>
                        updateLine(line.key, {
                          rating: e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">Not given</option>
                      {[5, 4, 3, 2, 1].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Discount type">
                    <Select
                      value={line.discount_type}
                      onChange={(e) =>
                        updateLine(line.key, { discount_type: e.target.value as LineDraft["discount_type"] })
                      }
                    >
                      <option value="">None</option>
                      <option value="birthday">Birthday</option>
                      <option value="senior">Senior</option>
                      <option value="pwd">PWD</option>
                      <option value="staff">Staff</option>
                      <option value="promo">Promo</option>
                      <option value="negotiated">Negotiated</option>
                      <option value="package">Package</option>
                    </Select>
                  </Field>
                  <Field
                    label="Discount (%)"
                    error={errors[`line-${line.key}-discount`]}
                    hint={lineDiscountCents(line) > 0
                      ? `− ${formatCentavos(lineDiscountCents(line))}`
                      : undefined}
                  >
                    <Input
                      inputMode="decimal" value={line.discountInput}
                      invalid={!!errors[`line-${line.key}-discount`]}
                      onChange={(e) => updateLine(line.key, { discountInput: e.target.value })}
                    />
                  </Field>
                  {pkgOptions.length > 0 ? (
                    <Field label="Redeem package session" hint="Sets the line to zero via a package discount">
                      <Select
                        value={line.package_id}
                        onChange={(e) => {
                          const pkg = pkgOptions.find((p) => p.id === e.target.value);
                          updateLine(line.key, {
                            package_id: e.target.value,
                            ...(pkg
                              ? { discount_type: "package" as const, discountInput: "100" }
                              : {}),
                          });
                        }}
                      >
                        <option value="">No</option>
                        {pkgOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.services.name} ({p.sessions_total - p.sessions_used} left)
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <div />
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <span className="text-[15px] font-bold tnum">
                    Sub-total {formatCentavos(lineTotals[lines.indexOf(line)])}
                  </span>
                  {lines.length > 1 && (
                    <button
                      className="flex items-center gap-1 text-[11px] text-brand-red hover:underline"
                      onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 size={16} aria-hidden /> Remove line
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <Button onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            <Plus size={16} aria-hidden /> Add service
          </Button>
        </div>
      </Card>

      <Card title="Time and payment">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Date" hint="Backdating is allowed until that day's cash is closed">
            <Input
              type="date" value={ticketDate}
              max={new Date().toLocaleDateString("sv-SE")}
              onChange={(e) => { markDirty(); setTicketDate(e.target.value); }}
            />
          </Field>
          <Field label="Time started" error={errors.times}>
            <Input type="time" value={startedAt}
              onChange={(e) => { markDirty(); setStartedAt(e.target.value); }} />
          </Field>
          <Field label="Time ended">
            <Input type="time" value={endedAt}
              onChange={(e) => { markDirty(); setEndedAt(e.target.value); }} />
          </Field>
        </div>

        <div className="mt-4 flex items-baseline justify-between border-y border-border py-2">
          <span className="text-[15px] font-bold">Total</span>
          <span className="text-[15px] font-bold tnum">{formatCentavos(ticketTotal)}</span>
        </div>

        <div className="mt-4 space-y-2">
          {payments.map((p) => (
            <div key={p.key} className="flex items-end gap-4">
              <Field label="Method">
                <Select
                  value={p.method}
                  onChange={(e) => {
                    markDirty();
                    setPayments((ps) =>
                      ps.map((x) => x.key === p.key ? { ...x, method: e.target.value as PaymentMethod } : x));
                  }}
                >
                  <option value="cash">Cash</option>
                  <option value="gcash">GCash</option>
                  <option value="maya">Maya</option>
                  <option value="bank">Bank transfer</option>
                  <option value="card">Card</option>
                  <option value="gift_cert">Gift cert</option>
                  <option value="package">Package</option>
                  <option value="comp">Comp</option>
                </Select>
              </Field>
              <Field label="Amount (₱)">
                <Input
                  inputMode="decimal" value={p.amountInput}
                  onChange={(e) => {
                    markDirty();
                    setPayments((ps) =>
                      ps.map((x) => x.key === p.key ? { ...x, amountInput: e.target.value } : x));
                  }}
                />
              </Field>
              {p.method !== "cash" && p.method !== "package" && p.method !== "comp" && (
                <Field label="Reference">
                  <Input
                    value={p.reference}
                    onChange={(e) =>
                      setPayments((ps) =>
                        ps.map((x) => x.key === p.key ? { ...x, reference: e.target.value } : x))
                    }
                  />
                </Field>
              )}
              {payments.length > 1 && (
                <button
                  aria-label="Remove payment"
                  className="mb-1 text-brand-red"
                  onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))}
                >
                  <Trash2 size={20} aria-hidden />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-4">
            <Button
              onClick={() =>
                setPayments((ps) => [...ps, { key: nextKey(), method: "gcash", amountInput: "", reference: "" }])
              }
            >
              <Plus size={16} aria-hidden /> Split payment
            </Button>
            <Button
              onClick={() =>
                setPayments((ps) =>
                  ps.length === 1
                    ? [{ ...ps[0], amountInput: String(ticketTotal / 100) }]
                    : ps)
              }
            >
              Exact amount
            </Button>
          </div>
          {errors.payments && (
            <p className="text-[11px] text-brand-red">{errors.payments}</p>
          )}
        </div>
      </Card>

      {errors.branch && <ErrorState message={errors.branch} />}
      {branchId === null && (
        <Card title="Branch">
          <Select value={formBranchId} onChange={(e) => setFormBranchId(e.target.value)}>
            <option value="">—</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Card>
      )}

      {submitError && <ErrorState message={submitError} />}

      <div className="flex items-center justify-between">
        <span className="text-[15px] font-bold tnum" data-stat>
          Total {formatCentavos(ticketTotal)}
        </span>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              if (!dirty || confirm("Leave without saving this ticket?")) router.push("/tickets");
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" busy={busy} busyLabel="Saving" onClick={() => void submit()}>
            Save ticket
          </Button>
        </div>
      </div>
    </div>
  );
}

function friendlyDbError(message: string): string {
  if (/phone/i.test(message)) return "A phone number is required, or mark the client as walk-in.";
  if (/closed/i.test(message)) return "That day's cash is already closed. Reopen the day first.";
  if (/package.*expired/i.test(message)) return "That package has expired.";
  if (/no sessions left|exhausted/i.test(message)) return "That package has no sessions left.";
  if (/no longer offered/i.test(message)) return "One of the services is no longer offered.";
  if (/no longer active/i.test(message)) return "One of the technicians is no longer active.";
  if (/future/i.test(message)) return "The ticket date is in the future.";
  if (/access to that branch/i.test(message)) return "This account cannot enter tickets for that branch.";
  if (/Payments total/i.test(message)) return "Payments do not add up to the ticket total.";
  return "The ticket was not saved. Check the entries and try again.";
}
