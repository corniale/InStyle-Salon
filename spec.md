# InStyle Salon — Product Specification

**Client:** inStyle Salon (Hair and Nail Center, by Emily Goa, est. 2003)
**Branches:** Main and Branch, Goa, Camarines Sur
**Vendor:** Polaris
**Version:** 0.1 — draft for confirmation
**Date:** August 2026

---

## 1. What this product is

An operations and analytics tool for a two-branch salon.

The product is sold on **insight, not automation**. The competing product (ZenSoft) records the business competently and reports on it retrospectively. This product explains the business: which services actually make money, which clients have stopped coming, how the two branches differ, and what to do about it.

Every screen must be justifiable against that promise. A screen that only records is table stakes; a screen that only reports is ZenSoft. The bar is: does this change a decision Emily makes?

### 1.1 Design consequences of the positioning

Three things follow, and they are not negotiable in Stage 1:

1. **Margin is a first-class figure, not a Stage 3 feature.** Commission is a per-service revenue split, so company share is computable on every line at the moment of sale. Every place that shows revenue also shows what was kept.
2. **Client identity is the foundation of the whole analytics layer.** Without a stable client key, retention, lifetime value, rebooking interval and technician-retention are all unmeasurable. Phone number is a required field on every ticket. This is the single most important data rule in the spec.
3. **Branch comparison is a primary view, not a filter.** The client has two branches; the comparison is the thing they cannot get anywhere else.

---

## 2. Scope

### Stage 1 — the money engine

| Area | Included |
|---|---|
| Light POS | Ticket entry: date, client, service line(s), technician, assist, qty, price, discount, payment method, service rating, time started/ended |
| Service costing | Per-service sharing rate and per-branch price list, so company share is derived on every line |
| Client database | Profile, visit history, package/session balance, lapsed status |
| Dashboard | Daily sales, pace vs monthly target, treatments, traffic, sales **and company share** by service, discount rate, payment mix, new vs returning, upsell rate, ratings |
| Retention analytics | First-visit → second-visit conversion, rebooking interval by service, at-risk client list, technician client-retention |
| Technician analytics | Sales, company share, utilisation, ratings, retention — normalised against service mix |
| Daily cash | Daily sales, petty cash expenses, running balance, end-of-day cash reconciliation |
| Branch views | Every figure available per branch or consolidated |
| Data import | January–July 2026 history from the two existing workbooks |

Attendance and scheduling were moved out of Stage 1 into Stage 2, where they belong with the booking calendar. Stage 1 approximates technician utilisation from ticket timestamps against a simple shift table.

Trend forecasting is deliberately excluded from Stage 1. With two branches and Philippine seasonality (Christmas, graduation, fiesta, wedding season), a naive trend line will be visibly wrong within weeks, and one wrong number discredits every other number on the dashboard. Stage 1 shows month-to-date pace against target instead. Revisit once twelve months of clean data exist.

### Stage 2 — booking and stock

Appointment calendar across both branches; technician availability; duration-aware booking that learns actual service durations from Stage 1 timestamps; earliest-available lookup; online booking; cancellation and no-show tracking with cost attached; staff attendance and scheduling; inventory with low-stock and expiry alerts; supplier records.

### Stage 3 — marketing that aims

Targeted SMS promos; appointment reminders; automatic win-back messages triggered by each client's own rebooking interval; promo and bundle performance tracking; product costing so margin includes consumables as well as commission.

### Non-goals

- Payroll processing
- BIR-compliant official receipt issuance (needs confirmation — see §11)
- Biometric hardware integration
- Accounting-system integration
- Native mobile apps (responsive web only)

---

## 3. Users and permissions

| Role | Scope | Can do |
|---|---|---|
| Owner | All branches | Everything, including price lists, sharing rates, targets, user management, all analytics |
| Branch manager | Own branch | Ticket entry, void requests, expenses, cash reconciliation, own-branch analytics, client records |
| Front desk | Own branch | Ticket entry, client records, expenses. No analytics, no price editing, no voids |

Technicians are records, not users, in Stage 1. They do not log in.

Permission rules are enforced in the database via RLS. The UI hides what a role cannot do, but the UI is not the control — assume it can be bypassed.

---

## 4. Design system

No framework defaults. Nothing in this section is a suggestion.

### 4.1 Colour

Derived from the salon's black-and-red logo. The critical rule: **red is not the primary action colour.** In an analytics tool red means *bad*. If the save button and the "margin down" indicator are the same red, chrome and meaning become indistinguishable. Logo black is the primary action colour; red is reserved for the logo, small brand accents, and genuine alerts.

