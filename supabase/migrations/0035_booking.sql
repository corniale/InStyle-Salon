-- 0035_booking.sql — booking module, phase 1 (docs/booking-spec.md,
-- approved with all five recommendations).
--
--   schedules — one row per technician per date; weeks are drafted by the
--     front desk and approved by the owner; the approved week is the
--     calendar's capacity source. Editing an approved week re-opens it.
--   bookings — real holds against people-capacity (technicians on duty,
--     never chairs), per bucket (hair / nail & foot) or a named
--     technician; services with duration snapshots; optional deposit
--     (no amount policy yet); statuses booked → confirmed → arrived →
--     billed, or moved / cancelled / no_show (all kept — funnel data).
--   Capacity is enforced server-side under an advisory lock, so two
--     tablets cannot double-book the same window.
--
-- Approved decisions: trainees are excluded from capacity and cannot be
-- booked by name; the last half hour (17:30–18:00) is bookable (walk-ins
-- already stop at 17:30); cash deposits count on the ticket at billing
-- (phase 1); horizon 14 days; front desk drafts schedules, owner approves.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- Weekly schedules
-- ---------------------------------------------------------------------------

create table if not exists schedule_weeks (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id) on delete cascade,
  week_start  date not null,                       -- always a Monday
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  drafted_by  uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  unique (branch_id, week_start),
  check (extract(isodow from week_start) = 1)
);

create table if not exists schedule_days (
  id            uuid primary key default gen_random_uuid(),
  technician_id uuid not null references technicians(id) on delete cascade,
  work_date     date not null,
  working       boolean not null default true,
  starts_at     time not null default '08:00',
  ends_at       time not null default '18:00',
  unique (technician_id, work_date),
  check (ends_at > starts_at)
);

create index if not exists schedule_days_date_idx on schedule_days (work_date);

-- Only the owner may approve; approval is stamped; any schedule edit for
-- an approved week silently re-opens it to draft.
create or replace function guard_schedule_week()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and (old.status is distinct from 'approved') then
    if auth_role() <> 'owner' then
      raise exception 'Only the owner approves the weekly schedule.'
        using errcode = 'insufficient_privilege', hint = 'approve_forbidden';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists schedule_weeks_guard on schedule_weeks;
create trigger schedule_weeks_guard
  before insert or update on schedule_weeks
  for each row execute function guard_schedule_week();

create or replace function reopen_schedule_week()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row    record;
  v_branch uuid;
  v_monday date;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select branch_id into v_branch from technicians where id = v_row.technician_id;
  v_monday := v_row.work_date - ((extract(isodow from v_row.work_date))::int - 1);
  update schedule_weeks
     set status = 'draft', approved_by = null, approved_at = null
   where branch_id = v_branch and week_start = v_monday and status = 'approved';
  return v_row;
end
$$;

drop trigger if exists schedule_days_reopen_week on schedule_days;
create trigger schedule_days_reopen_week
  after insert or update or delete on schedule_days
  for each row execute function reopen_schedule_week();

alter table schedule_weeks enable row level security;
alter table schedule_days  enable row level security;

drop policy if exists schedule_weeks_read on schedule_weeks;
create policy schedule_weeks_read on schedule_weeks
  for select to authenticated using (can_read_branch(branch_id));

drop policy if exists schedule_weeks_write on schedule_weeks;
create policy schedule_weeks_write on schedule_weeks
  to authenticated
  using (can_read_branch(branch_id))
  with check (can_read_branch(branch_id));

drop policy if exists schedule_days_read on schedule_days;
create policy schedule_days_read on schedule_days
  for select to authenticated using (
    exists (select 1 from technicians t
            where t.id = technician_id and can_read_branch(t.branch_id)));

drop policy if exists schedule_days_write on schedule_days;
create policy schedule_days_write on schedule_days
  to authenticated
  using (exists (select 1 from technicians t
                 where t.id = technician_id and can_read_branch(t.branch_id)))
  with check (exists (select 1 from technicians t
                      where t.id = technician_id and can_read_branch(t.branch_id)));

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

create table if not exists bookings (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id) on delete restrict,
  client_id      uuid not null references clients(id) on delete restrict,
  booking_date   date not null,
  starts_at      time not null,
  ends_at        time not null,
  bucket         text not null check (bucket in ('hair', 'nail_foot')),
  technician_id  uuid references technicians(id) on delete restrict,
  status         text not null default 'booked' check (status in
                   ('booked', 'confirmed', 'arrived', 'billed',
                    'moved', 'cancelled', 'no_show')),
  deposit_cents     bigint check (deposit_cents >= 0),
  deposit_method    text check (deposit_method in
                      ('cash', 'gcash', 'maya', 'bank', 'card')),
  deposit_reference text,
  note           text,
  ticket_id      uuid references tickets(id) on delete set null,
  moved_to       uuid references bookings(id) on delete set null,
  created_by     uuid not null references auth.users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references auth.users(id) on delete set null,
  check (ends_at > starts_at)
);

