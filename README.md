# inStyle Salon — Stage 1

Operations and analytics for a two-branch salon (Goa, Camarines Sur).
Built to the product specification in `spec.md`; sold on **insight, not
automation** — every screen must change a decision the owner makes.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind v4) — responsive web, no
  native apps
- **Supabase** (Postgres 17, Auth, PostgREST) — schema, business rules and
  row-level security live in `supabase/migrations/`
- Money is **integer centavos** end to end; no floating point in the money
  path
- Design system per spec §4: Lato 400/700 (self-hosted), ink primary, red
  reserved for alerts and the logo, 4px radius, no card shadows

## Layout

```
supabase/migrations/   0001 schema · 0002 rules/triggers · 0003 RPCs
                       0004 views · 0005 RLS · 0006 analytics fns
                       0007 auth trigger · 0008 catalogue seed
                       0009 businesses · 0010 branding · 0011 import prep
                       0012 birthdays · 0013 daily record statement
supabase/tests/        run.sh applies everything to a throwaway Postgres and
                       runs the behavioural suite (RLS, anon probe, cash
                       rules, packages, merge, idempotent replay)
src/app/(app)/         dashboard · tickets (+ new) · clients (+ detail) ·
                       cash · analytics · technicians · compare · settings
src/lib/offline/       IndexedDB ticket queue + sync worker (spec §9)
scripts/anon-probe.mjs release-gate probe: every table must return zero rows
                       to the anon key (spec §8.3, §12)
scripts/scan-secrets.mjs build-time scan: no secrets in client code
scripts/import/        idempotent Jan–Jul 2026 history import
```

## Hosting

The app builds to a static export (`next build` → `out/`) and deploys to
GitHub Pages automatically on every push to the working branch
(`.github/workflows/deploy-pages.yml`). Live at
`https://corniale.github.io/InStyle-Salon/`. All data access happens from
the browser against Supabase; the anon key in the workflow is public by
design and RLS is the control. Auth gating is client-side
(`src/app/(app)/layout.tsx`) — a convenience, not the security boundary.

## Setup

1. Create a Supabase project, then apply migrations in order:
   `supabase/migrations/0001…0013` (via `supabase db push` or the SQL
   editor). `0008_seed.sql` loads the catalogue, branch price lists and
   technician roster; edit it to match reality before running.
2. Copy `.env.example` to `.env.local` and fill in the project URL and anon
   key. The service-role key is only ever set in the environment of the
   import job — never in anything `NEXT_PUBLIC_`.
3. `npm install && npm run dev`
4. Create the first user in Supabase Auth — the first account automatically
   becomes the owner. Invite staff from Auth → Invite user with
   `{"role": "front_desk", "branch_id": "…"}` metadata; manage them under
   Settings → Staff accounts.
5. Import history: see `scripts/import/README.md`.

## Verification (spec §12)

- `./supabase/tests/run.sh` — applies all migrations to a local scratch
  Postgres and runs the behavioural suite (needs a local `postgres` at
  `$PGHOST`/`$PGPORT`; see the script header)
- `npm run probe:anon` — the anon-key probe against the live project; paste
  its output into release notes. Any leaking table is a release blocker.
- `npm run scan:secrets` — run after `npm run build`; scans `src/` and the
  client bundles
- `npm run typecheck` / `npm run build`

## Decisions taken on the spec's open questions (§11)

These are working defaults, all reversible, flagged for client confirmation:

1. **Phone at point of sale** — required, with an explicit "walk-in,
   declined" option. The decline is stored on the client record and the
   dashboard's data-quality tile reports the declined rate, so erosion of
   the analytics base is visible (recommended option in the spec).
2. **BIR receipts** — not built (listed under non-goals pending the client's
   answer). The ticket has `series_no` per branch, so numbering exists if
   receipt printing is added later.
3. **Branch price differences** — modelled as deliberate: per-branch price
   lists, with a dashboard alert listing every divergence so it stays
   deliberate.
4. **"Missing" May** — resolved by the import: May's sales were complete
   and match the workbook dashboards; it was the client names that went
   unrecorded that month. (Charts still render true gaps as gaps.)
5. **Gift certificates** — rarely sold; recorded as a comp/discount line by
   agreement. No dedicated GC concept in Stage 1.
6–8. Open with the client; nothing in the build blocks any answer.

## Stage 1 scope notes

- Technicians are records, not users; they do not log in.
- Utilisation is approximated from ticket timestamps against `shift_blocks`
  until Stage 2 brings real scheduling.
- No forecasting: the dashboard shows month-to-date pace against target
  (spec §2 explains why).
- Offline covers the POS write path only. Queued tickets survive restarts,
  sync in order, replay safely (idempotency keys), and surface a visible
  "needs attention" list when the server rejects them.

## Backlog

Deferred features (client said "later"):
- Define the Admin role's exact accesses (0020 gives it an interim shape:
  manager powers across all branches, plus exports; owner-only ground —
  settings, catalogue, staff accounts, audit log — stays owner-only).
- "Add Client" button — revisit when the booking module lands.

Small flagged items:
- Backdated tickets use today's price list; switch to as-of-ticket-date
  lookup if a mid-day price change ever bites (history supports it).
- Opening balance could default to the previous day's float for a
  standing change fund.
- Force two-decimal money formatting beyond the technician ranking if
  wanted app-wide (one flag per table).

Stage 2 proper:
- Inquiry funnel and appointments/booking (front-desk first; public online
  booking later) — spec awaiting the salon's questionnaire answers.
- Timekeeping, banlaw and cash-advance settlement modelling (also closes
  the last centavos of drift vs the paper Daily Records).

Inventory (core shipped in 0028: catalogue, per-branch stock from an
append-only movement ledger, weighted-average costing, transfers,
low-stock alerts, per-product activity filter). Waiting on the salon's
answers before building:
- Automatic per-service consumption (deduct stock when a service is billed).
- Retail product sales at the POS.
