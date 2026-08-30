# Booking module — phase 1 specification (front-desk only)

Draft for sign-off. Built entirely from the salon's questionnaire
answers (docs/booking-questionnaire-answers.md). Public online booking
is explicitly later (Stage II-b) and nothing here blocks it.

## Principles

1. **The notebook, digitized** — the booking form captures exactly what
   the notebook does today (Q8), nothing more.
2. **Reservations are real holds** (Q10) against scheduled capacity,
   never queue hints.
3. **People are the capacity** (Q2/Q3): slots consume technicians on
   duty, not chairs. Chairs never enter the math.
4. **The schedule is data the salon maintains** (approved workflow):
   front desk drafts each week, the owner approves, the approved week
   drives the calendar.
5. **Phase 1 is trustable before it is clever**: services block their
   full duration; the processing-time optimisation (technician free
   while color develops) is a fast-follow, already data-modeled.

## Data model

- **schedule_days** — one row per technician per date: working or off,
  with optional start/end (defaults 8:00–18:00). Weeks have a status:
  `draft` (front desk edits) → `approved` (owner; becomes capacity) →
  re-opened edits create a new draft revision. Builds on the existing
  shift_blocks concept; per-day granularity because schedules vary
  week to week (independent contractors, ~1 day off each).
- **bookings** — client_id (resolved like the POS: existing by
  name/phone or created new with town/barangay + inquiry source),
  branch, date, start time, end time (sum of service durations),
  service list (with per-service duration snapshot), optional
  technician_id ("named" hold) else capacity bucket (Hair / Nail &
  Foot / Others), status: `booked → confirmed → arrived → billed`
  terminal, or `moved` (links to the replacement booking), `cancelled`,
  `no_show`. Deposit fields: amount_cents, method, reference — free
  amount, no enforced policy (Q13). ticket_id once arrived (the booking
  becomes an open ticket in one tap; billing proceeds exactly as
  today).
- **inquiries** — deliberately light (Q12): created_at, channel
  (call / FB / walk-in), name and/or phone (both optional), service
  interest (free text or service ref), note, status `open → booked`
  (links the booking) or `closed` (didn't convert, with reason).
- All rows immutable-ish in spirit: status transitions recorded with
  who/when; cancels and no-shows keep their record (funnel data).

## Capacity rules

For a slot on date D at branch B, bucket T (Hair / Nail & Foot):
- capacity = technicians of specialty T scheduled on D (approved week),
  excluding trainees (Elayza always; Jason-BRANCH configurable — see
  open decisions).
- a "named" booking consumes that technician; an "any" booking consumes
  one unit of the bucket.
- the calendar refuses a booking when the overlapping window is full,
  and shows remaining capacity per half-hour visually.
- no approved schedule for D yet → the calendar shows full-roster
  capacity marked "unapproved — confirm the schedule", so booking is
  never blocked by admin lag, but the gap is visible.

## Screens

1. **Calendar (day view)** — per branch: half-hour grid 8:00–18:00,
   columns = Hair / Nail & Foot buckets (with named-tech chips inside
   bookings), each booking a block with client name + services + status
   color. Header: date pager + remaining-capacity summary. ~40
   bookings/day legible on a tablet (Q9 scale).
2. **Booking form** — client search (name/phone, as in POS), services
   (durations auto-sum, editable end time), date + time (conflicts
   shown live), optional preferred technician, deposit (amount, method,
   reference), note. Front desk and up (Q16).
3. **Follow-ups card** (on the calendar page): today's bookings 60
   minutes out + tomorrow's week-ahead bookings (Q15), with phone,
   channel hint, and outcome buttons: confirmed · moved · cancelled ·
   no answer. Late bookings (15 min past start, Q14) surface here too:
   mark arrived, no-show, or re-slot.
4. **Weekly schedule** (Settings or its own page, manager+ to draft,
   owner to approve): a technician × day grid for the week, tap to
   toggle off-days, submit → owner sees a diff-style approval.
5. **Inquiry log** — one-line quick add (channel, name/phone, interest);
   list with convert-to-booking; auto-close prompt after N days.

## Arrival → ticket

"Arrived" on a booking opens the POS pre-filled: client, services,
technician(s), and the deposit as a prefilled payment leg. It lands as
the existing open-ticket stage — park/bill exactly as today. No new
billing paths.

## Funnel analytics (the payoff)

- Inquiries by channel → conversion to booking → show rate → billed
  value: finally measures what Calls/Social Media discovery is worth.
- Booked vs walk-in share per day (Q9's missing data).
- No-show and late rates; deposit correlation ("do deposits reduce
  no-shows?" becomes answerable, informing the missing deposit policy).

## Permissions

- Bookings + inquiries: create/edit/cancel = front desk and up, own
  branch (Q16); owner/admin everywhere.
- Schedules: draft = manager+ (or front desk if the owner prefers —
  open decision), approve = owner.
- All analytics owner/manager as today.

## Phase 1 exclusions (explicit)

Public self-booking; SMS/auto-reminders (the follow-ups card is the
human-powered version of Q15's existing practice); group-booking
mechanics (rare, Q11 — several bookings on one slot suffices);
processing-split capacity (fast-follow); waitlists.

## Open decisions for sign-off

1. **Trainee capacity**: Jason (BRANCH) bookable for basic hair
   services, or excluded from capacity entirely in phase 1?
   (Recommendation: excluded; his work rides as bonus capacity.)
2. **5:30–6:00 slots**: walk-ins stop at 5:30 (Q1) — reserve the last
   half hour for booked clients only? (Recommendation: yes.)
3. **Cash deposits taken days before the visit**: they are drawer money
   on the day received but the ticket exists later. Options: (a) treat
   deposit as received into the drawer on receipt day via a small
   deposit ledger line in Daily cash; (b) phase 1 records the deposit
   on the booking only and the payment leg counts on billing day, with
   a note that cash deposits should be kept out of the drawer count
   until the visit. (Recommendation: (b) for phase 1 — most remote
   deposits are GCash and never touch the drawer — revisit with the
   deposit policy.)
4. **Booking horizon**: 14 days (Q7 says a week is the longest lead)?
5. **Schedule drafting rights**: the salon proposed front desk drafts —
   confirm front desk (not manager+) is the intended draft role.

## Build shape (after sign-off)

One migration (schedule_days, bookings, inquiries + RLS + guards +
funnel functions), one calendar page + form, the follow-ups card, the
schedule screen, POS prefill hook, behavioural suite additions.
Estimated as the largest single module since the original build —
delivered in two pushes: schedule + calendar + form first, then
follow-ups + inquiries + funnel.
