-- Booking behaviour: schedule draft/approve rights, people-capacity,
-- double-book refusal under the window check, named holds, trainee
-- exclusion, horizon, moves, billed finality.

\set QUIET on
set client_min_messages = warning;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

-- Fixtures: two MAIN nail technicians with real specialties.
do $$
begin
  update public.technicians set specialty = 'Nail & Foot'
  where full_name in ('Ana Ramos', 'Divine Ocampo');
end $$;

-- Unapproved week: capacity falls back to the full active roster.
do $$
declare v_main uuid; v_cap record;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select * into v_cap from f_day_capacity(v_main, business_date() + 1) c
  where c.bucket = 'nail_foot';
  if v_cap.capacity < 2 or v_cap.approved then
    raise exception 'fallback capacity wrong: % (approved %)', v_cap.capacity, v_cap.approved;
  end if;
end $$;

-- Front desk drafts the week…
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
do $$
declare v_main uuid; v_monday date;
begin
  select id into v_main from public.branches where code = 'MAIN';
  v_monday := (business_date() + 1)
    - ((extract(isodow from business_date() + 1))::int - 1);
  insert into public.schedule_weeks (branch_id, week_start, drafted_by)
  values (v_main, v_monday, auth.uid())
  on conflict (branch_id, week_start) do nothing;
  insert into public.schedule_days (technician_id, work_date)
  select t.id, business_date() + 1 from public.technicians t
  where t.full_name in ('Ana Ramos', 'Divine Ocampo')
  on conflict (technician_id, work_date) do nothing;

  -- …but cannot approve it.
  begin
    update public.schedule_weeks set status = 'approved'
    where branch_id = v_main and week_start = v_monday;
    raise exception 'front desk approved a schedule';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The owner approves; capacity becomes the scheduled two.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
declare v_main uuid; v_monday date; v_cap record;
begin
  select id into v_main from public.branches where code = 'MAIN';
  v_monday := (business_date() + 1)
    - ((extract(isodow from business_date() + 1))::int - 1);
  update public.schedule_weeks set status = 'approved'
  where branch_id = v_main and week_start = v_monday;

  select * into v_cap from f_day_capacity(v_main, business_date() + 1) c
  where c.bucket = 'nail_foot';
  if v_cap.capacity <> 2 or not v_cap.approved then
    raise exception 'approved capacity wrong: % (approved %)', v_cap.capacity, v_cap.approved;
  end if;
end $$;

-- Bookings: two fill the 10:00 window; a third overlapping is refused;
-- a non-overlapping one passes; named holds enforce per-technician.
do $$
declare v_main uuid; v_client uuid; v_svc uuid; v_ana uuid;
        r1 jsonb; r2 jsonb;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select id into v_client from public.clients where phone = '09171112222';
  select id into v_svc from public.services where name = 'Manicure';
  select id into v_ana from public.technicians where full_name = 'Ana Ramos';

  r1 := save_booking(jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '10:00',
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));
  r2 := save_booking(jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '10:10',
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));

  begin
    perform save_booking(jsonb_build_object(
      'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
      'booking_date', business_date() + 1, 'starts_at', '10:15',
      'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));
    raise exception 'overbooked window accepted';
  exception when check_violation then null;
  end;

  perform save_booking(jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '10:40',
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));

  -- Named technician: her second overlapping named hold is refused.
  perform save_booking(jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '11:30',
    'technician_id', v_ana,
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));
  begin
    perform save_booking(jsonb_build_object(
      'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
      'booking_date', business_date() + 1, 'starts_at', '11:45',
      'technician_id', v_ana,
      'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));
    raise exception 'double-booked named technician';
  exception when check_violation then null;
  end;

  -- Horizon and past-date rules.
  begin
    perform save_booking(jsonb_build_object(
      'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
      'booking_date', business_date() + 20, 'starts_at', '10:00',
      'services', jsonb_build_array(jsonb_build_object('service_id', v_svc))));
    raise exception 'horizon ignored';
  exception when check_violation then null;
  end;

  -- Move: the original frees its window and links forward.
  r2 := move_booking((r1 ->> 'booking_id')::uuid, jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '14:00',
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 30))));
  if (select status from public.bookings where id = (r1 ->> 'booking_id')::uuid) <> 'moved' then
    raise exception 'move did not mark the original';
  end if;

  -- The freed 10:00 window accepts a booking again.
  perform save_booking(jsonb_build_object(
    'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
    'booking_date', business_date() + 1, 'starts_at', '10:00',
    'services', jsonb_build_array(jsonb_build_object('service_id', v_svc, 'duration_min', 10))));

  -- Billed is final.
  perform set_booking_status((r2 ->> 'booking_id')::uuid, 'billed');
  begin
    perform set_booking_status((r2 ->> 'booking_id')::uuid, 'cancelled');
    raise exception 'billed booking was reopened';
  exception when check_violation then null;
  end;
end $$;

-- Trainees: never bookable by name, never counted as capacity.
do $$
declare v_main uuid; v_client uuid; v_svc uuid; v_tech uuid; v_cap record;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select id into v_client from public.clients where phone = '09171112222';
  select id into v_svc from public.services where name = 'Manicure';
  select id into v_tech from public.technicians where full_name = 'Divine Ocampo';
  update public.technicians set skill_level = 'trainee' where id = v_tech;

  begin
    perform save_booking(jsonb_build_object(
      'branch_id', v_main, 'client', jsonb_build_object('id', v_client),
      'booking_date', business_date() + 1, 'starts_at', '15:00',
      'technician_id', v_tech,
      'services', jsonb_build_array(jsonb_build_object('service_id', v_svc))));
    raise exception 'trainee took a named booking';
  exception when check_violation then null;
  end;

  select * into v_cap from f_day_capacity(v_main, business_date() + 1) c
  where c.bucket = 'nail_foot';
  if v_cap.capacity <> 1 then
    raise exception 'trainee still counted as capacity: %', v_cap.capacity;
  end if;

  update public.technicians set skill_level = null where id = v_tech;
end $$;

-- Editing an approved week re-opens it to draft.
do $$
declare v_main uuid; v_monday date;
begin
  select id into v_main from public.branches where code = 'MAIN';
  v_monday := (business_date() + 1)
    - ((extract(isodow from business_date() + 1))::int - 1);
  update public.schedule_days set working = false
  where work_date = business_date() + 1
    and technician_id = (select id from public.technicians where full_name = 'Divine Ocampo');
  if (select status from public.schedule_weeks
      where branch_id = v_main and week_start = v_monday) <> 'draft' then
    raise exception 'editing an approved week did not re-open it';
  end if;
end $$;

reset role;
select 'booking suite passed' as result;
