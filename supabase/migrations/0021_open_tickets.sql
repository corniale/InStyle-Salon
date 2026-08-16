-- 0021_open_tickets.sql — the Open ticket stage (park, resume, bill).
--
-- A ticket can now be started when the client sits down — client, first
-- services, TS# assigned immediately, no payments — and billed later.
-- Lifecycle: open -> closed -> (void / revise). Open tickets:
--   - appear in the ticket list and the new Open tickets strip,
--   - count NOWHERE in sales, analytics or Daily cash until closed,
--   - can be edited (lines replaced) by any branch staff while open,
--   - block the cash day from closing until billed or voided.
-- Front desk may open, edit and bill tickets but still cannot void:
-- the narrow update policy refuses to set voided_at.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

alter table tickets
  add column if not exists status text not null default 'closed'
    check (status in ('open', 'closed'));

create index if not exists tickets_open_idx
  on tickets (branch_id, ticket_date) where status = 'open';

-- ---------------------------------------------------------------------------
-- Analytics see closed tickets only.
-- ---------------------------------------------------------------------------

create or replace view v_ticket_lines_active
with (security_invoker = on) as
select
  tl.id                    as line_id,
  tl.ticket_id,
  t.branch_id,
  b.code                   as branch_code,
  b.name                   as branch_name,
  t.ticket_date,
  date_trunc('month', t.ticket_date)::date as month,
  t.client_id,
  t.is_new_client,
  t.payment_method,
  t.started_at,
  t.ended_at,
  tl.service_id,
  s.name                   as service_name,
  s.service_type_id,
  st.name                  as service_type_name,
  s.default_sharing_rate,
  s.default_duration_min,
  tl.technician_id,
  tech.full_name           as technician_name,
  tl.assist_technician_id,
  tl.qty,
  tl.unit_price_cents,
  tl.discount_type,
  tl.discount_cents,
  tl.sharing_rate,
  tl.rating,
  tl.total_cents,
  tl.company_share_cents,
  tl.technician_share_cents,
  coalesce(
    nullif(extract(epoch from (tl.ended_at - tl.started_at)) / 60, 0),
    nullif(extract(epoch from (t.ended_at - t.started_at)) / 60, 0)
      / nullif(count(*) over (partition by tl.ticket_id), 0),
    s.default_duration_min * tl.qty
  )::numeric(10,2) as attributed_minutes,
  b.business_id,
  biz.code                 as business_code,
  tl.is_upsell,
  tl.started_at            as line_started_at,
  tl.ended_at              as line_ended_at
from ticket_lines tl
join tickets t       on t.id = tl.ticket_id and t.voided_at is null
                    and t.status = 'closed'
join branches b      on b.id = t.branch_id
join businesses biz  on biz.id = b.business_id
join services s      on s.id = tl.service_id
join service_types st on st.id = s.service_type_id
join technicians tech on tech.id = tl.technician_id;

create or replace view v_client_visits
with (security_invoker = on) as
select
  t.client_id,
  t.ticket_date        as visit_date,
  (array_agg(t.branch_id order by t.created_at))[1] as branch_id,
  count(*)             as tickets,
  sum(tl.total_cents)  as spend_cents,
  sum(tl.company_share_cents) as company_share_cents,
  row_number() over (partition by t.client_id order by t.ticket_date) as visit_seq,
  t.ticket_date - lag(t.ticket_date) over (
    partition by t.client_id order by t.ticket_date) as days_since_previous
from tickets t
join ticket_lines tl on tl.ticket_id = t.id
where t.voided_at is null and t.status = 'closed'
group by t.client_id, t.ticket_date;