**Brand**

| Token | Hex | Use |
|---|---|---|
| `--brand-red` | `#D31C1D` | Logo, alert state, destructive confirm |
| `--brand-red-deep` | `#A31315` | Red hover/pressed, text on red tint |
| `--brand-red-tint` | `#FBEBEB` | Alert row background, brand badge |
| `--ink` | `#121212` | Primary button, headings, active nav |

**Neutrals**

| Token | Hex | Use |
|---|---|---|
| `--surface-card` | `#FFFFFF` | Cards, table backgrounds, modals |
| `--surface-page` | `#F7F6F3` | Page background |
| `--border` | `#E4E1DC` | Hairlines, table rules, input borders |
| `--text-body` | `#2B2A28` | Body copy, table cells |
| `--text-muted` | `#6E6B66` | Labels, captions, secondary values |

**Data and status**

| Token | Hex | Use |
|---|---|---|
| `--data-teal` | `#0F7B6C` | Positive / growth |
| `--data-amber` | `#C77700` | Warning / attention |
| `--data-slate` | `#4A5C8C` | **Main branch** identity + chart series |
| `--data-plum` | `#8A5A9B` | **Branch** identity + chart series |

Branch accents appear in exactly three places: the branch switcher, a small identity marker in the header, and chart series when both branches are shown together. They never appear on buttons, links, or status indicators — if the accent lands on an interactive element it stops meaning "which branch" and starts meaning "clickable."

The consolidated view has no branch accent. It uses `--ink`. Consolidated is the *absence* of a branch identity; inventing a third colour would dilute both.

### 4.2 Typography

**Lato only.** Two weights: 400 for body, 700 for headings, table headers, and labels. Not Inter.

With one weight step, hierarchy comes from size and colour, not weight contrast. When two levels are not enough, the answer is size or `--text-muted` — never a third weight.

| Role | Size | Weight |
|---|---|---|
| Page title | 20px | 700 |
| Section / card title | 15px | 700 |
| Table header | 11px | 700 |
| Body, table cell | 13px | 400 |
| Label, caption | 11px | 400 |
| Stat value | 20px | 700 |
| Hero figure (dashboard) | 28px | 700 |

`font-variant-numeric: tabular-nums` on every numeric cell, stat value, and axis label. Lato's proportional figures do not align in currency columns, and this app is mostly currency columns.

### 4.3 Spacing, radius, elevation

- **Spacing scale:** 4, 8, 16, 24, 32, 48px. No other value appears anywhere.
- **Corner radius:** 4px. One value, everywhere — buttons, inputs, cards, modals, badges.
- **Shadows:** none by default. Exactly one subtle value (`0 1px 2px rgba(0,0,0,0.06)`) reserved for overlay surfaces only — modals, dropdowns, popovers. Cards do not have elevation.

### 4.4 Components

**Buttons — two styles only.**

| Style | Appearance | Use |
|---|---|---|
| Primary | `--ink` fill, white text, 4px radius | The one main action per screen |
| Secondary | Transparent, 1px `--border`, `--text-body` | Everything else |

There is no third button style. Destructive actions use the secondary style with `--brand-red` text, and confirm through a modal.

**Icons:** Lucide. One weight, one size (16px inline, 20px for standalone icon buttons). Icon-only buttons carry an `aria-label`.

### 4.5 Density and copy

This is a tool used for hours, not a landing page.

- Table rows: 32px. Table cell padding: 8px vertical, 16px horizontal.
- Page gutters: 24px. Card padding: 16px.
- No hero sections, no marketing copy, no emoji, no feature cards, no illustrations.
- Copy is literal. "Add customer," not "Get started with your journey." "Save," not "Save your changes and continue."
- Sentence case throughout. No terminal punctuation on labels or buttons.
- Empty states name the action, they do not apologise: "No tickets today. Add ticket."
- Errors say what happened and what to do next, with no error code as the headline.

---

## 5. Screen states

**Every screen that loads data implements four states.** No screen renders blank on failure.

| State | Requirement |
|---|---|
| Loading | Skeleton rows matching the real layout's shape. No spinners on full pages. Never a layout shift when data lands. |
| Empty | Explains what would be here and gives the action that creates the first record. Distinguishes "no data yet" from "no results for this filter" — these are different messages. |
| Error | States what failed, offers Retry, and preserves any filter or form state. Never a blank screen, never a raw exception string. |
| Populated | The real thing. |

