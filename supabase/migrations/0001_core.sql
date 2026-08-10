-- inStyle Salon — Stage 1 core schema
-- Money is bigint centavos everywhere. Timestamps are timestamptz.
-- Business dates are Asia/Manila dates, assigned server-side (edge case 37).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers used by defaults and constraints
-- ---------------------------------------------------------------------------

create or replace function business_date()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Manila')::date
$$;

comment on function business_date() is
  'Server-assigned business date. Device clocks are never trusted (edge case 37).';

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------

create table branches (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  code                 text not null unique,
  accent               text not null default 'slate',
  monthly_target_cents bigint not null default 0 check (monthly_target_cents >= 0),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  constraint branches_accent_known check (accent in ('slate', 'plum'))
);

create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  full_name  text not null,
  role       text not null check (role in ('owner', 'manager', 'front_desk')),
  branch_id  uuid references branches on delete restrict,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  -- A branchless profile means "all branches", which only the owner may be.
  constraint profiles_branch_scope check (branch_id is not null or role = 'owner')
);

create table technicians (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches on delete restrict,
  full_name  text not null,
  active     boolean not null default true,
  hired_on   date,
  created_at timestamptz not null default now()
);

create index technicians_branch_idx on technicians (branch_id) where active;

-- ---------------------------------------------------------------------------
-- Service catalogue
-- ---------------------------------------------------------------------------

create table service_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0
);

create table services (
  id                    uuid primary key default gen_random_uuid(),
  service_type_id       uuid not null references service_types on delete restrict,
  name                  text not null,
  default_sharing_rate  numeric(4,3) not null check (default_sharing_rate between 0 and 1),
  default_duration_min  int not null default 60 check (default_duration_min > 0),
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (service_type_id, name)
);

comment on column services.default_sharing_rate is
  'The COMPANY share, not the technician share. Company share is a multiplication.';

create table branch_service_prices (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches on delete restrict,
  service_id     uuid not null references services on delete restrict,
  price_cents    bigint not null check (price_cents >= 0),
  sharing_rate   numeric(4,3) check (sharing_rate between 0 and 1),
  effective_from date not null default business_date(),
  created_at     timestamptz not null default now(),
  unique (branch_id, service_id, effective_from)
);

create index branch_service_prices_lookup_idx
  on branch_service_prices (branch_id, service_id, effective_from desc);

-- Price in force at a given date. Used by the UI to prefill, never to
-- reconstruct history: lines copy their price at time of sale (edge case 17).
create or replace function price_on(p_branch uuid, p_service uuid, p_on date)
returns table (price_cents bigint, sharing_rate numeric(4,3))
language sql stable as $$
  select bsp.price_cents,
         coalesce(bsp.sharing_rate, s.default_sharing_rate)
  from branch_service_prices bsp
  join services s on s.id = bsp.service_id
  where bsp.branch_id = p_branch
    and bsp.service_id = p_service
    and bsp.effective_from <= p_on
  order by bsp.effective_from desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Clients — phone is the identity key for the whole analytics layer
-- ---------------------------------------------------------------------------

create table clients (
  id                    uuid primary key default gen_random_uuid(),
  phone                 text not null unique,
  phone_declined        boolean not null default false,
  full_name             text,
  barangay              text,
  town                  text,
  inquiry_source        text,
  referred_by_client_id uuid references clients on delete set null,
  first_visit_on        date,
  notes                 text,
  merged_into_id        uuid references clients on delete restrict,
  created_at            timestamptz not null default now(),
  -- A real phone number is 11 digits. A declined walk-in gets a sentinel key
  -- so the record still has a stable identity and the decline rate is
  -- reportable rather than invisible (open question 1).
  constraint clients_phone_shape check (
    (not phone_declined and phone ~ '^[0-9]{11}$')
    or (phone_declined and phone like 'WALKIN-%')
  ),
  constraint clients_merge_not_self check (merged_into_id is null or merged_into_id <> id)
);

create index clients_name_idx on clients (lower(full_name));
create index clients_merged_idx on clients (merged_into_id) where merged_into_id is not null;

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

create table tickets (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches on delete restrict,
  series_no       text,
  client_id       uuid not null references clients on delete restrict,
  ticket_date     date not null default business_date(),
  started_at      timestamptz,
  ended_at        timestamptz,
  payment_method  text not null check (payment_method in ('cash', 'online', 'split', 'package', 'comp')),
  online_ref      text,
  is_new_client   boolean not null default false,
  idempotency_key text not null unique,
  voided_at       timestamptz,
  voided_by       uuid references auth.users on delete set null,
  void_reason     text,
  created_by      uuid not null references auth.users on delete restrict,
  created_at      timestamptz not null default now(),
  unique (branch_id, series_no),
  -- Time ended before time started is rejected; both missing is tolerated
  -- because the existing workbooks leave them blank (edge case 13).
  constraint tickets_time_order check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint tickets_void_reason check (voided_at is null or coalesce(btrim(void_reason), '') <> '')
  -- "Not dated in the future" is enforced by trigger, not by CHECK: a CHECK
  -- expression has to be immutable and the business date is not.
);

create index tickets_branch_date_idx on tickets (branch_id, ticket_date);
create index tickets_client_idx on tickets (client_id, ticket_date);
create index tickets_active_idx on tickets (ticket_date) where voided_at is null;

