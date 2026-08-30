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

**Q3 — What limits capacity:** implicitly answered by Q2 — technicians on
duty, not chairs, in every case (chairs exceed staff everywhere).

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
