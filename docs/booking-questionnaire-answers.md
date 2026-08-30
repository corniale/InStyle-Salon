# Salon questionnaire — answers (booking module + inventory)

Recorded as they arrive from the salon contact. Drives the booking spec,
the opening-balance build, and inventory phase 2.

## A. Hours and capacity

**Q1 — Opening days and hours** *(answered 2026-08-30)*
- Both branches open every day, 8:00 AM – 6:00 PM.
- Walk-ins accepted only until 5:30 PM.

**Q2 — Simultaneous capacity** *(answered 2026-08-30)*

| Branch | Station type | Chairs | Technicians |
|---|---|---|---|
| MAIN | Hair | 4 | 3 |
| MAIN | Nail & foot spa | 7 | 3 full-time + 3 part-timers (weekends only) |
| BRANCH | Hair | 4 | 3 |
| BRANCH | Nail & foot spa | 6 | 4 |

**Q3 — What limits capacity** *(answered 2026-08-30)*
"Both, depende": on weekends (peak) staffing is complete but clients still
queue — demand exceeds even full staffing. On weekdays clients are fewer
but MAIN is sometimes short-staffed because the part-timers only come in
on weekends. Net: staff on duty is the binding constraint day to day;
weekend demand can exceed even full staff capacity (queues persist).

## B. Technician roster *(answered 2026-08-30)*

No formal Jr/Sr titles exist except Joey (BRANCH, Sr. Hair Stylist).

**MAIN — Hair:** Jason Allen, Mark, Elma (all hair services).
**MAIN — Nail & Foot:** Mary Jane, Rochelle, Kristine Joanne (full-time);
Ma. Riza Genel, Ruth, Richelle (part-timers, weekends);
Elayza (trainee: shampoo girl + nail tech trainee — shampooing only).

**BRANCH — Hair:** Joey (Sr. — advanced hair analysis + all services),
Iris (all services), Jason (apprentice/trainee — basic services like
haircut & color, needs supervision).
**BRANCH — Nail & Foot:** Lany, Jay Mark, Maricon, Christine.

### Additional design implications
- Weekend queues despite full staffing → booking slots genuinely scarce
  on weekends; the calendar must show remaining capacity per slot, and
  overbooking guard matters most Sat/Sun.
- Trainees are NOT independent capacity: Elayza (MAIN) does shampooing
  only (assist work); Jason (BRANCH) can take basic hair services but
  supervised — for booking capacity, count him at most for basic
  services, or exclude from phase 1 capacity and treat as bonus.
- Skill data for the app: Joey = senior; Jason (BRANCH) + Elayza =
  trainee; everyone else has no formal level (leave unset).
- Name matching to existing records (from the production data copy):
  most map cleanly; assumed JAYSON(TEN)=Jason Allen, JANE=Mary Jane,
  JAYMARK(JIJI)=Jay Mark. No record found for: Ma. Riza Genel (possibly
  under another name) and Elayza (may need creating). Several active DB
  records are NOT in the roster (MAIN: CRIS, JOY, LORALYN, MARIE, RONA,
  SARAH; BRANCH: ALEXIA, ISHA, MA'AM EMILY, NIKKI) — former staff to
  deactivate, or non-roster roles; owner to review.

### Design implications locked in
- Calendar grid: 8:00–18:00 daily, both branches, no closed days.
- Booking capacity is **per station type per time slot**, bounded by
  technicians on duty that day — NOT by chairs. A booking without a named
  technician reserves one unit of type capacity.
- Weekend part-timers at MAIN nails mean capacity is **date-dependent**:
  weekday nails capacity 3, weekend 6. Technician profiles need a
  schedule/part-time notion (at minimum: weekend-only flag).
- Walk-in cutoff 5:30 PM is a POS-side note, not a booking constraint;
  last bookable slot should end by 6:00 PM.
- No spa/massage stations were listed — booking capacity buckets are
  Hair and Nail & Foot; other service types to be mapped when the
  services-per-bucket question is settled in the spec.

**Schedules** *(answered 2026-08-30)*: variable — technicians are
independent contractors who choose their own schedules; currently about
1 day off per week each. Approved setup (confirmed with Ma'am Emily):
**front desk drafts the weekly schedule in the app; the owner approves
it.** The approved schedule becomes the booking calendar's capacity
source. (The schema already has a `shift_blocks` table to build on.)

## Still awaited
- B: technician roster details (names, types, levels, schedules)
- C: service durations; mid-service waits; two-staff services
- D: how bookings work today (lead time, notebook fields, volume, groups,
  inquiry logging)
- E: rules (deposits, lateness/no-show, cancellation, who may edit)
- F: reminders practice
- G: cash float — fixed amount vs carry-over
- H: inventory (retail sales?, stock tracking today, deliveries,
  transfers, units, top items with costs and weekly usage)