create index if not exists bookings_branch_date_idx on bookings (branch_id, booking_date);
create index if not exists bookings_client_idx on bookings (client_id);

create table if not exists booking_services (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references bookings(id) on delete cascade,
  service_id   uuid not null references services(id) on delete restrict,
  duration_min int  not null check (duration_min between 5 and 480),
  position     int  not null default 1
);

create index if not exists booking_services_booking_idx on booking_services (booking_id);

-- A billed booking is history; everything else may be corrected.
create or replace function guard_booking()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.status = 'billed'
     and (new.status <> 'billed' or new.booking_date <> old.booking_date
          or new.starts_at <> old.starts_at) then
    raise exception 'A billed booking is final.'
      using errcode = 'check_violation', hint = 'booking_billed';
  end if;
  if new.status is distinct from old.status or tg_op = 'INSERT' then
    new.status_changed_at := now();
    new.status_changed_by := auth.uid();
  end if;
  return new;
end
$$;

drop trigger if exists bookings_guard on bookings;
create trigger bookings_guard
  before insert or update on bookings
  for each row execute function guard_booking();

alter table bookings enable row level security;
alter table booking_services enable row level security;

drop policy if exists bookings_read on bookings;
create policy bookings_read on bookings
  for select to authenticated using (can_read_branch(branch_id));

drop policy if exists bookings_write on bookings;
create policy bookings_write on bookings
  to authenticated
  using (can_read_branch(branch_id))
  with check (can_read_branch(branch_id) );

drop policy if exists booking_services_read on booking_services;
create policy booking_services_read on booking_services
  for select to authenticated using (
    exists (select 1 from bookings b
            where b.id = booking_id and can_read_branch(b.branch_id)));

drop policy if exists booking_services_write on booking_services;
create policy booking_services_write on booking_services
  to authenticated
  using (exists (select 1 from bookings b
                 where b.id = booking_id and can_read_branch(b.branch_id)))
  with check (exists (select 1 from bookings b
                      where b.id = booking_id and can_read_branch(b.branch_id)));

-- ---------------------------------------------------------------------------
-- Capacity
-- ---------------------------------------------------------------------------

/** hair / nail_foot from a technician's specialty. */
create or replace function tech_bucket(p_specialty text)
returns text language sql immutable as $$
  select case
    when p_specialty = 'Hair' then 'hair'
    when p_specialty = 'Nail & Foot' then 'nail_foot'
  end
$$;

/** Bucket capacity for a branch-date: scheduled non-trainee technicians of
    that bucket when the week is approved; the full active roster
    (flagged unapproved) otherwise. */
create or replace function f_day_capacity(p_branch uuid, p_date date)
returns table (bucket text, capacity int, approved boolean,
               technician_ids uuid[], technician_names text[])
language sql stable security invoker set search_path = public as $$
  with wk as (
    select status = 'approved' as approved
    from schedule_weeks
    where branch_id = p_branch
      and week_start = p_date - ((extract(isodow from p_date))::int - 1)
  ),
  pool as (
    select t.id, t.full_name, tech_bucket(t.specialty) as bucket
    from technicians t
    where t.branch_id = p_branch and t.active
      and coalesce(t.skill_level, '') <> 'trainee'
      and tech_bucket(t.specialty) is not null
      and (
        coalesce((select approved from wk), false) = false
        or exists (select 1 from schedule_days d
                   where d.technician_id = t.id and d.work_date = p_date
                     and d.working)
      )
  )
  select b.bucket,
         count(p.id)::int,
         coalesce((select approved from wk), false),
         coalesce(array_agg(p.id) filter (where p.id is not null), '{}'),
         coalesce(array_agg(p.full_name) filter (where p.id is not null), '{}')
  from (values ('hair'), ('nail_foot')) as b(bucket)
  left join pool p on p.bucket = b.bucket
  where can_read_branch(p_branch)
  group by b.bucket
$$;

/** True when adding [p_start, p_end) would exceed p_capacity given the
    existing active bookings in p_rows (checked at every overlap start). */
create or replace function booking_window_full(
  p_branch uuid, p_date date, p_start time, p_end time,
  p_bucket text, p_tech uuid, p_capacity int, p_exclude uuid)
