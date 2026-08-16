-- 0017_upsell_line_times.sql — per-line upsell flag and per-line times.
--
-- - ticket_lines.is_upsell marks a service the technician sold on top of
--   what the client came in for; the technician ranking gains an upsell
--   rate credited to the performing technician.
-- - ticket_lines.started_at / ended_at move timing to the service level.
--   A line's own span now beats the old ticket-span-split when attributing
--   busy minutes; the ticket header keeps min/max of its lines so existing
--   day-level analytics keep working.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

alter table ticket_lines
  add column if not exists is_upsell boolean not null default false,
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz;

alter table ticket_lines drop constraint if exists ticket_lines_time_order_check;
alter table ticket_lines add constraint ticket_lines_time_order_check
  check (started_at is null or ended_at is null or ended_at >= started_at);

-- ---------------------------------------------------------------------------
-- v_ticket_lines_active: attributed_minutes now prefers the line's own span;
-- is_upsell and the line times are appended at the end (create or replace
-- may only append).
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
join branches b      on b.id = t.branch_id
join businesses biz  on biz.id = b.business_id
join services s      on s.id = tl.service_id
join service_types st on st.id = s.service_type_id
join technicians tech on tech.id = tl.technician_id;

-- ---------------------------------------------------------------------------
-- create_ticket: per-line is_upsell and times; header times default to the
-- min/max of the lines when not sent explicitly.
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
  v_started    timestamptz := nullif(p_payload ->> 'started_at', '')::timestamptz;
  v_ended      timestamptz := nullif(p_payload ->> 'ended_at', '')::timestamptz;
  v_line       jsonb;
  v_line_id    uuid;
  v_n          int := 0;
  v_total      bigint := 0;
  v_paid       bigint := 0;
  v_pay        jsonb;
  v_methods    text[] := '{}';
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

  -- Derived from history, but the front desk can override it — they may
  -- know a "new" phone number belongs to a long-time client, or vice versa.
  select not exists (
    select 1 from tickets t
    where t.client_id = v_client and t.voided_at is null and t.ticket_date <= v_date
  ) into v_is_new;
  v_is_new := coalesce(nullif(p_payload ->> 'is_new_client', '')::boolean, v_is_new);

  -- Header times summarise the lines when not sent explicitly.
  select coalesce(v_started, min(nullif(x ->> 'started_at', '')::timestamptz)),
         coalesce(v_ended,   max(nullif(x ->> 'ended_at', '')::timestamptz))
    into v_started, v_ended
  from jsonb_array_elements(p_payload -> 'lines') x;

  -- The header's payment_method summarises the payment rows (edge case 19).
  -- It is derived from the payload up front because the inserting role may
  -- not hold UPDATE on tickets — front desk can create but never modify.
  select coalesce(sum((x ->> 'amount_cents')::bigint), 0),
         coalesce(array_agg(distinct x ->> 'method'), '{}')
    into v_paid, v_methods
  from jsonb_array_elements(coalesce(p_payload -> 'payments', '[]'::jsonb)) x;

  insert into tickets (branch_id, client_id, ticket_date, started_at, ended_at,
                       payment_method, online_ref, is_new_client, idempotency_key, created_by)
  values (v_branch, v_client, v_date, v_started, v_ended,
          case
            when array_length(v_methods, 1) > 1 then 'split'
            when v_methods[1] in ('package', 'comp', 'gift_cert') then v_methods[1]
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
            nullif(v_line ->> 'ended_at', '')::timestamptz)
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
-- Technician ranking gains the upsell rate (credited to the performing
-- technician). Return type changes, so drop-and-recreate.
-- ---------------------------------------------------------------------------

drop function if exists f_technician_ranking(uuid, date, date, int);

create function f_technician_ranking(
  p_branch uuid default null, p_from date default null, p_to date default null,
  p_min_tickets int default 10)
returns table (
  technician_id uuid, technician_name text, branch_id uuid, branch_code text,
  tickets bigint, lines bigint, revenue_cents bigint, company_share_cents bigint,
  distinct_clients bigint, repeat_clients bigint, client_retention_pct numeric,
  avg_rating numeric, rated_pct numeric,
  upsell_lines bigint, upsell_pct numeric,
  expected_margin_pct numeric, actual_margin_pct numeric, margin_vs_expected_pts numeric,
  busy_minutes numeric, scheduled_minutes numeric, utilisation_pct numeric,
  ranked boolean)
language sql stable security invoker set search_path = public as $$
  with l as (
    select * from v_ticket_lines_active
    where (p_branch is null or branch_id = p_branch)
      and (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
  ),
  base as (
    select l.technician_id, l.technician_name, l.branch_id, l.branch_code,
           count(distinct l.ticket_id)::bigint as tickets,
           count(*)::bigint as lines,
           sum(l.total_cents)::bigint as revenue_cents,
           sum(l.company_share_cents)::bigint as company_share_cents,
           count(distinct l.client_id)::bigint as distinct_clients,
           round(avg(l.rating) filter (where l.rating is not null), 2) as avg_rating,
           round(count(l.rating)::numeric / nullif(count(*), 0) * 100, 1) as rated_pct,
           count(*) filter (where l.is_upsell)::bigint as upsell_lines,
           round(count(*) filter (where l.is_upsell)::numeric
                 / nullif(count(*), 0) * 100, 1) as upsell_pct,
           round(sum(l.total_cents * l.default_sharing_rate)::numeric
                 / nullif(sum(l.total_cents), 0) * 100, 1) as expected_margin_pct,
           round(sum(l.company_share_cents)::numeric
                 / nullif(sum(l.total_cents), 0) * 100, 1) as actual_margin_pct,
           sum(l.attributed_minutes) as busy_minutes
    from l group by l.technician_id, l.technician_name, l.branch_id, l.branch_code
  ),
  repeats as (
    select l.technician_id, count(distinct l.client_id)::bigint as repeat_clients
    from l
    where exists (select 1 from v_ticket_lines_active prior
                  where prior.client_id = l.client_id
                    and prior.technician_id = l.technician_id
                    and prior.ticket_date < l.ticket_date)
    group by l.technician_id
  ),
  sched as (
    select sb.technician_id,
           sum(extract(epoch from (sb.end_time - sb.start_time)) / 60)::numeric as scheduled_minutes
    from shift_blocks sb
    where (p_branch is null or sb.branch_id = p_branch)
      and (p_from is null or sb.work_date >= p_from)
      and (p_to   is null or sb.work_date <= p_to)
    group by sb.technician_id
  )
  select base.technician_id, base.technician_name, base.branch_id, base.branch_code,
         base.tickets, base.lines, base.revenue_cents, base.company_share_cents,
         base.distinct_clients,
         coalesce(r.repeat_clients, 0),
         round(coalesce(r.repeat_clients, 0)::numeric / nullif(base.distinct_clients, 0) * 100, 1),
         base.avg_rating, base.rated_pct,
         base.upsell_lines, base.upsell_pct,
         base.expected_margin_pct, base.actual_margin_pct,
         base.actual_margin_pct - base.expected_margin_pct,
         round(base.busy_minutes, 1), round(s.scheduled_minutes, 1),
         round(base.busy_minutes / nullif(s.scheduled_minutes, 0) * 100, 1),
         base.tickets >= p_min_tickets
  from base
  left join repeats r on r.technician_id = base.technician_id
  left join sched s on s.technician_id = base.technician_id
  order by base.tickets >= p_min_tickets desc, base.company_share_cents desc
$$;

select count(*) as ranking_rows,
       count(*) filter (where upsell_pct is not null) as with_upsell_pct
from f_technician_ranking(null, null, null, 10);
