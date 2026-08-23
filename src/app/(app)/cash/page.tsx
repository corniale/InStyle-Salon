"use client";

// Daily cash (spec §2): the paper Daily Record's statement — gross sales,
// technician shares paid from the drawer, non-cash payments straight to the
// account, expenses/withdrawals, down to net cash to remit. Expected cash is
// computed server-side, never stored; a non-zero variance requires a note
// before close (edge case 21); a closed day locks its takings (edge case 12);
// reopening is manager+.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { formatCentavos, parsePesos } from "@/lib/money";
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select,
  SkeletonRows, Stat, Table, Td, Th, Textarea, Truncate, useSort,
} from "@/components/ui";
import { PeriodPicker, periodPreset, type Period } from "@/components/period-picker";
import { csvPesos, downloadCsv } from "@/lib/csv";
import { Pagination } from "@/components/client-bits";

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
  gross_sales_cents: number;
  technician_share_cents: number;
  company_share_cents: number;
  discounts_cents: number;
  gcash_takings_cents: number;
  maya_takings_cents: number;
  bank_card_takings_cents: number;
  package_comp_cents: number;
  gift_cert_cents: number;
}

interface ExpenseRow {
  id: string;
  spent_on: string;
  category: string;
  amount_cents: number;
  description: string | null;
  paid_from: string;
}