create table ticket_lines (
  id                   uuid primary key default gen_random_uuid(),
  ticket_id            uuid not null references tickets on delete cascade,
  service_id           uuid not null references services on delete restrict,
  technician_id        uuid not null references technicians on delete restrict,
  assist_technician_id uuid references technicians on delete restrict,
  qty                  int not null default 1 check (qty > 0),
  unit_price_cents     bigint not null check (unit_price_cents >= 0),
  discount_type        text check (discount_type in ('senior', 'pwd', 'staff', 'promo', 'negotiated', 'package')),
  discount_cents       bigint not null default 0 check (discount_cents >= 0),
  sharing_rate         numeric(4,3) not null check (sharing_rate between 0 and 1),
  rating               int check (rating between 1 and 5),
  line_number          int not null,
  -- Discount may bring a line to zero (a comp or a package redemption) but
  -- never below it, and there are no negative prices (edge cases 8 and 9).
  constraint ticket_lines_discount_bound check (discount_cents <= qty * unit_price_cents),
  constraint ticket_lines_assist_distinct check (assist_technician_id is null or assist_technician_id <> technician_id),
  unique (ticket_id, line_number),

  -- Rounding lands on the company side and the technician takes the
  -- remainder, so the two shares always sum exactly to the line total
  -- (edge case 18: a PHP 775 service at 70%).
  total_cents bigint generated always as
    (qty * unit_price_cents - discount_cents) stored,
  company_share_cents bigint generated always as
    ((round((qty * unit_price_cents - discount_cents) * sharing_rate))::bigint) stored,
  technician_share_cents bigint generated always as
    (((qty * unit_price_cents - discount_cents)
      - round((qty * unit_price_cents - discount_cents) * sharing_rate))::bigint) stored
);

create index ticket_lines_ticket_idx on ticket_lines (ticket_id);
create index ticket_lines_service_idx on ticket_lines (service_id);
create index ticket_lines_technician_idx on ticket_lines (technician_id);

comment on column ticket_lines.sharing_rate is
  'Copied from the price list at time of sale. Changing a price next month must not rewrite last month margin.';

-- Split payment across cash and online (edge case 19). A ticket always has at
-- least one payment row; tickets.payment_method summarises them.
create table ticket_payments (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references tickets on delete cascade,
  method       text not null check (method in ('cash', 'gcash', 'maya', 'bank', 'card', 'package', 'comp')),
  amount_cents bigint not null check (amount_cents >= 0),
  reference    text
);

create index ticket_payments_ticket_idx on ticket_payments (ticket_id);

-- ---------------------------------------------------------------------------
-- Packages
-- ---------------------------------------------------------------------------

create table packages (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients on delete restrict,
  service_id        uuid not null references services on delete restrict,
  branch_id         uuid references branches on delete restrict,
  sessions_total    int not null check (sessions_total > 0),
  sessions_used     int not null default 0 check (sessions_used >= 0),
  purchased_on      date not null default business_date(),
  expires_on        date,
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  created_at        timestamptz not null default now(),
  constraint packages_used_bound check (sessions_used <= sessions_total)
);

create index packages_client_idx on packages (client_id);

create table package_sessions (
  id             uuid primary key default gen_random_uuid(),
  package_id     uuid not null references packages on delete restrict,
  ticket_line_id uuid not null references ticket_lines on delete cascade unique,
  used_on        date not null default business_date()
);

create index package_sessions_package_idx on package_sessions (package_id);

-- ---------------------------------------------------------------------------
-- Cash
-- ---------------------------------------------------------------------------

create table expenses (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches on delete restrict,
  spent_on     date not null default business_date(),
  category     text not null,
  amount_cents bigint not null check (amount_cents > 0),
  description  text,
  paid_from    text not null default 'cash' check (paid_from in ('cash', 'bank')),
  recorded_by  uuid not null references auth.users on delete restrict,
  created_at   timestamptz not null default now()
);

create index expenses_branch_date_idx on expenses (branch_id, spent_on);

create table cash_days (
  id                   uuid primary key default gen_random_uuid(),
  branch_id            uuid not null references branches on delete restrict,
  business_date        date not null,
  opening_float_cents  bigint not null default 0 check (opening_float_cents >= 0),
  counted_cash_cents   bigint,
  closed_at            timestamptz,
  closed_by            uuid references auth.users on delete set null,
  note                 text,
  reopened_at          timestamptz,
  reopened_by          uuid references auth.users on delete set null,
  created_at           timestamptz not null default now(),
  unique (branch_id, business_date)
);

comment on table cash_days is
  'Expected cash is never stored. It is derived: opening float + cash takings - cash expenses.';

-- ---------------------------------------------------------------------------
-- Shifts — Stage 1 stand-in, the denominator for utilisation only
-- ---------------------------------------------------------------------------

create table shift_blocks (
  id            uuid primary key default gen_random_uuid(),
  technician_id uuid not null references technicians on delete cascade,
  branch_id     uuid not null references branches on delete restrict,
  work_date     date not null,
  start_time    time not null,
  end_time      time not null,
  constraint shift_blocks_order check (end_time > start_time),
  unique (technician_id, work_date, start_time)
);

create index shift_blocks_date_idx on shift_blocks (branch_id, work_date);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create table audit_log (
  id         bigserial primary key,
  actor_id   uuid,
  action     text not null,
  table_name text not null,
  record_id  uuid,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create index audit_log_at_idx on audit_log (at desc);
create index audit_log_record_idx on audit_log (table_name, record_id);