Partial failure is its own case: if the dashboard loads six tiles and one query fails, the five that succeeded still render and the sixth shows an inline error. One failed query does not blank the page.

---

## 6. Forms

Applies to every form in the product.

- Submit is disabled while in flight, and shows an in-progress label.
- Validation runs on the client for speed **and on the server for truth.** Client validation is a convenience; the server is the authority.
- Errors are specific and attached to the field that caused them. Not "Invalid input" — "Phone number must be 11 digits."
- Every mutating submit carries a client-generated idempotency key. A double-tap, a slow connection retry, or a browser back-and-resubmit must not create two tickets.
- Forms with unsaved changes warn before navigation.
- Money is entered in pesos and stored as integer centavos. No floating point anywhere in the money path.

---

## 7. Data model

PostgreSQL via Supabase. Money is `bigint` centavos. Timestamps are `timestamptz`.

### 7.1 Tables

**`branches`**
`id uuid pk` · `name text` · `code text unique` ("MAIN", "BRANCH") · `accent text` · `monthly_target_cents bigint` · `active bool`

**`profiles`** — extends `auth.users`
`id uuid pk references auth.users` · `full_name text` · `role text check (role in ('owner','manager','front_desk'))` · `branch_id uuid null` (null = all branches, owner only) · `active bool`

**`technicians`**
`id uuid pk` · `branch_id uuid` · `full_name text` · `active bool` · `hired_on date`
Technicians belong to a branch but may appear on the other branch's tickets; the ticket line records where the work happened.

**`service_types`**
`id uuid pk` · `name text` ("Hair", "Nail & Foot", "Treatment") · `sort_order int`

**`services`**
`id uuid pk` · `service_type_id uuid` · `name text` · `default_sharing_rate numeric(4,3)` · `default_duration_min int` · `active bool`

`default_sharing_rate` is the **company's** share (0.500, 0.600, 0.700). Storing the company side rather than the technician side means company share is a multiplication, not a subtraction, and the number that matters is the one stored.

**`branch_service_prices`**
`id uuid pk` · `branch_id uuid` · `service_id uuid` · `price_cents bigint` · `sharing_rate numeric(4,3) null` · `effective_from date` · `unique (branch_id, service_id, effective_from)`

Per-branch pricing is required, not optional: the existing data shows keratin at ₱3,900 at Main and ₱3,500 at Branch, and rebond at ₱2,800 vs ₱3,000. The model must represent that honestly rather than force a single price. A dashboard alert flags services whose branch prices diverge, so divergence is always deliberate.

**`clients`**
`id uuid pk` · `phone text unique not null` · `full_name text` · `barangay text` · `town text` · `inquiry_source text` · `referred_by_client_id uuid null` · `first_visit_on date` · `notes text` · `merged_into_id uuid null`

Phone is the identity key and is unique across both branches — one client record, both branches. `merged_into_id` supports duplicate merging without deleting history.

**`tickets`**
`id uuid pk` · `branch_id uuid` · `series_no text` · `client_id uuid` · `ticket_date date` · `started_at timestamptz` · `ended_at timestamptz null` · `payment_method text` · `online_ref text null` · `is_new_client bool` · `idempotency_key text unique` · `voided_at timestamptz null` · `voided_by uuid null` · `void_reason text null` · `created_by uuid` · `created_at timestamptz`
`unique (branch_id, series_no)`

Tickets are never deleted. Voiding is a status, and voided tickets are excluded from analytics but remain auditable.

**`ticket_lines`**
`id uuid pk` · `ticket_id uuid` · `service_id uuid` · `technician_id uuid` · `assist_technician_id uuid null` · `qty int` · `unit_price_cents bigint` · `discount_type text null` · `discount_cents bigint default 0` · `sharing_rate numeric(4,3)` · `rating int null check (rating between 1 and 5)` · `line_number int`

Plus generated columns:

```sql
total_cents bigint generated always as (qty * unit_price_cents - discount_cents) stored,
company_share_cents bigint generated always as
  (round((qty * unit_price_cents - discount_cents) * sharing_rate)) stored,
technician_share_cents bigint generated always as
  ((qty * unit_price_cents - discount_cents)
   - round((qty * unit_price_cents - discount_cents) * sharing_rate)) stored
```

Price and sharing rate are **copied onto the line at time of sale**, not joined from the price list. Changing a price next month must not rewrite last month's margin.