create or replace view v_daily_cash
with (security_invoker = on) as
with days as (
  select branch_id, ticket_date as business_date from tickets
  where voided_at is null and status = 'closed'
  union
  select branch_id, spent_on from expenses
  union
  select branch_id, business_date from cash_days
)
select
  d.branch_id,
  d.business_date,
  coalesce(cd.opening_float_cents, 0) as opening_float_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method = 'cash'), 0) as cash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method <> 'cash'), 0) as non_cash_takings_cents,
  coalesce((select sum(e.amount_cents) from expenses e
            where e.branch_id = d.branch_id and e.spent_on = d.business_date
              and e.paid_from = 'cash'), 0) as cash_expenses_cents,
  coalesce((select sum(e.amount_cents) from expenses e
            where e.branch_id = d.branch_id and e.spent_on = d.business_date), 0) as expenses_cents,
  expected_cash(d.branch_id, d.business_date) as expected_cash_cents,
  cd.counted_cash_cents,
  case when cd.counted_cash_cents is null then null
       else cd.counted_cash_cents - expected_cash(d.branch_id, d.business_date) end as variance_cents,
  cd.closed_at,
  cd.note,
  coalesce((select sum(tl.total_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'), 0) as gross_sales_cents,
  coalesce((select sum(tl.technician_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'), 0) as technician_share_cents,
  coalesce((select sum(tl.company_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'), 0) as company_share_cents,
  coalesce((select sum(tl.discount_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'), 0) as discounts_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method = 'gcash'), 0) as gcash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method = 'maya'), 0) as maya_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method in ('bank', 'card')), 0) as bank_card_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method in ('package', 'comp')), 0) as package_comp_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and t.status = 'closed'
              and tp.method = 'gift_cert'), 0) as gift_cert_cents
from days d
left join cash_days cd
  on cd.branch_id = d.branch_id and cd.business_date = d.business_date;

-- ---------------------------------------------------------------------------
-- RLS: any branch staff may edit an open ticket (replace lines, bill it),
-- but the WITH CHECK refuses to set voided_at — voiding stays manager+.
-- ---------------------------------------------------------------------------

drop policy if exists tickets_close_open on tickets;
create policy tickets_close_open on tickets
  for update to authenticated
  using (can_read_branch(branch_id) and status = 'open' and voided_at is null)
  with check (can_read_branch(branch_id) and voided_at is null);

drop policy if exists ticket_lines_delete_open on ticket_lines;
create policy ticket_lines_delete_open on ticket_lines
  for delete to authenticated using (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id)
              and t.voided_at is null and t.status = 'open')
  );

-- ---------------------------------------------------------------------------
-- open_ticket: park the client's slip. Client resolved, lines recorded,
-- TS# assigned; no payments, nothing counted anywhere yet.
-- ---------------------------------------------------------------------------

create or replace function open_ticket(p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_key    text := nullif(btrim(p_payload ->> 'idempotency_key'), '');
  v_branch uuid := (p_payload ->> 'branch_id')::uuid;
  v_date   date := coalesce(nullif(p_payload ->> 'ticket_date', '')::date, business_date());
  v_ticket tickets;
  v_client uuid;
  v_is_new boolean;
  v_line   jsonb;
  v_n      int := 0;
begin
  if v_key is null then
    raise exception 'A ticket needs an idempotency key.'
      using errcode = 'check_violation', hint = 'idempotency_key_required';
  end if;
  if v_branch is null or not can_read_branch(v_branch) then
    raise exception 'You do not have access to that branch.'
      using errcode = 'insufficient_privilege', hint = 'branch_forbidden';
  end if;

  select * into v_ticket from tickets where idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'ticket_id', v_ticket.id, 'series_no', v_ticket.series_no,
      'client_id', v_ticket.client_id, 'duplicate', true);
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
  v_is_new := coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean, v_is_new);

  insert into tickets (branch_id, client_id, ticket_date, started_at, ended_at,
                       payment_method, is_new_client, idempotency_key, created_by, status)
  values (v_branch, v_client, v_date,
          (select min(nullif(x ->> 'started_at', '')::timestamptz)
           from jsonb_array_elements(p_payload -> 'lines') x),
          null,
          'cash', v_is_new, v_key, auth.uid(), 'open')
  returning * into v_ticket;

  for v_line in select * from jsonb_array_elements(p_payload -> 'lines')
  loop
    v_n := v_n + 1;
    insert into ticket_lines (ticket_id, service_id, technician_id, assist_technician_id,
                              qty, unit_price_cents, discount_type, discount_cents,
                              sharing_rate, rating, line_number,
                              is_upsell, started_at, ended_at)
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
            v_n,
            coalesce(nullif(v_line ->> 'is_upsell', '')::boolean, false),
            nullif(v_line ->> 'started_at', '')::timestamptz,
            nullif(v_line ->> 'ended_at', '')::timestamptz);
  end loop;

  return jsonb_build_object(
    'ticket_id', v_ticket.id, 'series_no', v_ticket.series_no,
    'client_id', v_client, 'status', 'open', 'duplicate', false);
end
$$;

-- ---------------------------------------------------------------------------
-- save_open_ticket: replace an open ticket's lines with the payload's;
-- p_close = true also records payments, validates the totals and closes.
-- ---------------------------------------------------------------------------

create or replace function save_open_ticket(
  p_ticket uuid, p_payload jsonb, p_close boolean)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_ticket  tickets;
  v_line    jsonb;
  v_line_id uuid;
  v_n       int := 0;
  v_total   bigint := 0;
  v_paid    bigint := 0;
  v_pay     jsonb;
  v_methods text[] := '{}';
begin
  select * into v_ticket from tickets where id = p_ticket;
  if not found or v_ticket.voided_at is not null or v_ticket.status <> 'open' then
    raise exception 'That ticket is not open.'
      using errcode = 'check_violation', hint = 'not_open';
  end if;

  if jsonb_array_length(coalesce(p_payload -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'A ticket needs at least one service line.'
      using errcode = 'check_violation', hint = 'lines_required';
  end if;

  delete from ticket_lines where ticket_id = p_ticket;

  for v_line in select * from jsonb_array_elements(p_payload -> 'lines')
  loop
    v_n := v_n + 1;
    insert into ticket_lines (ticket_id, service_id, technician_id, assist_technician_id,
                              qty, unit_price_cents, discount_type, discount_cents,
                              sharing_rate, rating, line_number,
                              is_upsell, started_at, ended_at)
    values (p_ticket,
            (v_line ->> 'service_id')::uuid,
            (v_line ->> 'technician_id')::uuid,
            nullif(v_line ->> 'assist_technician_id', '')::uuid,
            coalesce((v_line ->> 'qty')::int, 1),
            (v_line ->> 'unit_price_cents')::bigint,
            nullif(v_line ->> 'discount_type', ''),
            coalesce((v_line ->> 'discount_cents')::bigint, 0),
            (v_line ->> 'sharing_rate')::numeric,
            nullif(v_line ->> 'rating', '')::int,
            v_n,
            coalesce(nullif(v_line ->> 'is_upsell', '')::boolean, false),
            nullif(v_line ->> 'started_at', '')::timestamptz,
            nullif(v_line ->> 'ended_at', '')::timestamptz)
    returning id into v_line_id;

    if p_close and nullif(v_line ->> 'package_id', '') is not null then
      insert into package_sessions (package_id, ticket_line_id, used_on)
      values ((v_line ->> 'package_id')::uuid, v_line_id, v_ticket.ticket_date);
    end if;
  end loop;

  select coalesce(sum(total_cents), 0) into v_total
  from ticket_lines where ticket_id = p_ticket;

  if not p_close then
    update tickets
       set started_at = coalesce(
             nullif(p_payload ->> 'started_at', '')::timestamptz,
             (select min(nullif(x ->> 'started_at', '')::timestamptz)
              from jsonb_array_elements(p_payload -> 'lines') x)),
           is_new_client = coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean,
                                    is_new_client)
     where id = p_ticket;
    return jsonb_build_object(
      'ticket_id', p_ticket, 'series_no', v_ticket.series_no,
      'status', 'open', 'total_cents', v_total);
  end if;

  for v_pay in select * from jsonb_array_elements(
    case when jsonb_array_length(coalesce(p_payload -> 'payments', '[]'::jsonb)) = 0
         then jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', v_total))
         else p_payload -> 'payments' end)
  loop
    insert into ticket_payments (ticket_id, method, amount_cents, reference)
    values (p_ticket,
            v_pay ->> 'method',
            (v_pay ->> 'amount_cents')::bigint,
            nullif(btrim(v_pay ->> 'reference'), ''));
  end loop;

  select coalesce(sum(amount_cents), 0), coalesce(array_agg(distinct method), '{}')
    into v_paid, v_methods
  from ticket_payments where ticket_id = p_ticket;

  if v_paid <> v_total then
    raise exception 'Payments total % but the ticket totals %.', v_paid, v_total
      using errcode = 'check_violation', hint = 'payment_mismatch';
  end if;

  update tickets
     set status = 'closed',
         started_at = coalesce(
           nullif(p_payload ->> 'started_at', '')::timestamptz,
           (select min(nullif(x ->> 'started_at', '')::timestamptz)
            from jsonb_array_elements(p_payload -> 'lines') x)),
         ended_at = coalesce(
           nullif(p_payload ->> 'ended_at', '')::timestamptz,
           (select max(nullif(x ->> 'ended_at', '')::timestamptz)
            from jsonb_array_elements(p_payload -> 'lines') x)),
         payment_method = case
           when array_length(v_methods, 1) > 1 then 'split'
           when v_methods[1] in ('package', 'comp', 'gift_cert') then v_methods[1]
           when v_methods[1] is null or v_methods[1] = 'cash' then 'cash'
           else 'online' end,
         is_new_client = coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean,
                                  is_new_client)
   where id = p_ticket;

  return jsonb_build_object(
    'ticket_id', p_ticket, 'series_no', v_ticket.series_no,
    'status', 'closed', 'total_cents', v_total);
end
$$;

-- ---------------------------------------------------------------------------
-- A cash day cannot close while the branch still holds open tickets —
-- the enforced version of the paper sheet's "TS#s used: OK".
-- ---------------------------------------------------------------------------

create or replace function close_cash_day(
  p_branch uuid, p_date date, p_counted_cents bigint, p_note text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_expected bigint;
  v_row      cash_days;
  v_open     text;
begin
  select string_agg(coalesce(series_no, '?'), ', ' order by series_no) into v_open
  from tickets
  where branch_id = p_branch and ticket_date = p_date
    and status = 'open' and voided_at is null;

  if v_open is not null then
    raise exception 'Open tickets remain (TS# %). Bill or void them before closing the day.', v_open
      using errcode = 'check_violation', hint = 'open_tickets';
  end if;

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

select count(*) filter (where status = 'open') as open_tickets,
       count(*) as total_tickets
from tickets;
