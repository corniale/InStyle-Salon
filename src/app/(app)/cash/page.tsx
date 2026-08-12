"use client";

// Daily cash (spec §2): takings, petty cash expenses, running balance and
// end-of-day reconciliation. Expected cash is computed server-side, never
// stored; a non-zero variance requires a note before close (edge case 21);
// a closed day locks its takings (edge case 12); reopening is manager+.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Stat, Table, Td, Th, Textarea, Truncate,
} from "@/components/ui";

interface DailyCashRow {
  branch_id: string;
  business_date: string;
  opening_float_cents: number;
  cash_takings_cents: number;
  non_cash_takings_cents: number;
  cash_expenses_cents: number;
  expenses_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number | null;
  variance_cents: number | null;
  closed_at: string | null;
  note: string | null;
}

interface ExpenseRow {
  id: string;
  spent_on: string;
  category: string;
  amount_cents: number;
  description: string | null;
  paid_from: string;
}

function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export default function CashPage() {
  const { branchId, branches, profile, isManagerUp } = useSession();
  // Cash is inherently per-branch; owner on consolidated picks one.
  const [pickedBranch, setPickedBranch] = useState(branchId ?? profile.branch_id ?? branches[0]?.id ?? "");
  const effectiveBranch = branchId ?? pickedBranch;
  const [date, setDate] = useState(todayISO());
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);

  const q = useQuery(async () => {
    const supabase = createClient();
    const [day, expenses] = await Promise.all([
      supabase
        .from("v_daily_cash")
        .select("*")
        .eq("branch_id", effectiveBranch)
        .eq("business_date", date)
        .maybeSingle(),
      supabase
        .from("expenses")
        .select("id, spent_on, category, amount_cents, description, paid_from")
        .eq("branch_id", effectiveBranch)
        .eq("spent_on", date)
        .order("created_at", { ascending: false }),
    ]);
    if (day.error) throw new Error(day.error.message);
    return {
      day: (day.data ?? null) as DailyCashRow | null,
      expenses: unwrap(expenses) as ExpenseRow[],
    };
  }, [effectiveBranch, date]);

  async function reopen() {
    setReopenBusy(true);
    await createClient().rpc("reopen_cash_day", { p_branch: effectiveBranch, p_date: date });
    setReopenBusy(false);
    q.retry();
  }

  const day = q.status === "ready" ? q.data.day : null;
  const closed = day?.closed_at != null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Daily cash</h1>
        <div className="flex items-center gap-2">
          {branchId === null && (
            <Select
              value={pickedBranch}
              onChange={(e) => setPickedBranch(e.target.value)}
              className="w-40"
              aria-label="Branch"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          )}
          <Input type="date" value={date} max={todayISO()}
            onChange={(e) => setDate(e.target.value)} className="w-40" aria-label="Date" />
        </div>
      </div>

      <Card>
        {q.status === "loading" && <SkeletonRows rows={2} cols={5} />}
        {q.status === "error" && <ErrorState message="The cash day did not load." onRetry={q.retry} />}
        {q.status === "ready" && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Opening float" value={formatCentavos(day?.opening_float_cents ?? 0)} />
              <Stat label="Cash takings" value={formatCentavos(day?.cash_takings_cents ?? 0)} />
              <Stat label="Cash expenses" value={formatCentavos(day?.cash_expenses_cents ?? 0)} />
              <Stat label="Expected in drawer" value={formatCentavos(day?.expected_cash_cents ?? 0)} hero />
              <Stat
                label={closed ? "Variance at close" : "Counted"}
                value={
                  day?.counted_cash_cents != null
                    ? closed
                      ? formatCentavos(day.variance_cents)
                      : formatCentavos(day.counted_cash_cents)
                    : "—"
                }
                tone={
                  closed && day?.variance_cents != null && day.variance_cents !== 0
                    ? "negative"
                    : closed ? "positive" : undefined
                }
              />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[11px] text-text-muted">
                {closed ? (
                  <>
                    Day closed{day?.note ? ` — note: ${day.note}` : ""}. Tickets and expenses for
                    this day are locked.
                  </>
                ) : (
                  <>Non-cash takings today: {formatCentavos(day?.non_cash_takings_cents ?? 0)}</>
                )}
              </div>
              {closed ? (
                isManagerUp && (
                  <Button busy={reopenBusy} busyLabel="Reopening" onClick={() => void reopen()}>
                    Reopen day
                  </Button>
                )
              ) : (
                <Button variant="primary" onClick={() => setCloseOpen(true)}>
                  Close the day
                </Button>
              )}
            </div>
          </>
        )}
      </Card>

      <TechnicianEarningsCard branchId={effectiveBranch} date={date} />

      <ExpensesCard
        branchId={effectiveBranch}
        date={date}
        locked={closed}
        expenses={q.status === "ready" ? q.data.expenses : null}
        error={q.status === "error"}
        onChanged={q.retry}
      />

      <CloseModal
        open={closeOpen}
        branchId={effectiveBranch}
        date={date}
        expected={day?.expected_cash_cents ?? 0}
        onClose={() => setCloseOpen(false)}
        onDone={() => { setCloseOpen(false); q.retry(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ExpensesCard({ branchId, date, locked, expenses, error, onChanged }: {
  branchId: string;
  date: string;
  locked: boolean;
  expenses: ExpenseRow[] | null;
  error: boolean;
  onChanged: () => void;
}) {
  const [category, setCategory] = useState("supplies");
  const [amountInput, setAmountInput] = useState("");
  const [description, setDescription] = useState("");
  const [paidFrom, setPaidFrom] = useState<"cash" | "bank">("cash");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addExpense() {
    const cents = parsePesos(amountInput);
    if (cents == null || cents <= 0) {
      setFieldError("Enter the amount in pesos.");
      return;
    }
    setBusy(true);
    setFieldError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("expenses").insert({
      branch_id: branchId,
      spent_on: date,
      category,
      amount_cents: cents,
      description: description.trim() || null,
      paid_from: paidFrom,
      recorded_by: user?.id,
    });
    setBusy(false);
    if (error) {
      setFieldError(
        /closed/i.test(error.message)
          ? "This day is closed. Reopen it before adding expenses."
          : "The expense was not saved. Try again.",
      );
      return;
    }
    setAmountInput("");
    setDescription("");
    onChanged();
  }

  return (
    <Card title="Petty cash expenses">
      {!locked && (
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-44">
              <option value="supplies">Supplies</option>
              <option value="utilities">Utilities</option>
              <option value="food">Food</option>
              <option value="transport">Transport</option>
              <option value="maintenance">Maintenance</option>
              <option value="withdrawal">Withdrawal / bank deposit</option>
              <option value="allowance">Staff allowance / sahod</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Amount (₱)" error={fieldError ?? undefined}>
            <Input inputMode="decimal" value={amountInput} className="w-32"
              invalid={!!fieldError}
              onChange={(e) => setAmountInput(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input value={description} className="w-64"
              onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Paid from">
            <Select value={paidFrom} className="w-28"
              onChange={(e) => setPaidFrom(e.target.value as "cash" | "bank")}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </Select>
          </Field>
          <Button variant="primary" busy={busy} busyLabel="Adding" onClick={() => void addExpense()}>
            Add expense
          </Button>
        </div>
      )}

      {error && <ErrorState message="Expenses did not load." />}
      {expenses == null && !error && <SkeletonRows rows={3} cols={4} />}
      {expenses != null && expenses.length === 0 && (
        <EmptyState message="No expenses recorded this day." />
      )}
      {expenses != null && expenses.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Category</Th>
              <Th>Description</Th>
              <Th>Paid from</Th>
              <Th align="right">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id}>
                <Td>{e.category}</Td>
                <Td><Truncate text={e.description ?? "—"} max={48} /></Td>
                <Td>{e.paid_from}</Td>
                <Td align="right" className="tnum">{formatCentavos(e.amount_cents)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CloseModal({ open, branchId, date, expected, onClose, onDone }: {
  open: boolean;
  branchId: string;
  date: string;
  expected: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [countedInput, setCountedInput] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const counted = parsePesos(countedInput);
  const variance = counted != null ? counted - expected : null;

  async function confirmClose() {
    if (counted == null) {
      setError("Count the drawer and enter the amount in pesos.");
      return;
    }
    if (variance !== 0 && note.trim() === "") {
      setError("There is a variance, so a note is required before closing.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("close_cash_day", {
      p_branch: branchId,
      p_date: date,
      p_counted_cents: counted,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError("The day did not close. Check the count and try again.");
      return;
    }
    setCountedInput("");
    setNote("");
    onDone();
  }

  return (
    <Modal title={`Close ${date}`} open={open} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-[4px] bg-surface-page p-2 text-[13px] tnum">
          Expected in drawer: <span className="font-bold">{formatCentavos(expected)}</span>
        </div>

        <Field label="Counted cash (₱)" error={error ?? undefined}>
          <Input inputMode="decimal" value={countedInput} autoFocus
            invalid={!!error}
            onChange={(e) => setCountedInput(e.target.value)} />
        </Field>

        {variance != null && (
          <p className={`text-[13px] tnum ${variance === 0 ? "text-data-teal" : "text-brand-red"}`}>
            {variance === 0
              ? "Drawer matches."
              : `Variance: ${formatCentavos(variance)} (${variance > 0 ? "over" : "short"})`}
          </p>
        )}

        {variance != null && variance !== 0 && (
          <Field label="Variance note (required)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Closing" onClick={() => void confirmClose()}>
            Close the day
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Technician earnings for the day — the payout grid from the salon's
// "Daily Record" sheet. Company share and technician share per person, so
// payday needs no side spreadsheet. Payroll itself stays a non-goal.
// ---------------------------------------------------------------------------

interface EarningsRow {
  technician_name: string;
  lines: number;
  treatments: number;
  revenue_cents: number;
  company_share_cents: number;
  technician_share_cents: number;
}

function TechnicianEarningsCard({ branchId, date }: { branchId: string; date: string }) {
  const q = useQuery(async () => {
    const res = await createClient()
      .from("v_ticket_lines_active")
      .select("technician_name, qty, total_cents, company_share_cents, technician_share_cents")
      .eq("branch_id", branchId)
      .eq("ticket_date", date);
    const lines = unwrap(res) as Array<{
      technician_name: string;
      qty: number;
      total_cents: number;
      company_share_cents: number;
      technician_share_cents: number;
    }>;
    const byTech = new Map<string, EarningsRow>();
    for (const l of lines) {
      const row = byTech.get(l.technician_name) ?? {
        technician_name: l.technician_name,
        lines: 0, treatments: 0, revenue_cents: 0,
        company_share_cents: 0, technician_share_cents: 0,
      };
      row.lines += 1;
      row.treatments += l.qty;
      row.revenue_cents += l.total_cents;
      row.company_share_cents += l.company_share_cents;
      row.technician_share_cents += l.technician_share_cents;
      byTech.set(l.technician_name, row);
    }
    return [...byTech.values()].sort(
      (a, b) => b.technician_share_cents - a.technician_share_cents,
    );
  }, [branchId, date]);

  return (
    <Card title="Technician earnings">
      {q.status === "loading" && <SkeletonRows rows={4} cols={5} />}
      {q.status === "error" && (
        <ErrorState message="Technician earnings did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && q.data.length === 0 && (
        <EmptyState message="No services recorded this day." />
      )}
      {q.status === "ready" && q.data.length > 0 && (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Technician</Th>
                <Th align="right">Treatments</Th>
                <Th align="right">Gross</Th>
                <Th align="right">Company share</Th>
                <Th align="right">Technician share</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.technician_name}>
                  <Td className="font-bold"><Truncate text={r.technician_name} /></Td>
                  <Td align="right" className="tnum">{r.treatments}</Td>
                  <Td align="right" className="tnum">{formatCentavos(r.revenue_cents)}</Td>
                  <Td align="right" className="tnum">{formatCentavos(r.company_share_cents)}</Td>
                  <Td align="right" className="tnum font-bold">
                    {formatCentavos(r.technician_share_cents)}
                  </Td>
                </tr>
              ))}
              <tr>
                <Td className="font-bold">Total</Td>
                <Td align="right" className="tnum font-bold">
                  {q.data.reduce((s, r) => s + r.treatments, 0)}
                </Td>
                <Td align="right" className="tnum font-bold">
                  {formatCentavos(q.data.reduce((s, r) => s + r.revenue_cents, 0))}
                </Td>
                <Td align="right" className="tnum font-bold">
                  {formatCentavos(q.data.reduce((s, r) => s + r.company_share_cents, 0))}
                </Td>
                <Td align="right" className="tnum font-bold">
                  {formatCentavos(q.data.reduce((s, r) => s + r.technician_share_cents, 0))}
                </Td>
              </tr>
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-text-muted">
            Shares as recorded on each service line. Assist (banlaw) hand-offs between staff are
            settled between them and not deducted here.
          </p>
        </>
      )}
    </Card>
  );
}
