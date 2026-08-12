-- Client birthdays. Two purposes, per the owner: a second identity anchor
-- (phone numbers change; name + birthday survives), and birthday discounts.
-- Stored as month + day only — clients give "March 14" readily, the year is
-- not needed for either purpose, and the business has no reason to hold ages.

alter table clients add column if not exists birth_month int
  check (birth_month between 1 and 12);
alter table clients add column if not exists birth_day int
  check (birth_day between 1 and 31);

-- Both-or-neither, and the day must exist in the month (Feb 29 allowed).
alter table clients drop constraint if exists clients_birthday_valid;
alter table clients add constraint clients_birthday_valid check (
  (birth_month is null) = (birth_day is null)
  and (birth_month is null or birth_day <= case birth_month
        when 2 then 29
        when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30
        else 31 end)
);

-- The birthday discount becomes a first-class, trackable discount type.
alter table ticket_lines drop constraint if exists ticket_lines_discount_type_check;
alter table ticket_lines add constraint ticket_lines_discount_type_check
  check (discount_type in ('senior', 'pwd', 'staff', 'promo', 'negotiated', 'package', 'birthday'));

-- Any active staff member may FILL IN a missing birthday (front desk hears
-- it at the register); changing a recorded one is manager+, since an edit
-- to an identity anchor deserves seniority. Runs as definer because front
-- desk holds no UPDATE right on clients.
create or replace function set_client_birthday(p_client uuid, p_month int, p_day int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_has boolean;
begin
  if auth_role() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select birth_month is not null into v_has from clients where id = p_client;
  if v_has is null then
    raise exception 'Client not found.' using errcode = 'no_data_found';
  end if;

  if v_has and auth_role() not in ('owner', 'manager') then
    raise exception 'Only a manager or the owner can change a recorded birthday.'
      using errcode = 'insufficient_privilege';
  end if;

  update clients set birth_month = p_month, birth_day = p_day where id = p_client;
end
$$;

-- Merges carry the birthday to the surviving record when it lacks one.
create or replace function merge_clients(p_loser uuid, p_winner uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_moved int;
begin
  if p_loser = p_winner then
    raise exception 'Pick two different client records to merge.'
      using errcode = 'check_violation', hint = 'merge_same_client';
  end if;

  update tickets set client_id = p_winner where client_id = p_loser;
  get diagnostics v_moved = row_count;

  update packages set client_id = p_winner where client_id = p_loser;
  update clients set referred_by_client_id = p_winner where referred_by_client_id = p_loser;

  update clients w
     set first_visit_on = least(coalesce(w.first_visit_on, l.first_visit_on),
                                coalesce(l.first_visit_on, w.first_visit_on)),
         full_name  = coalesce(w.full_name, l.full_name),
         barangay   = coalesce(w.barangay, l.barangay),
         town       = coalesce(w.town, l.town),
         birth_month = coalesce(w.birth_month, l.birth_month),
         birth_day   = coalesce(w.birth_day, l.birth_day),
         notes      = concat_ws(E'\n', nullif(w.notes, ''), nullif(l.notes, ''))
    from clients l
   where w.id = p_winner and l.id = p_loser;

  update clients set merged_into_id = p_winner where id = p_loser;

  return jsonb_build_object('tickets_moved', v_moved, 'winner', p_winner);
end
$$;

-- New clients created at the register may carry a birthday in the payload.
create or replace function resolve_client(p_client jsonb, p_visit_date date)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id    uuid;
  v_phone text := nullif(btrim(p_client ->> 'phone'), '');
  v_declined boolean := coalesce((p_client ->> 'phone_declined')::boolean, false);
begin
  if p_client ? 'id' and nullif(p_client ->> 'id', '') is not null then
    v_id := surviving_client((p_client ->> 'id')::uuid);
  end if;

  if v_id is null and v_declined then
    v_phone := 'WALKIN-' || replace(gen_random_uuid()::text, '-', '');
  end if;

  if v_id is null and v_phone is null then
    raise exception 'A phone number is required. Use "walk-in, declined" if the client will not give one.'
      using errcode = 'check_violation', hint = 'phone_required';
  end if;

  if v_id is null then
    select surviving_client(id) into v_id from clients where phone = v_phone;
  end if;

  if v_id is null then
    insert into clients (phone, phone_declined, full_name, barangay, town,
                         inquiry_source, referred_by_client_id, first_visit_on,
                         birth_month, birth_day, notes)
    values (v_phone, v_declined,
            nullif(btrim(p_client ->> 'full_name'), ''),
            nullif(btrim(p_client ->> 'barangay'), ''),
            nullif(btrim(p_client ->> 'town'), ''),
            nullif(btrim(p_client ->> 'inquiry_source'), ''),
            nullif(p_client ->> 'referred_by_client_id', '')::uuid,
            p_visit_date,
            nullif(p_client ->> 'birth_month', '')::int,
            nullif(p_client ->> 'birth_day', '')::int,
            nullif(btrim(p_client ->> 'notes'), ''))
    returning id into v_id;
  else
    perform touch_client_first_visit(v_id, p_visit_date,
                                     nullif(btrim(p_client ->> 'full_name'), ''));
  end if;

  return v_id;
end
$$;

-- Birthdays in the next N days, with the client's habits attached so the
-- greeting can be an offer: "her birthday is Thursday, she usually has a
-- hairspa with Elma."
create or replace function f_upcoming_birthdays(p_days int default 30)
returns table (
  client_id uuid, full_name text, phone text, phone_declined boolean,
  birth_month int, birth_day int, days_until int,
  visit_count bigint, last_visit date, lifetime_spend_cents bigint)
language sql stable security invoker set search_path = public as $$
  with base as (
    select c.id, c.full_name, c.phone, c.phone_declined, c.birth_month, c.birth_day,
           -- next occurrence of the birthday, Feb 29 folding to Feb 28 off-leap
           (
             select min(d) from (
               values
                 (make_date(extract(year from business_date())::int, c.birth_month,
                            least(c.birth_day, case when c.birth_month = 2
                                  and extract(year from business_date())::int % 4 <> 0
                                  then 28 else c.birth_day end))),
                 (make_date(extract(year from business_date())::int + 1, c.birth_month,
                            least(c.birth_day, case when c.birth_month = 2
                                  and (extract(year from business_date())::int + 1) % 4 <> 0
                                  then 28 else c.birth_day end)))
             ) as t(d) where d >= business_date()
           ) as next_bday
    from clients c
    where c.birth_month is not null and c.merged_into_id is null and not c.is_pool
  )
  select b.id, b.full_name, b.phone, b.phone_declined, b.birth_month, b.birth_day,
         (b.next_bday - business_date())::int,
         coalesce(r.visit_count, 0)::bigint, r.last_visit,
         coalesce(r.lifetime_spend_cents, 0)::bigint
  from base b
  left join v_client_retention r on r.client_id = b.id
  where b.next_bday - business_date() <= p_days
  order by b.next_bday, r.lifetime_spend_cents desc nulls last
$$;
