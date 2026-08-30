"use client";

// Weekly schedule (booking spec): technicians choose their own days, so
// the front desk drafts each week and the owner approves it. The approved
// week is the booking calendar's capacity source; editing an approved
// week re-opens it to draft automatically (database trigger).

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/components/session-context";
import { useQuery, unwrap } from "@/lib/use-query";
import { fmtDate, fmtMonthDay } from "@/lib/dates";
import {
  Button, Card, EmptyState, ErrorState, Field, Select, SkeletonRows,
  Table, Td, Th, Truncate,
} from "@/components/ui";

interface TechRow {
  id: string;
  full_name: string;
  specialty: string | null;
  skill_level: string | null;
}

interface DayRow {
  technician_id: string;
  work_date: string;
  working: boolean;
}

interface WeekRow {
  status: "draft" | "approved";
  approved_at: string | null;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE");
}

/** Monday of the week containing the given ISO date. */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const dow = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - dow);
  return d.toLocaleDateString("sv-SE");
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
}

export default function SchedulePage() {
  const { branches, branchId, isOwner } = useSession();
  const [branch, setBranch] = useState(branchId ?? branches[0]?.id ?? "");
  const [weekStart, setWeekStart] = useState(mondayOf(todayISO()));
  const [nonce, setNonce] = useState(0);

  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const q = useQuery(async () => {
    const supabase = createClient();
    const [techs, days, week] = await Promise.all([
      supabase
        .from("technicians")
        .select("id, full_name, specialty, skill_level")
        .eq("branch_id", branch)
        .eq("active", true)
        .order("specialty")
        .order("full_name"),
      supabase
        .from("schedule_days")
        .select("technician_id, work_date, working")
        .gte("work_date", weekStart)
        .lte("work_date", addDays(weekStart, 6)),
      supabase
        .from("schedule_weeks")
        .select("status, approved_at")
        .eq("branch_id", branch)
        .eq("week_start", weekStart)
        .maybeSingle(),
    ]);
    return {
      techs: unwrap(techs) as TechRow[],
      days: unwrap(days) as DayRow[],
      week: (week.data ?? null) as WeekRow | null,
    };
  }, [branch, weekStart, nonce]);

  // Draft state: set of "techId:date" marked working.
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (q.status !== "ready") return;
    const techIds = new Set(q.data.techs.map((t) => t.id));
    setMarks(new Set(
      q.data.days
        .filter((d) => d.working && techIds.has(d.technician_id))
        .map((d) => `${d.technician_id}:${d.work_date}`),
    ));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.status === "ready" ? q.data : null]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(techId: string, date: string) {
    setDirty(true);
    setMarks((m) => {
      const next = new Set(m);
      const key = `${techId}:${date}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function markAll() {
    if (q.status !== "ready") return;
    setDirty(true);
    setMarks(new Set(
      q.data.techs.flatMap((t) => weekDates.map((d) => `${t.id}:${d}`)),
    ));
  }

  async function saveDraft() {
    if (q.status !== "ready") return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const techIds = q.data.techs.map((t) => t.id);
    // Replace this branch's week: week row (draft) + only the working days.
    const { error: werr } = await supabase.from("schedule_weeks").upsert(
      { branch_id: branch, week_start: weekStart, status: "draft" },
      { onConflict: "branch_id,week_start" },
    );
    if (werr) {
      setBusy(false);
      setError("The schedule was not saved. Try again.");
      return;
    }
    const { error: derr } = await supabase
      .from("schedule_days")
      .delete()
      .in("technician_id", techIds)
      .gte("work_date", weekStart)
      .lte("work_date", addDays(weekStart, 6));
    if (!derr) {
      const rows = [...marks]
        .map((k) => {
          const [technician_id, work_date] = k.split(":");
          return { technician_id, work_date };
        })
        .filter((r) => techIds.includes(r.technician_id));
      if (rows.length > 0) {
        const { error: ierr } = await supabase.from("schedule_days").insert(rows);
        if (ierr) {
          setBusy(false);
          setError("The schedule was not saved completely. Reload and check.");
          return;
        }
      }
    } else {
      setBusy(false);
      setError("The schedule was not saved. Try again.");
      return;
    }
    setBusy(false);
    setNonce((n) => n + 1);
  }

  async function approve() {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from("schedule_weeks")
      .update({ status: "approved" })
      .eq("branch_id", branch)
      .eq("week_start", weekStart);
    setBusy(false);
    if (err) {
      setError(/owner/i.test(err.message)
        ? "Only the owner can approve the schedule."
        : "Approval did not go through. Try again.");
      return;
    }
    setNonce((n) => n + 1);
  }

  const week = q.status === "ready" ? q.data.week : null;
  const approved = week?.status === "approved";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[20px] font-bold">Weekly schedule</h1>
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
              onClick={() => setWeekStart(addDays(weekStart, -7))}>←</button>
            <span className="px-2 text-[13px] tnum">
              {fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}
            </span>
            <button className="h-8 px-3 text-[13px] hover:bg-surface-page"
              onClick={() => setWeekStart(addDays(weekStart, 7))}>→</button>
          </div>
        </div>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {approved ? (
            <span className="rounded-[4px] bg-surface-page px-2 py-1 text-[11px] font-bold">
              Approved{week?.approved_at ? ` · ${fmtDate(week.approved_at)}` : ""}
            </span>
          ) : week ? (
            <span className="rounded-[4px] bg-brand-red-tint px-2 py-1 text-[11px] text-brand-red-deep">
              Draft — awaiting the owner&apos;s approval
            </span>
          ) : (
            <span className="rounded-[4px] bg-brand-red-tint px-2 py-1 text-[11px] text-brand-red-deep">
              No schedule yet — the booking calendar assumes the full roster
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {error && <span className="text-[11px] text-brand-red">{error}</span>}
            <Button onClick={markAll}>Everyone, all week</Button>
            <Button variant="primary" busy={busy} busyLabel="Saving"
              disabled={!dirty && week != null}
              onClick={() => void saveDraft()}>
              Save draft
            </Button>
            {isOwner && week && !approved && (
              <Button variant="primary" busy={busy} busyLabel="Approving"
                onClick={() => void approve()}>
                Approve week
              </Button>
            )}
          </span>
        </div>
        <p className="mb-3 text-[11px] text-text-muted">
          Tap a cell to toggle a working day. Trainees appear for completeness
          but never count as booking capacity. Editing an approved week
          re-opens it as a draft.
        </p>

        {q.status === "loading" && <SkeletonRows rows={6} cols={8} />}
        {q.status === "error" && (
          <ErrorState message="The schedule did not load." onRetry={q.retry} />
        )}
        {q.status === "ready" && q.data.techs.length === 0 && (
          <EmptyState message="No active technicians at this branch." />
        )}
        {q.status === "ready" && q.data.techs.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Technician</Th>
                {weekDates.map((d, i) => (
                  <Th key={d} align="center">
                    {DOW[i]}
                    <span className="block text-[10px] font-normal text-text-muted tnum">
                      {fmtMonthDay(d)}
                    </span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.techs.map((t) => (
                <tr key={t.id} className={t.skill_level === "trainee" ? "opacity-60" : ""}>
                  <Td>
                    <Truncate text={t.full_name} max={20} />
                    <span className="block text-[11px] text-text-muted">
                      {t.specialty ?? "—"}
                      {t.skill_level === "trainee" ? " · trainee" : ""}
                    </span>
                  </Td>
                  {weekDates.map((d) => {
                    const on = marks.has(`${t.id}:${d}`);
                    return (
                      <Td key={d} align="center">
                        <button
                          aria-label={`${t.full_name} ${d}`}
                          onClick={() => toggle(t.id, d)}
                          className={`h-7 w-9 rounded-[4px] border text-[11px] font-bold ${
                            on
                              ? "border-ink bg-ink text-white"
                              : "border-border text-text-muted hover:bg-surface-page"
                          }`}
                        >
                          {on ? "IN" : "—"}
                        </button>
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