**`packages`** / **`package_sessions`**
`packages`: `id` · `client_id` · `service_id` · `sessions_total int` · `sessions_used int` · `purchased_on date` · `expires_on date null` · `amount_paid_cents bigint`
`package_sessions`: `id` · `package_id` · `ticket_line_id` · `used_on date`

**`expenses`**
`id uuid pk` · `branch_id uuid` · `spent_on date` · `category text` · `amount_cents bigint` · `description text` · `recorded_by uuid` · `created_at timestamptz`

**`cash_days`**
`id uuid pk` · `branch_id uuid` · `business_date date` · `opening_float_cents bigint` · `counted_cash_cents bigint` · `closed_at timestamptz null` · `closed_by uuid null` · `note text`
`unique (branch_id, business_date)`

Expected cash is computed, never stored — it is derived from cash-method ticket totals minus cash expenses plus opening float. Variance is expected minus counted, and a non-zero variance requires a note before the day can be closed.

**`shift_blocks`** — minimal Stage 1 stand-in for scheduling
`id uuid pk` · `technician_id uuid` · `branch_id uuid` · `work_date date` · `start_time time` · `end_time time`

Used only as the denominator for utilisation. Replaced by real scheduling in Stage 2.

**`audit_log`**
`id bigserial pk` · `actor_id uuid` · `action text` · `table_name text` · `record_id uuid` · `before jsonb` · `after jsonb` · `at timestamptz`
Written by trigger on voids, price changes, sharing-rate changes, and client merges.

### 7.2 Derived views

Analytics read from views, not from raw tables, so the definition of a metric lives in one place.

- `v_ticket_lines_active` — lines from non-voided tickets, joined to service, technician, branch
- `v_client_visits` — one row per client per visit date, with the gap in days to the previous visit
- `v_client_retention` — per client: visit count, first visit, last visit, personal median interval, days overdue
- `v_service_margin` — per service per branch per month: units, revenue, company share, margin %
- `v_technician_performance` — per technician per month: revenue, company share, lines, distinct clients, repeat clients, expected margin given mix, actual margin
- `v_daily_cash` — per branch per day: expected cash, counted, variance

The technician view carries **expected margin given service mix** alongside actual. Raw margin by technician is misleading — the nail technicians are locked into 50–58% services and the hair technicians into 70% services, so a raw ranking punishes people for the price list rather than their performance.

---

## 8. Row-level security

RLS is enabled on every table. Policies are explicit. There is no permissive fallback and no service-role key in client code.

### 8.1 Helper functions

```sql
create or replace function auth_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function auth_branch()
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = auth.uid() and active
$$;

create or replace function can_read_branch(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and (p.role = 'owner' or p.branch_id = target)
  )
$$;
```

`security definer` is required — the functions read `profiles`, which is itself RLS-protected, and without it every policy check would recurse.

### 8.2 Policies

```sql
alter table branches            enable row level security;
alter table profiles            enable row level security;
alter table technicians         enable row level security;
alter table service_types       enable row level security;
alter table services            enable row level security;
alter table branch_service_prices enable row level security;
alter table clients             enable row level security;
alter table tickets             enable row level security;
alter table ticket_lines        enable row level security;
alter table packages            enable row level security;
alter table package_sessions    enable row level security;
alter table expenses            enable row level security;
alter table cash_days           enable row level security;
alter table shift_blocks        enable row level security;
alter table audit_log           enable row level security;
```

**profiles** — a user reads only their own row; only the owner manages profiles.

```sql
create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_owner_read on profiles
  for select to authenticated using (auth_role() = 'owner');

create policy profiles_owner_write on profiles
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');
```

**branches** — any signed-in staff member may read the branches they can see; only the owner writes.

```sql
create policy branches_read on branches
  for select to authenticated using (can_read_branch(id));

create policy branches_owner_write on branches
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');
```

**tickets** — read and insert scoped to the user's branch; only owner and manager may void; nobody deletes.

```sql
create policy tickets_read on tickets
  for select to authenticated using (can_read_branch(branch_id));

create policy tickets_insert on tickets
  for insert to authenticated
  with check (can_read_branch(branch_id) and created_by = auth.uid());

create policy tickets_update on tickets
  for update to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner','manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner','manager'));
```

No delete policy exists on `tickets`. With RLS enabled and no policy for an action, that action is denied — deletion is impossible through the API for every role.

**ticket_lines** — inherit the parent ticket's branch.

```sql
create policy ticket_lines_read on ticket_lines
  for select to authenticated using (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id))
  );

create policy ticket_lines_write on ticket_lines
  for insert to authenticated with check (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id)
              and t.voided_at is null)
  );
```

