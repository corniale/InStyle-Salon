-- inStyle Salon — write paths that must be atomic.
-- All of these run SECURITY INVOKER, so RLS still decides what the caller
-- may touch. They exist for atomicity and idempotency, not to bypass policy.

-- ---------------------------------------------------------------------------
-- Client resolution
-- ---------------------------------------------------------------------------

-- Follows a merge chain to the surviving record (edge case 3).
create or replace function surviving_client(p_client uuid)
returns uuid language plpgsql stable security invoker set search_path = public as $$
declare
  v_id   uuid := p_client;
  v_next uuid;
  v_hops int := 0;
begin
  loop
    select merged_into_id into v_next from clients where id = v_id;
    exit when v_next is null or v_hops > 10;
    v_id := v_next;
    v_hops := v_hops + 1;
  end loop;
  return v_id;
end
$$;

-- first_visit_on is maintained by the system, not edited by staff: a
-- backdated ticket can predate what we thought was the first visit. Front
-- desk cannot UPDATE clients directly, so this runs as definer and touches
-- only the two fields it names.
create or replace function touch_client_first_visit(
  p_client uuid, p_visit_date date, p_full_name text default null)
returns void language sql security definer set search_path = public as $$
  update clients
     set first_visit_on = least(coalesce(first_visit_on, p_visit_date), p_visit_date),
         full_name = coalesce(full_name, p_full_name)
   where id = p_client
$$;

-- Resolves a client from a ticket payload: by id, else by phone, else creates
-- one. A phone number already on file returns that client rather than
-- erroring (edge case 2).
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
    -- A walk-in who declined to give a number still gets a stable key, and
    -- the decline is recorded so the rate is reportable (open question 1).
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
                         inquiry_source, referred_by_client_id, first_visit_on, notes)
    values (v_phone, v_declined,
            nullif(btrim(p_client ->> 'full_name'), ''),
            nullif(btrim(p_client ->> 'barangay'), ''),
            nullif(btrim(p_client ->> 'town'), ''),
            nullif(btrim(p_client ->> 'inquiry_source'), ''),
            nullif(p_client ->> 'referred_by_client_id', '')::uuid,
            p_visit_date,
            nullif(btrim(p_client ->> 'notes'), ''))
    returning id into v_id;
  else
    perform touch_client_first_visit(v_id, p_visit_date,
                                     nullif(btrim(p_client ->> 'full_name'), ''));
  end if;

  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Ticket creation — one call, one transaction, replay-safe
-- ---------------------------------------------------------------------------

