-- Admin parity (0037): owner-equivalent access without the Owner title.
-- The two deliberate exceptions hold: owner accounts are untouchable by
-- an admin, and only the owner approves the weekly schedule.

\set QUIET on
set client_min_messages = warning;

-- Fixture: the vendor's account, invited as admin.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000005', 'dev@polaris.ph',
   jsonb_build_object('role', 'admin', 'full_name', 'Polaris Dev'))
on conflict (id) do nothing;

do $$
declare p record;
begin
  select role, branch_id into p from public.profiles
   where id = '00000000-0000-0000-0000-000000000005';
  if p.role <> 'admin' or p.branch_id is not null then
    raise exception 'admin invite wrong: % / %', p.role, p.branch_id;
  end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000005', false);

-- Owner ground now opens to the admin: catalogue writes, staff list,
-- staff management.
do $$
declare n int;
begin
  update public.services set active = active where name = 'Manicure';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'admin blocked from the service catalogue (% rows)', n;
  end if;

  if (select count(*) from public.profiles) < 4 then
    raise exception 'admin cannot list staff accounts';
  end if;

  update public.profiles set full_name = full_name
   where id = '00000000-0000-0000-0000-000000000003';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'admin blocked from managing staff (% rows)', n;
  end if;

  -- The audit log is readable (owner-only before 0037: zero rows or an
  -- error; the earlier suites' voids and reopens left entries).
  if (select count(*) from public.audit_log) = 0 then
    raise exception 'admin sees an empty audit log';
  end if;
end $$;

-- Owner accounts stay out of reach: no demoting the owner, no minting one.
do $$
begin
  begin
    update public.profiles set active = false
     where id = '00000000-0000-0000-0000-000000000001';
    raise exception 'admin deactivated the owner';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.profiles set role = 'owner', branch_id = null
     where id = '00000000-0000-0000-0000-000000000003';
    raise exception 'admin minted a new owner';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The weekly schedule approval remains the owner's sign-off.
do $$
declare v_main uuid; v_monday date;
begin
  select id into v_main from public.branches where code = 'MAIN';
  v_monday := (business_date() + 1)
    - ((extract(isodow from business_date() + 1))::int - 1);
  begin
    update public.schedule_weeks set status = 'approved'
     where branch_id = v_main and week_start = v_monday;
    raise exception 'admin approved a schedule week';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Front desk gained nothing: the catalogue is still closed to them.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
do $$
declare n int;
begin
  update public.services set active = active where name = 'Manicure';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'front desk can write the service catalogue';
  end if;
end $$;

reset role;
select 'admin suite passed' as result;