**clients** — shared across branches, so any active staff member may read and create; only owner and manager may merge or deactivate.

```sql
create policy clients_read on clients
  for select to authenticated using (auth_role() is not null);

create policy clients_insert on clients
  for insert to authenticated with check (auth_role() is not null);

create policy clients_update on clients
  for update to authenticated
  using (auth_role() in ('owner','manager'))
  with check (auth_role() in ('owner','manager'));
```

**services, service_types, branch_service_prices** — everyone reads, owner writes.

```sql
create policy services_read on services
  for select to authenticated using (auth_role() is not null);

create policy services_owner_write on services
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

create policy prices_read on branch_service_prices
  for select to authenticated using (can_read_branch(branch_id));

create policy prices_owner_write on branch_service_prices
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');
```

**expenses, cash_days, shift_blocks, technicians** — branch-scoped read and write, owner unrestricted.

```sql
create policy expenses_read on expenses
  for select to authenticated using (can_read_branch(branch_id));

create policy expenses_write on expenses
  for insert to authenticated
  with check (can_read_branch(branch_id) and recorded_by = auth.uid());

create policy expenses_update on expenses
  for update to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner','manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner','manager'));

create policy cash_days_read on cash_days
  for select to authenticated using (can_read_branch(branch_id));

create policy cash_days_write on cash_days
  for all to authenticated
  using (can_read_branch(branch_id)) with check (can_read_branch(branch_id));
```

**audit_log** — owner reads, nobody writes through the API.

```sql
create policy audit_owner_read on audit_log
  for select to authenticated using (auth_role() = 'owner');
```

Rows are inserted by `security definer` triggers, which bypass RLS. There is no insert policy, so no client can forge an audit entry.

### 8.3 What the anon key can read

The anon key is public. It ships in the browser bundle and must be assumed to be in an attacker's hands. Every policy above is granted `to authenticated`, so an unauthenticated request matches no policy on any table.

Direct query with the anon key, no session:

```
GET /rest/v1/clients?select=*
Headers: apikey: <anon key>
→ HTTP 200
→ []
```

```
GET /rest/v1/tickets?select=*
Headers: apikey: <anon key>
→ HTTP 200
→ []
```

```
POST /rest/v1/clients
Headers: apikey: <anon key>
Body: {"phone":"09171234567","full_name":"test"}
→ HTTP 401
→ {"code":"42501","message":"new row violates row-level security policy for table \"clients\""}
```

**Empty array, not an error, is the correct and expected result for reads.** PostgREST returns 200 with zero rows when RLS filters everything out. A 200 here is not a leak; a non-empty body would be.

Additionally:

- `revoke all on schema public from anon;` then grant only what is needed — no table grants to `anon` at all in Stage 1, since there is no public-facing surface until Stage 2 online booking.
- Analytics views are created with `security_invoker = on` so they inherit the caller's RLS rather than the view owner's.
- The service-role key exists only in server-side environment variables, used by the import job and scheduled analytics refresh. It never appears in client code, in the repo, or in any `NEXT_PUBLIC_`/`VITE_` variable.

**Verification is part of delivery.** Before each stage ships, the anon-key probe above is run against every table and the output pasted into the release notes. A table that returns rows to anon is a release blocker.

---

## 9. Offline behaviour

The tool is online-first. Offline support is **scoped to the POS write path only** — taking sales when the connection drops. Booking, inventory, and analytics require a connection and say so plainly when offline.

This is a deliberate limit. Full offline-first with conflict resolution is a large and failure-prone piece of engineering. Sales, however, are append-only: two devices creating tickets do not conflict, they simply both happened.

**Mechanism**

1. Ticket submissions are written to a local queue (IndexedDB) with a client-generated `idempotency_key` and a local sequence number.
2. The UI confirms immediately and marks the ticket "pending sync" with a visible count in the header.
3. A background worker drains the queue in order when connectivity returns, replaying each ticket with its idempotency key.
4. The server's unique constraint on `idempotency_key` makes replay safe — a duplicate insert is caught and treated as success.
5. Series numbers are assigned **server-side on sync**, not locally, to avoid two devices claiming the same number.
6. Queued tickets survive a browser refresh and a device restart. They are never silently dropped.
7. If a queued ticket fails validation on sync (deleted service, deleted technician), it moves to a visible "needs attention" list with the specific reason — never discarded.

