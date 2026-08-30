-- 0036_booking_part2.sql — booking phase 1, part 2: follow-ups, the
-- inquiry log, and the funnel.
--
-- Follow-ups digitize the salon's existing practice (questionnaire Q15):
-- confirm same-day bookings shortly before, and tomorrow's bookings the
-- day before. The app supplies the worklist and records the outcome; the
-- call/FB message stays human.
--
-- Inquiries are the funnel's missing start (Q12 — "like an open ticket"):
-- someone asks about a price by call/FB/walk-in and may or may not book.
-- Deliberately light: a name and/or phone, the channel, what they asked
-- about. One tap converts to a booking; unconverted ones close with a
-- reason. inquiry → booked → showed finally measures what each discovery
-- channel is worth.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- Follow-up outcome on bookings
-- ---------------------------------------------------------------------------

alter table bookings add column if not exists followed_up_at timestamptz;
alter table bookings add column if not exists follow_up_result text
  check (follow_up_result in ('confirmed', 'no_answer', 'moved', 'cancelled'));

-- ---------------------------------------------------------------------------
-- Inquiries
-- ---------------------------------------------------------------------------

create table if not exists inquiries (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id) on delete restrict,
  channel       text not null check (channel in ('call', 'fb', 'walk_in', 'other')),
  client_name   text,
  phone         text,
  interest      text,
  note          text,
  status        text not null default 'open' check (status in ('open', 'booked', 'closed')),
  closed_reason text,
  booking_id    uuid references bookings(id) on delete set null,
  created_by    uuid not null references auth.users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists inquiries_branch_status_idx
  on inquiries (branch_id, status, created_at);

create or replace function stamp_inquiry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'open' and (tg_op = 'INSERT' or old.status = 'open') then
    new.resolved_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists inquiries_stamp on inquiries;
create trigger inquiries_stamp
  before insert or update on inquiries
  for each row execute function stamp_inquiry();

alter table inquiries enable row level security;

drop policy if exists inquiries_read on inquiries;
create policy inquiries_read on inquiries
  for select to authenticated using (can_read_branch(branch_id));

drop policy if exists inquiries_write on inquiries;
create policy inquiries_write on inquiries
  to authenticated
  using (can_read_branch(branch_id))
  with check (can_read_branch(branch_id));

-- ---------------------------------------------------------------------------
-- Funnel: inquiries per channel → booked → showed (billed).
-- ---------------------------------------------------------------------------

create or replace function f_booking_funnel(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (channel text, inquiries bigint, booked bigint, showed bigint)
language sql stable security invoker set search_path = public as $$
  select i.channel,
         count(*)::bigint,
         count(*) filter (where i.status = 'booked')::bigint,
         count(*) filter (where b.status = 'billed')::bigint
  from inquiries i
  left join bookings b on b.id = i.booking_id
  where can_read_branch(i.branch_id)
    and (p_branch is null or i.branch_id = p_branch)
    and (p_from is null or (i.created_at at time zone 'Asia/Manila')::date >= p_from)
    and (p_to   is null or (i.created_at at time zone 'Asia/Manila')::date <= p_to)
  group by i.channel
  order by 2 desc
$$;

-- Booking outcomes for the same card: how bookings end, and whether a
-- deposit changes the no-show rate (the data that will finally justify —
-- or kill — a deposit policy).
create or replace function f_booking_outcomes(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (
  total bigint, billed bigint, no_show bigint, cancelled bigint, moved bigint,
  with_deposit bigint, no_show_with_deposit bigint)
language sql stable security invoker set search_path = public as $$
  select count(*)::bigint,
         count(*) filter (where status = 'billed')::bigint,
         count(*) filter (where status = 'no_show')::bigint,
         count(*) filter (where status = 'cancelled')::bigint,
         count(*) filter (where status = 'moved')::bigint,
         count(*) filter (where coalesce(deposit_cents, 0) > 0)::bigint,
         count(*) filter (where status = 'no_show'
                            and coalesce(deposit_cents, 0) > 0)::bigint
  from bookings
  where can_read_branch(branch_id)
    and (p_branch is null or branch_id = p_branch)
    and (p_from is null or booking_date >= p_from)
    and (p_to   is null or booking_date <= p_to)
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  to_regclass('inquiries') is not null as inquiries_ready,
  (select count(*) from information_schema.columns
   where table_name = 'bookings'
     and column_name in ('followed_up_at', 'follow_up_result')) = 2
    as follow_up_ready,
  to_regprocedure('f_booking_funnel(uuid, date, date)') is not null as funnel_ready,
  to_regprocedure('f_booking_outcomes(uuid, date, date)') is not null as outcomes_ready,
  (select count(*) from pg_policies where tablename = 'inquiries') as inquiry_policies;
