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

## C. Service times *(answered 2026-08-30, via the 2026 Features &
Benefits guide + Q5 follow-up)*

**Q4 — durations:** taken from the guide's InStyle page; applied to the
catalogue via `supabase/scripts/service_durations_seed.sql` (midpoint of
each range, total client-in-chair time). The guide also covers the sister
businesses (Naitay Spa, Rainbrow Aesthetic, Cutchi Barbershop) — their
menus/durations are on file for when those catalogues onboard.

**Q5 — mid-service waiting (technician free during processing):**
| Service | Processing wait |
|---|---|
| Hair Color / Hi-lites | 30–45 min |
| Keratin Mask | 30–60 min |
| Rebond | ~1 hr (depends on hair) |
| Keratin Opti Straight | ~1 hr |
| Air Perm | ~1 hr |
| Brazilian Botox | ~1 hr |

### Design implications
- Booking must model chemical services as hands-on + processing +
  finish: the CHAIR is occupied for the full duration, but the
  TECHNICIAN is free during processing to take a short service. This is
  the single biggest capacity lever on hair — a rebond blocks a chair
  for ~3h15 but only ~2h of technician time. Phase 1 of booking can
  treat duration as a solid block (safe, simpler); the processing-split
  optimisation is a fast-follow once the calendar is trusted.
- Catalogue notes: the guide lists AIR PERM and HAIRDO but no matching
  active service exists (likely booked under OTHERS (HAIR) / styling
  services) — owner to decide whether to add them as proper services.
  BALAYAGE (without treatment), BANGS, MILK SPA, BLOWER STYLE, HAIR IRON
  STYLE, CHANGE POLISH, FOOTSCRUB W/ MANI.PEDI., OTHERS have no guide
  duration — flagged 'review' by the seed.

**Q6 — two-staff services** *(answered 2026-08-30)*: none. Packages
(e.g. Foot Spa with Mani & Pedi) are usually one technician, sometimes
shared between two — but no single service inherently needs two staff at
once. (The POS assist field already covers the shared case.)

## D. How bookings work today *(answered 2026-08-30)*

**Q7 — lead time:** mixed — same day, a day ahead, and a week ahead all
happen.

**Q8 — notebook fields per booking:**
Name · Address · Phone · Service(s) · Preferred time & date ·
Preferred technician (optional — usually OLD clients) · OLD or NEW ·
Inquiry source if NEW.

**Q9 — volume:** no actual booked-vs-walk-in data. Traffic estimate:
BRANCH alone averages ~950 clients monthly (~32/day).

**Q10 — reservation semantics:** bookings DO reserve the slot. In heavy
overload a booked client may still wait a bit if the technician is
running over, but the reservation is real, not a queue position.

**Q11 — group bookings:** no weddings/debuts. Friends booking together
happens but is very rare — no special group feature needed; front desk
can enter several bookings on the same slot.

**Q12 — inquiries:** YES, tracked — inquiries that don't result in a
visit are noted, "like an open ticket." The inquiry → booked → showed
funnel matches how they already think.

### Design implications
- The booking form IS the notebook page: client (search existing by
  name/phone, or new with town/barangay + inquiry source — all existing
  fields), service(s), date, time, optional preferred technician, and
  the new/old flag the POS already carries. Nothing new to invent.
- Preferred technician optional → two booking kinds: "any technician"
  (consumes type capacity) and "named technician" (consumes that
  person's capacity). Old clients drive the named kind.
- Lead times up to a week → a 2-week bookable horizon is ample.
- Reservation is a hard hold against scheduled capacity (Q10), not a
  queue hint. Overruns are reality; phase 1 shows the day's load
  honestly rather than promising exact start times.
- Inquiry log confirmed as a first-class light object: name/phone
  (optional), source, service interest, notes; one tap converts to a
  booking; unconverted = funnel data the discovery-method analytics
  have been waiting for.
- ~32 clients/day at BRANCH sets the scale: a day view must comfortably
  show ~30-40 bookings + capacity at a glance.

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