**Limits, to be stated plainly to the client:** offline covers recording a sale. It does not cover looking up a client who was created on the other device while offline, checking a package balance changed elsewhere, or any analytics. The pending-sync count is always visible so nobody assumes data is safe when it is queued.

---

## 10. Edge cases

Per the pre-build standard, this is the list to confirm **before any code is written.**

### Data entry

1. Client with no phone number — front desk refuses to ask. Blocking or allowing this decides whether analytics work; needs a decision (see §11).
2. Duplicate phone number on a new client — surface the existing client and offer to use it rather than erroring.
3. Same client, two spellings of the name — merge flow, keeping both visit histories, writing to `merged_into_id`.
4. Walk-in with no name given.
5. Very long names, service names, and notes — truncate with tooltip in tables, never break layout.
6. Ticket with several services, several technicians, and one assist.
7. Service performed at a price other than the list price (negotiated, staff discount).
8. Discount larger than the line total, or a negative price.
9. Zero-price line — a comp or a package redemption.
10. Package redemption where the package has expired or has zero sessions left.
11. Backdated ticket — entered the next morning for yesterday.
12. Ticket edited after the cash day is closed.
13. Time ended before time started, or missing entirely.
14. Rating left blank (currently blank on a meaningful share of rows).
15. Technician who left mid-month — must remain on historical tickets while disappearing from new-ticket pickers.
16. Service deleted or renamed after tickets reference it.
17. Price changed mid-month — historical lines must keep their old price.

### Money

18. Rounding on sharing rates that do not divide evenly (a ₱775 service at 70%).
19. Split payment across cash and online.
20. Refund or void after the day is closed.
21. Cash variance at end of day — requires a note, cannot be silently accepted.
22. Two ticket entries for the same sale (double submission) — idempotency key.
23. Negative petty cash balance.

### Analytics

24. A month with no data (May is missing from the existing history) — charts must show a gap, not interpolate across it.
25. A client whose only visit is their first — counts toward new, not toward retention.
26. Rebooking interval for a client with one visit — undefined, not zero.
27. Technician with fewer than a threshold number of tickets — excluded from rankings, shown separately, so a new hire's three tickets do not top the leaderboard.
28. Service sold at only one branch — branch comparison shows "not offered," not zero.
29. Division by zero everywhere: margin with zero revenue, utilisation with zero scheduled hours, conversion with zero new clients.
30. Date range crossing a price change.

### System

31. List exceeding 50 rows — pagination or virtualization (client list, ticket list, service list all exceed this).
32. Two devices entering tickets at the same branch simultaneously.
33. Session expiring mid-form — preserve the form, re-authenticate, resume.
34. Connection dropping mid-submit — the queue, not an error.
35. A staff member switching branches in the picker without permission for the target branch.
36. Import running twice — must not duplicate history.
37. Clock skew between a device and the server on date boundaries — business date is server-assigned.

---

## 11. Open questions

These need answers from the client before Stage 1 is finalised.

1. **Is phone number mandatory at point of sale?** Making it required is what makes the analytics work. Making it optional means a share of tickets stay anonymous forever. Recommended: required for new clients, with an explicit "walk-in, declined" option that is logged and reported so the rate is visible.
2. **Does the salon need BIR-compliant receipts from this system?** ZenSoft prints receipts and job orders. If the salon relies on that, this is a scope gap and must be either added or explicitly excluded in the contract.
3. **Are the branch price differences deliberate?** Keratin ₱3,900 vs ₱3,500, rebond ₱2,800 vs ₱3,000, shampoo with blow dry ₱300 vs ₱200.
4. **Why is May missing from both branches' client lists?** If staff stopped filling it in, that tells us what the app can realistically ask of them.
5. **Who is the second user?** How many staff need logins, and does each branch have a manager distinct from the owner?
6. **How are ratings currently collected,** and is the technician present when the client gives them? This determines whether the rating field is meaningful or decorative.
7. **What happens to the January–July history** — is it imported as-is, cleaned first, or left behind?
8. **Hosting, support, and continuity.** Not a product question, but the client will ask: who hosts it, what happens if support ends, and can they export their own data. It should be answered in the proposal, not improvised in the room.

---

## 12. Delivery and acceptance

Payment is in tranches, one per stage delivered. A stage is accepted when:

- Every screen in the stage demonstrates all four states.
- The anon-key probe returns zero rows for every table, pasted into release notes.
- The edge-case list for that stage is demonstrably handled.
- No secrets appear in client code (verified by a build-time scan).
- The client can complete a full day of real operation on it without falling back to Excel.