create or replace function create_ticket(p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_key        text := nullif(btrim(p_payload ->> 'idempotency_key'), '');
  v_branch     uuid := (p_payload ->> 'branch_id')::uuid;
  v_date       date := coalesce(nullif(p_payload ->> 'ticket_date', '')::date, business_date());
  v_ticket     tickets;
  v_client     uuid;
  v_is_new     boolean;
  v_line       jsonb;
  v_line_id    uuid;
  v_n          int := 0;
  v_total      bigint := 0;
  v_paid       bigint := 0;
  v_pay        jsonb;
  v_methods    text[] := '{}';
  v_method     text;
begin
  if v_key is null then
    raise exception 'A ticket needs an idempotency key.'
      using errcode = 'check_violation', hint = 'idempotency_key_required';
  end if;

  -- Branch switcher without permission for the target branch (edge case 35):
  -- a clean refusal here, and RLS behind it in case this check is bypassed.
  if v_branch is null or not can_read_branch(v_branch) then
    raise exception 'You do not have access to that branch.'
      using errcode = 'insufficient_privilege', hint = 'branch_forbidden';
  end if;

  -- Replay of an already-accepted ticket is a success, not a duplicate
  -- (offline mechanism, point 4).
  select * into v_ticket from tickets where idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'ticket_id', v_ticket.id,
      'series_no', v_ticket.series_no,
      'client_id', v_ticket.client_id,
      'duplicate', true);
  end if;

  if jsonb_array_length(coalesce(p_payload -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'A ticket needs at least one service line.'
      using errcode = 'check_violation', hint = 'lines_required';
  end if;

  v_client := resolve_client(coalesce(p_payload -> 'client', '{}'::jsonb), v_date);

  select not exists (
    select 1 from tickets t
    where t.client_id = v_client and t.voided_at is null and t.ticket_date <= v_date
  ) into v_is_new;

  -- The header's payment_method summarises the payment rows (edge case 19).
  -- It is derived from the payload up front because the inserting role may
  -- not hold UPDATE on tickets — front desk can create but never modify.
  select coalesce(sum((x ->> 'amount_cents')::bigint), 0),
         coalesce(array_agg(distinct x ->> 'method'), '{}')
    into v_paid, v_methods
  from jsonb_array_elements(coalesce(p_payload -> 'payments', '[]'::jsonb)) x;

  insert into tickets (branch_id, client_id, ticket_date, started_at, ended_at,
                       payment_method, online_ref, is_new_client, idempotency_key, created_by)
  values (v_branch, v_client, v_date,
          nullif(p_payload ->> 'started_at', '')::timestamptz,
          nullif(p_payload ->> 'ended_at', '')::timestamptz,
          case
            when array_length(v_methods, 1) > 1 then 'split'
            when v_methods[1] in ('package', 'comp') then v_methods[1]
            when v_methods[1] is null or v_methods[1] = 'cash' then 'cash'
            else 'online' end,
          nullif(btrim(p_payload ->> 'online_ref'), ''),
          v_is_new, v_key, auth.uid())
  returning * into v_ticket;

  for v_line in select * from jsonb_array_elements(p_payload -> 'lines')
  loop
    v_n := v_n + 1;

    insert into ticket_lines (ticket_id, service_id, technician_id, assist_technician_id,
                              qty, unit_price_cents, discount_type, discount_cents,
                              sharing_rate, rating, line_number)
    values (v_ticket.id,
            (v_line ->> 'service_id')::uuid,
            (v_line ->> 'technician_id')::uuid,
            nullif(v_line ->> 'assist_technician_id', '')::uuid,
            coalesce((v_line ->> 'qty')::int, 1),
            (v_line ->> 'unit_price_cents')::bigint,
            nullif(v_line ->> 'discount_type', ''),
            coalesce((v_line ->> 'discount_cents')::bigint, 0),
            (v_line ->> 'sharing_rate')::numeric,
            nullif(v_line ->> 'rating', '')::int,
            v_n)
    returning id into v_line_id;

    if nullif(v_line ->> 'package_id', '') is not null then
      insert into package_sessions (package_id, ticket_line_id, used_on)
      values ((v_line ->> 'package_id')::uuid, v_line_id, v_date);
    end if;
  end loop;

  select coalesce(sum(total_cents), 0) into v_total
  from ticket_lines where ticket_id = v_ticket.id;

  for v_pay in select * from jsonb_array_elements(
    case when jsonb_array_length(coalesce(p_payload -> 'payments', '[]'::jsonb)) = 0
         then jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', v_total))
         else p_payload -> 'payments' end)
  loop
    insert into ticket_payments (ticket_id, method, amount_cents, reference)
    values (v_ticket.id,
            v_pay ->> 'method',
            (v_pay ->> 'amount_cents')::bigint,
            nullif(btrim(v_pay ->> 'reference'), ''));
  end loop;

  select coalesce(sum(amount_cents), 0) into v_paid
  from ticket_payments where ticket_id = v_ticket.id;

  if v_paid <> v_total then
    raise exception 'Payments total % but the ticket totals %.', v_paid, v_total
      using errcode = 'check_violation', hint = 'payment_mismatch';
  end if;

  return jsonb_build_object(
    'ticket_id', v_ticket.id,
    'series_no', v_ticket.series_no,
    'client_id', v_client,
    'is_new_client', v_is_new,
    'total_cents', v_total,
    'duplicate', false);
end
$$;

-- ---------------------------------------------------------------------------
-- Void
-- ---------------------------------------------------------------------------

create or replace function void_ticket(p_ticket uuid, p_reason text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A void needs a reason.'
      using errcode = 'check_violation', hint = 'void_reason_required';
  end if;

  update tickets
     set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   where id = p_ticket and voided_at is null;

  if not found then
    raise exception 'That ticket does not exist, is already void, or is not yours to void.'
      using errcode = 'no_data_found', hint = 'void_failed';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Client merge — keeps both visit histories (edge case 3)
-- ---------------------------------------------------------------------------

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
         notes      = concat_ws(E'\n', nullif(w.notes, ''), nullif(l.notes, ''))
    from clients l
   where w.id = p_winner and l.id = p_loser;

  -- The loser is kept, not deleted: the merge itself is history.
  update clients set merged_into_id = p_winner where id = p_loser;

  return jsonb_build_object('tickets_moved', v_moved, 'winner', p_winner);
end
$$;

-- ---------------------------------------------------------------------------
-- Cash day
-- ---------------------------------------------------------------------------

create or replace function close_cash_day(
  p_branch uuid, p_date date, p_counted_cents bigint, p_note text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_expected bigint;
  v_row      cash_days;
begin
  insert into cash_days (branch_id, business_date, counted_cash_cents, note)
  values (p_branch, p_date, p_counted_cents, nullif(btrim(p_note), ''))
  on conflict (branch_id, business_date) do update
    set counted_cash_cents = excluded.counted_cash_cents,
        note = coalesce(excluded.note, cash_days.note)
  returning * into v_row;

  v_expected := expected_cash(p_branch, p_date);

  update cash_days
     set closed_at = now(), closed_by = auth.uid()
   where id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'expected_cents', v_expected,
    'counted_cents', v_row.counted_cash_cents,
    'variance_cents', v_row.counted_cash_cents - v_expected,
    'closed_at', v_row.closed_at);
end
$$;

create or replace function reopen_cash_day(p_branch uuid, p_date date)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update cash_days
     set closed_at = null, closed_by = null
   where branch_id = p_branch and business_date = p_date and closed_at is not null;

  if not found then
    raise exception 'That day is not closed.'
      using errcode = 'no_data_found', hint = 'not_closed';
  end if;
end
$$;
