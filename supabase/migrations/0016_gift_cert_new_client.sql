-- 0016_gift_cert_new_client.sql — gift certificates as a payment method,
-- and a front-desk override for the new/returning flag.
--
-- - 'gift_cert' joins the payment methods (leg level and header summary),
--   and v_daily_cash gains a gift_cert_cents statement line: money that
--   never enters the drawer, like the paper sheet's Gift Certificates row.
-- - create_ticket accepts an optional is_new_client boolean; when absent
--   the flag is derived from history exactly as before.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

alter table ticket_payments drop constraint if exists ticket_payments_method_check;
alter table ticket_payments add constraint ticket_payments_method_check
  check (method in ('cash', 'gcash', 'maya', 'bank', 'card', 'package', 'comp', 'gift_cert'));

alter table tickets drop constraint if exists tickets_payment_method_check;
alter table tickets add constraint tickets_payment_method_check
  check (payment_method in ('cash', 'online', 'split', 'package', 'comp', 'gift_cert'));

-- ---------------------------------------------------------------------------
-- create_ticket: gift_cert summary + is_new_client override
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
-- v_daily_cash: gift certificate takings as their own statement line
-- (appended column; everything before it is unchanged from 0013).
-- ---------------------------------------------------------------------------

create or replace view v_daily_cash
with (security_invoker = on) as
with days as (
  select branch_id, ticket_date as business_date from tickets where voided_at is null
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
              and t.voided_at is null and tp.method = 'cash'), 0) as cash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method <> 'cash'), 0) as non_cash_takings_cents,
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
              and t.voided_at is null), 0) as gross_sales_cents,
  coalesce((select sum(tl.technician_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as technician_share_cents,
  coalesce((select sum(tl.company_share_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as company_share_cents,
  coalesce((select sum(tl.discount_cents)
            from ticket_lines tl
            join tickets t on t.id = tl.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null), 0) as discounts_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'gcash'), 0) as gcash_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'maya'), 0) as maya_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null
              and tp.method in ('bank', 'card')), 0) as bank_card_takings_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null
              and tp.method in ('package', 'comp')), 0) as package_comp_cents,
  coalesce((select sum(tp.amount_cents)
            from ticket_payments tp
            join tickets t on t.id = tp.ticket_id
            where t.branch_id = d.branch_id and t.ticket_date = d.business_date
              and t.voided_at is null and tp.method = 'gift_cert'), 0) as gift_cert_cents
from days d
left join cash_days cd
  on cd.branch_id = d.branch_id and cd.business_date = d.business_date;

select 'gift_cert accepted' as check_constraints
where exists (select 1 from information_schema.check_constraints
              where constraint_name = 'ticket_payments_method_check'
                and check_clause like '%gift_cert%');