export default function CashPage() {
  const { branchId, branches, isAdminUp } = useSession();
  const [period, setPeriod] = useState<Period>(periodPreset("today"));

  // The header's branch switcher is the only branch filter. "All" shows each
  // branch's drawer as its own section — two physical drawers cannot be
  // reconciled as one. A multi-day period totals the statement; closing a
  // drawer stays a single-day act.
  const shown = branchId ? branches.filter((b) => b.id === branchId) : branches;
  const single = period.from === period.to;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  // One row per branch-day, every statement line as a column — the same
  // math the cards show, ready for a spreadsheet. Paged past the 1,000-row
  // response cap (a large .limit() would be clamped to it server-side).
  async function exportCsv() {
    setExporting(true);
    setExportError(false);
    try {
      const supabase = createClient();
      const PAGE = 1000;
      const days: DailyCashRow[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const res = await supabase
          .from("v_daily_cash")
          .select("*")
          .in("branch_id", shown.map((b) => b.id))
          .gte("business_date", period.from)
          .lte("business_date", period.to)
          .order("business_date", { ascending: true })
          .order("branch_id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        const chunk = unwrap(res) as DailyCashRow[];
        days.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      const name = new Map(shown.map((b) => [b.id, b.name]));
      downloadCsv(
        `daily-cash-${period.from}-to-${period.to}.csv`,
        ["Branch", "Date", "Opening balance", "Gross sales", "Technician share",
         "Company share", "Cash takings", "GCash", "Maya", "Bank/card",
         "Package/comp", "Gift certificates", "Cash expenses & deductions",
         "Discounts given", "Net cash to remit", "Counted", "Variance", "Closed"],
        days.map((d) => [
          name.get(d.branch_id) ?? d.branch_id,
          d.business_date,
          csvPesos(d.opening_float_cents),
          csvPesos(d.gross_sales_cents),
          csvPesos(d.technician_share_cents),
          csvPesos(d.company_share_cents),
          csvPesos(d.cash_takings_cents),
          csvPesos(d.gcash_takings_cents),
          csvPesos(d.maya_takings_cents),
          csvPesos(d.bank_card_takings_cents),
          csvPesos(d.package_comp_cents),
          csvPesos(d.gift_cert_cents),
          csvPesos(d.cash_expenses_cents),
          csvPesos(d.discounts_cents),
          csvPesos(d.expected_cash_cents),
          csvPesos(d.counted_cash_cents),
          csvPesos(d.variance_cents),
          d.closed_at != null ? "yes" : "",
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
        <h1 className="text-[20px] font-bold">Daily cash</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <PeriodPicker value={period} onChange={setPeriod} />
          {isAdminUp && (
            <>
              {exportError && (
                <span className="text-[11px] text-brand-red">Export failed — try again.</span>
              )}
              <Button busy={exporting} busyLabel="Exporting" onClick={() => void exportCsv()}>
                Export CSV
              </Button>
            </>
          )}
        </div>
      </div>

      {shown.length === 0 && (
        <EmptyState message="No branch is visible to this account." />
      )}
      {shown.map((b) => (
        <BranchCashSection
          key={b.id}
          branchId={b.id}
          branchName={b.name}
          showName={shown.length > 1}
          from={period.from}
          to={period.to}
          single={single}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Sum the statement fields of several days into one synthetic row. */
function aggregateDays(rows: DailyCashRow[]): DailyCashRow | null {
  if (rows.length === 0) return null;
  const sum = (f: (r: DailyCashRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    ...rows[0],
    opening_float_cents: sum((r) => r.opening_float_cents),
    cash_takings_cents: sum((r) => r.cash_takings_cents),
    non_cash_takings_cents: sum((r) => r.non_cash_takings_cents),
    cash_expenses_cents: sum((r) => r.cash_expenses_cents),
    expenses_cents: sum((r) => r.expenses_cents),
    expected_cash_cents: sum((r) => r.expected_cash_cents),
    counted_cash_cents: null,
    variance_cents: null,
    closed_at: null,
    note: null,
    gross_sales_cents: sum((r) => r.gross_sales_cents),
    technician_share_cents: sum((r) => r.technician_share_cents),
    company_share_cents: sum((r) => r.company_share_cents),
    discounts_cents: sum((r) => r.discounts_cents),
    gcash_takings_cents: sum((r) => r.gcash_takings_cents),
    maya_takings_cents: sum((r) => r.maya_takings_cents),
    bank_card_takings_cents: sum((r) => r.bank_card_takings_cents),
    package_comp_cents: sum((r) => r.package_comp_cents),
    gift_cert_cents: sum((r) => r.gift_cert_cents),
  };
}

function BranchCashSection({ branchId, branchName, showName, from, to, single }: {
  branchId: string;
  branchName: string;
  showName: boolean;
  from: string;
  to: string;
  single: boolean;
}) {
  const { isManagerUp } = useSession();
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState(false);

  const q = useQuery(async () => {
    const supabase = createClient();
    // A YTD period can exceed the 1,000-row response cap, and the card's
    // Total sums every row — page through so nothing is silently dropped.
    // Runs in parallel with the statement query: the headline numbers must
    // never wait on the expense list.
    async function fetchExpenses(): Promise<ExpenseRow[]> {
      const PAGE = 1000;
      const all: ExpenseRow[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const res = await supabase
          .from("expenses")
          .select("id, spent_on, category, amount_cents, description, paid_from")
          .eq("branch_id", branchId)
          .gte("spent_on", from)
          .lte("spent_on", to)
          .order("spent_on", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        const chunk = unwrap(res) as ExpenseRow[];
        all.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      return all;
    }
    const [days, expenses] = await Promise.all([
      supabase
        .from("v_daily_cash")
        .select("*")
        .eq("branch_id", branchId)
        .gte("business_date", from)
        .lte("business_date", to)
        .order("business_date", { ascending: true }),
      fetchExpenses(),
    ]);
    const rows = unwrap(days) as DailyCashRow[];
    return {
      day: single ? (rows[0] ?? null) : aggregateDays(rows),
      dayCount: rows.length,
      expenses,
    };
  }, [branchId, from, to, single]);

  async function reopen() {
    setReopenBusy(true);
    setReopenError(false);
    const { error } = await createClient()
      .rpc("reopen_cash_day", { p_branch: branchId, p_date: from });
    setReopenBusy(false);
    if (error) {
      setReopenError(true);
      return;
    }
    q.retry();
  }

  const day = q.status === "ready" ? q.data.day : null;
  const closed = single && day?.closed_at != null;

  return (
    <div className="space-y-6">
      {showName && (
        <h2 className="text-[15px] font-bold">{branchName}</h2>
      )}

      <Card>
        {q.status === "loading" && <SkeletonRows rows={2} cols={5} />}
        {q.status === "error" && <ErrorState message="The cash day did not load." onRetry={q.retry} />}
        {q.status === "ready" && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Gross sales" value={formatCentavos(day?.gross_sales_cents ?? 0)} />
              <Stat label="Company share" value={formatCentavos(day?.company_share_cents ?? 0)} />
              <Stat label="Net cash to remit" value={formatCentavos(day?.expected_cash_cents ?? 0)} hero />
              {single ? (
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
              ) : (
                <Stat label="Days with activity"
                  value={String(q.status === "ready" ? q.data.dayCount : 0)} />
              )}
            </div>

            <div className="mt-4 max-w-xl space-y-1 text-[13px]">
              {single && !closed ? (
                <OpeningBalanceEditor
                  branchId={branchId}
                  date={from}
                  cents={day?.opening_float_cents ?? 0}
                  onSaved={q.retry}
                />
              ) : (
                <StmtRow label="Opening balance (change fund)"
                  cents={day?.opening_float_cents ?? 0} />
              )}
              <StmtRow label="Gross sales" cents={day?.gross_sales_cents ?? 0} />
              <StmtRow label="Technician share (paid from drawer)"
                cents={day?.technician_share_cents ?? 0} negative />
              <StmtRow label="Company share" cents={day?.company_share_cents ?? 0} bold top />
              <StmtRow label="GCash payments (straight to account)"
                cents={day?.gcash_takings_cents ?? 0} negative />
              <StmtRow label="Maya payments (straight to account)"
                cents={day?.maya_takings_cents ?? 0} negative />
              {(day?.bank_card_takings_cents ?? 0) !== 0 && (
                <StmtRow label="Bank / card (straight to account)"
                  cents={day?.bank_card_takings_cents ?? 0} negative />
              )}
              {(day?.package_comp_cents ?? 0) !== 0 && (
                <StmtRow label="Package / comp (no cash received)"
                  cents={day?.package_comp_cents ?? 0} negative />
              )}
              {(day?.gift_cert_cents ?? 0) !== 0 && (
                <StmtRow label="Gift certificates (no cash received)"
                  cents={day?.gift_cert_cents ?? 0} negative />
              )}
              <StmtRow label="Cash expenses & deductions"
                cents={day?.cash_expenses_cents ?? 0} negative />
              <StmtRow label="Net cash to remit" cents={day?.expected_cash_cents ?? 0} bold top />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[11px] text-text-muted">
                {!single ? (
                  <>
                    Totals across the period. Pick a single date to count and close a drawer.
                    {(day?.discounts_cents ?? 0) > 0 &&
                      ` Discounts given: ${formatCentavos(day?.discounts_cents ?? 0)} (already off gross).`}
                  </>
                ) : closed ? (
                  <>
                    Day closed{day?.note ? ` — note: ${day.note}` : ""}. Tickets and expenses for
                    this day are locked.
                  </>
                ) : (
                  <>
                    Record withdrawals, parcels and sahod under Cash expenses &amp; deductions so
                    they are deducted here.
                    {(day?.discounts_cents ?? 0) > 0 &&
                      ` Discounts given today: ${formatCentavos(day?.discounts_cents ?? 0)} (already off gross).`}
                  </>
                )}
              </div>
              {single && (closed ? (
                isManagerUp && (
                  <span className="flex items-center gap-2">
                    {reopenError && (
                      <span className="text-[11px] text-brand-red">
                        The day did not reopen. Try again.
                      </span>
                    )}
                    <Button busy={reopenBusy} busyLabel="Reopening" onClick={() => void reopen()}>
                      Reopen day
                    </Button>
                  </span>
                )
              ) : (
                <Button variant="primary" onClick={() => setCloseOpen(true)}>
                  Close the day
                </Button>
              ))}
            </div>
          </>
        )}
      </Card>

      <TechnicianEarningsCard branchId={branchId} from={from} to={to} />

      <ExpensesCard
        branchId={branchId}
        date={from}
        single={single}
        locked={closed}
        expenses={q.status === "ready" ? q.data.expenses : null}
        error={q.status === "error"}
        onChanged={q.retry}
      />

      <CloseModal
        open={closeOpen}
        branchId={branchId}
        date={from}
        expected={day?.expected_cash_cents ?? 0}
        onClose={() => setCloseOpen(false)}
        onDone={() => { setCloseOpen(false); q.retry(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The change fund the drawer starts the day with. Editable until the day is
// closed; part of expected cash, so the net line moves as it is saved.
// ---------------------------------------------------------------------------

function OpeningBalanceEditor({ branchId, date, cents, onSaved }: {
  branchId: string;
  date: string;
  cents: number;
  onSaved: () => void;
}) {
  const [input, setInput] = useState("");
  const [loadedFor, setLoadedFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const key = `${branchId}:${date}:${cents}`;
  if (loadedFor !== key) {
    setInput(String(cents / 100));
    setLoadedFor(key);
    setInvalid(false);
  }

  async function save() {
    const v = parsePesos(input);
    if (v == null || v < 0) { setInvalid(true); return; }
    setBusy(true);
    setInvalid(false);
    const { error } = await createClient().from("cash_days").upsert(
      { branch_id: branchId, business_date: date, opening_float_cents: v },
      { onConflict: "branch_id,business_date" },
    );
    setBusy(false);
    if (error) { setInvalid(true); return; }
    onSaved();
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="whitespace-nowrap text-text-muted">Opening balance (change fund)</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="w-24 shrink-0">
          <Input
            inputMode="decimal"
            value={input}
            invalid={invalid}
            className="h-7 text-right tnum"
            aria-label="Opening balance in pesos"
            onChange={(e) => setInput(e.target.value)}
          />
        </span>
        <Button busy={busy} busyLabel="Saving" onClick={() => void save()}>Save</Button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One line of the Daily Record statement: opening balance → gross → labor →
// company share → non-cash payments → expenses → net cash to remit.
// ---------------------------------------------------------------------------

function StmtRow({ label, cents, negative, bold, top }: {
  label: string;
  cents: number;
  negative?: boolean;
  bold?: boolean;
  top?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4${top ? " border-t border-border pt-1" : ""}`}>
      <span className={bold ? "font-bold" : "text-text-muted"}>{label}</span>
      <span className={`tnum${bold ? " font-bold" : ""}`}>
        {formatCentavos(negative && cents !== 0 ? -cents : cents)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EXPENSE_ACC: Record<string, (e: ExpenseRow) => unknown> = {
  date: (e) => e.spent_on,
  category: (e) => e.category,
  description: (e) => e.description,
  paid: (e) => e.paid_from,
  amount: (e) => e.amount_cents,
};

function ExpensesCard({ branchId, date, single, locked, expenses, error, onChanged }: {
  branchId: string;
  date: string;
  single: boolean;
  locked: boolean;
  expenses: ExpenseRow[] | null;
  error: boolean;
  onChanged: () => void;
}) {
  const { profile } = useSession();
  const { rows: sortedExpenses, th } = useSort(expenses, EXPENSE_ACC);
  // Month/YTD views can hold hundreds of expense lines — page them at 50.
  const EXPENSES_PAGE = 50;
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [expenses]);
  const pagedExpenses =
    sortedExpenses?.slice(page * EXPENSES_PAGE, page * EXPENSES_PAGE + EXPENSES_PAGE) ?? null;
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
    // recorded_by comes from the session context — an auth.getUser() here
    // would cost a full network round trip before the insert even starts.
    const { error } = await createClient().from("expenses").insert({
      branch_id: branchId,
      spent_on: date,
      category,
      amount_cents: cents,
      description: description.trim() || null,
      paid_from: paidFrom,
      recorded_by: profile.id,
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
    <Card title="Cash expenses & deductions">
      {single && !locked && (
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
        <EmptyState message={single
          ? "No expenses recorded this day."
          : "No expenses recorded in this period."} />
      )}
      {sortedExpenses != null && sortedExpenses.length > 0 && (
        <Table>
          <thead>
            <tr>
              {!single && <Th {...th("date")}>Date</Th>}
              <Th {...th("category")}>Category</Th>
              <Th {...th("description")}>Description</Th>
              <Th {...th("paid")}>Paid from</Th>
              <Th align="right" {...th("amount")}>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {(pagedExpenses ?? []).map((e) => (
              <tr key={e.id}>
                {!single && <Td className="tnum">{e.spent_on}</Td>}
                <Td>{e.category}</Td>
                <Td><Truncate text={e.description ?? "—"} max={48} /></Td>
                <Td>{e.paid_from}</Td>
                <Td align="right" className="tnum">{formatCentavos(e.amount_cents)}</Td>
              </tr>
            ))}
            {!single && (
              <tr>
                <Td className="font-bold" colSpan={4}>Total</Td>
                <Td align="right" className="tnum font-bold">
                  {formatCentavos(sortedExpenses.reduce((s, e) => s + e.amount_cents, 0))}
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
      {sortedExpenses != null && (
        <Pagination
          page={page}
          total={sortedExpenses.length}
          onPage={setPage}
          noun="expenses"
          pageSize={EXPENSES_PAGE}
        />
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
      setError(/open tickets remain/i.test(error.message)
        ? error.message
        : "The day did not close. Check the count and try again.");
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
          Net cash to remit: <span className="font-bold">{formatCentavos(expected)}</span>
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

const EARNINGS_ACC: Record<string, (r: EarningsRow) => unknown> = {
  technician: (r) => r.technician_name,
  treatments: (r) => r.treatments,
  gross: (r) => r.revenue_cents,
  company: (r) => r.company_share_cents,
  share: (r) => r.technician_share_cents,
};

function TechnicianEarningsCard({ branchId, from, to }: {
  branchId: string;
  from: string;
  to: string;
}) {
  const q = useQuery(async () => {
    // Aggregated server-side (0032): the old client-side sum downloaded
    // every ticket line of the period — dozens of round trips on YTD.
    const res = await createClient().rpc("f_technician_earnings", {
      p_branch: branchId, p_from: from, p_to: to,
    });
    return unwrap(res) as EarningsRow[];
  }, [branchId, from, to]);

  const { rows, th } = useSort(q.status === "ready" ? q.data : null, EARNINGS_ACC);

  return (
    <Card title="Earnings by technician">
      {q.status === "loading" && <SkeletonRows rows={4} cols={5} />}
      {q.status === "error" && (
        <ErrorState message="Technician earnings did not load." onRetry={q.retry} />
      )}
      {q.status === "ready" && q.data.length === 0 && (
        <EmptyState message="No services recorded in this period." />
      )}
      {q.status === "ready" && rows != null && rows.length > 0 && (
        <>
          <Table>
            <thead>
              <tr>
                <Th {...th("technician")}>Technician</Th>
                <Th align="right" {...th("treatments")}>Treatments</Th>
                <Th align="right" {...th("gross")}>Gross</Th>
                <Th align="right" {...th("company")}>Company share</Th>
                <Th align="right" {...th("share")}>Technician share</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