returns boolean language plpgsql stable security invoker
set search_path = public as $$
declare
  v_point time;
  v_count int;
begin
  for v_point in
    select distinct t from (
      select p_start as t
      union
      select starts_at from bookings
      where branch_id = p_branch and booking_date = p_date
        and status in ('booked', 'confirmed', 'arrived')
        and (p_exclude is null or id <> p_exclude)
        and (case when p_tech is null then bucket = p_bucket
                  else technician_id = p_tech end)
        and starts_at >= p_start and starts_at < p_end
    ) x
  loop
    select count(*) into v_count from bookings
    where branch_id = p_branch and booking_date = p_date
      and status in ('booked', 'confirmed', 'arrived')
      and (p_exclude is null or id <> p_exclude)
      and (case when p_tech is null then bucket = p_bucket
                else technician_id = p_tech end)
      and starts_at <= v_point and ends_at > v_point;
    if v_count + 1 > p_capacity then
      return true;
    end if;
  end loop;
  return false;
end
$$;

-- ---------------------------------------------------------------------------
-- RPCs: create / update / move / status. All run the capacity check under
-- an advisory lock so concurrent saves serialise per branch-date.
-- ---------------------------------------------------------------------------

create or replace function save_booking(p_payload jsonb, p_booking uuid default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_branch  uuid := (p_payload ->> 'branch_id')::uuid;
  v_client  uuid;
  v_date    date := (p_payload ->> 'booking_date')::date;
  v_start   time := (p_payload ->> 'starts_at')::time;
  v_tech    uuid := nullif(p_payload ->> 'technician_id', '')::uuid;
  v_svc     jsonb;
  v_minutes int := 0;
  v_end     time;
  v_bucket  text;
  v_cap     record;
  v_id      uuid;
  v_n       int := 0;
begin
  if v_branch is null or not can_read_branch(v_branch) then
    raise exception 'You do not have access to that branch.'
      using errcode = 'insufficient_privilege', hint = 'branch_forbidden';
  end if;
  if v_date is null or v_start is null then
    raise exception 'A booking needs a client, a date and a start time.'
      using errcode = 'check_violation', hint = 'booking_fields';
  end if;
  -- Same client resolution as the POS: an existing id, or a phone/name
  -- that finds-or-creates the record — first-time clients book too.
  v_client := resolve_client(coalesce(p_payload -> 'client', '{}'::jsonb), business_date());
  if v_client is null then
    raise exception 'A booking needs a client, a date and a start time.'
      using errcode = 'check_violation', hint = 'booking_fields';
  end if;
  if v_date < business_date() then
    raise exception 'Bookings cannot be made in the past.'
      using errcode = 'check_violation', hint = 'booking_past';
  end if;
  if v_date > business_date() + 14 then
    raise exception 'Bookings open 14 days ahead at most.'
      using errcode = 'check_violation', hint = 'booking_horizon';
  end if;
  if jsonb_array_length(coalesce(p_payload -> 'services', '[]'::jsonb)) = 0 then
    raise exception 'Pick at least one service.'
      using errcode = 'check_violation', hint = 'services_required';
  end if;

  for v_svc in select * from jsonb_array_elements(p_payload -> 'services')
  loop
    v_minutes := v_minutes + coalesce(nullif(v_svc ->> 'duration_min', '')::int,
      (select default_duration_min from services where id = (v_svc ->> 'service_id')::uuid), 45);
  end loop;
  v_end := v_start + make_interval(mins => greatest(v_minutes, 5));
  if v_start < time '08:00' or v_end > time '18:00' then
    raise exception 'Bookings run between 8:00 AM and 6:00 PM.'
      using errcode = 'check_violation', hint = 'booking_hours';
  end if;

  -- Bucket from the first service's type; Others (makeup, hairdo) ride on
  -- the hair team.
  select case when st.name = 'Nail & Foot' then 'nail_foot' else 'hair' end
    into v_bucket
  from jsonb_array_elements(p_payload -> 'services') with ordinality e(v, ord)
  join services s on s.id = (e.v ->> 'service_id')::uuid
  join service_types st on st.id = s.service_type_id
  order by e.ord limit 1;

  if v_tech is not null then
    if not exists (select 1 from technicians t
                   where t.id = v_tech and t.branch_id = v_branch and t.active
                     and coalesce(t.skill_level, '') <> 'trainee') then
      raise exception 'That technician cannot take named bookings.'
        using errcode = 'check_violation', hint = 'tech_unbookable';
    end if;
  end if;

  -- Serialise capacity checks per branch-date.
  perform pg_advisory_xact_lock(hashtext(v_branch::text || v_date::text));

  select * into v_cap from f_day_capacity(v_branch, v_date) c
  where c.bucket = v_bucket;
  if v_tech is not null then
    if booking_window_full(v_branch, v_date, v_start, v_end, v_bucket, v_tech, 1, p_booking) then
      raise exception 'That technician is already booked in this window.'
        using errcode = 'check_violation', hint = 'tech_full';
    end if;
  end if;
  if booking_window_full(v_branch, v_date, v_start, v_end, v_bucket, null,
                         greatest(coalesce(v_cap.capacity, 0), 0), p_booking) then
    raise exception 'That window is fully booked (% of % taken).',
      coalesce(v_cap.capacity, 0), coalesce(v_cap.capacity, 0)
      using errcode = 'check_violation', hint = 'window_full';
  end if;

  if p_booking is null then
    insert into bookings (branch_id, client_id, booking_date, starts_at, ends_at,
                          bucket, technician_id, deposit_cents, deposit_method,
                          deposit_reference, note, created_by)
    values (v_branch, v_client, v_date, v_start, v_end, v_bucket, v_tech,
            nullif(p_payload ->> 'deposit_cents', '')::bigint,
            nullif(p_payload ->> 'deposit_method', ''),
            nullif(btrim(coalesce(p_payload ->> 'deposit_reference', '')), ''),
            nullif(btrim(coalesce(p_payload ->> 'note', '')), ''),
            auth.uid())
    returning id into v_id;
  else
    v_id := p_booking;
    update bookings
       set client_id = v_client, booking_date = v_date, starts_at = v_start,
           ends_at = v_end, bucket = v_bucket, technician_id = v_tech,
           deposit_cents = nullif(p_payload ->> 'deposit_cents', '')::bigint,
           deposit_method = nullif(p_payload ->> 'deposit_method', ''),
           deposit_reference = nullif(btrim(coalesce(p_payload ->> 'deposit_reference', '')), ''),
           note = nullif(btrim(coalesce(p_payload ->> 'note', '')), '')
     where id = p_booking
       and status in ('booked', 'confirmed');
    if not found then
      raise exception 'Only a booked or confirmed booking can be edited.'
        using errcode = 'check_violation', hint = 'booking_locked';
    end if;
    delete from booking_services where booking_id = p_booking;
  end if;

  for v_svc in select * from jsonb_array_elements(p_payload -> 'services')
  loop
    v_n := v_n + 1;
    insert into booking_services (booking_id, service_id, duration_min, position)
    values (v_id, (v_svc ->> 'service_id')::uuid,
            coalesce(nullif(v_svc ->> 'duration_min', '')::int,
              (select default_duration_min from services where id = (v_svc ->> 'service_id')::uuid), 45),
            v_n);
  end loop;

  return jsonb_build_object('booking_id', v_id, 'ends_at', v_end, 'bucket', v_bucket);
end
$$;

create or replace function set_booking_status(p_booking uuid, p_status text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if p_status not in ('booked', 'confirmed', 'arrived', 'billed', 'cancelled', 'no_show') then
    raise exception 'Unknown booking status.' using errcode = 'check_violation';
  end if;
  update bookings set status = p_status where id = p_booking;
  if not found then
    raise exception 'Booking not found.' using errcode = 'no_data_found';
  end if;
end
$$;

create or replace function move_booking(p_original uuid, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_new jsonb;
begin
  if not exists (select 1 from bookings where id = p_original
                 and status in ('booked', 'confirmed')) then
    raise exception 'Only a booked or confirmed booking can be moved.'
      using errcode = 'check_violation', hint = 'booking_locked';
  end if;
  v_new := save_booking(p_payload);
  update bookings
     set status = 'moved', moved_to = (v_new ->> 'booking_id')::uuid
   where id = p_original;
  return v_new || jsonb_build_object('moved_from', p_original);
end
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  to_regclass('schedule_weeks') is not null as weeks_ready,
  to_regclass('schedule_days') is not null  as days_ready,
  to_regclass('bookings') is not null       as bookings_ready,
  to_regclass('booking_services') is not null as services_ready,
  to_regprocedure('save_booking(jsonb, uuid)') is not null as save_ready,
  to_regprocedure('move_booking(uuid, jsonb)') is not null as move_ready,
  to_regprocedure('f_day_capacity(uuid, date)') is not null as capacity_ready,
  (select count(*) from pg_policies
   where tablename in ('schedule_weeks', 'schedule_days', 'bookings', 'booking_services'))
    as policies;
