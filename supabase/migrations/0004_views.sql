-- inStyle Salon — derived views.
-- Analytics read from here, never from raw tables, so a metric has one
-- definition. Every view is security_invoker so it inherits the caller's RLS
-- rather than the view owner's.

-- ---------------------------------------------------------------------------
-- The spine: active lines with everything joined on
-- ---------------------------------------------------------------------------

create view v_ticket_lines_active
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
  -- Minutes attributed to this line: the ticket's own span shared across its
  -- lines when the times were recorded, otherwise the catalogue duration.
  -- Stage 1 approximates; Stage 2 replaces this with real scheduling.
  coalesce(
    nullif(extract(epoch from (t.ended_at - t.started_at)) / 60, 0)
      / nullif(count(*) over (partition by tl.ticket_id), 0),
    s.default_duration_min * tl.qty
  )::numeric(10,2) as attributed_minutes
from ticket_lines tl
join tickets t       on t.id = tl.ticket_id and t.voided_at is null
join branches b      on b.id = t.branch_id
join services s      on s.id = tl.service_id
join service_types st on st.id = s.service_type_id
join technicians tech on tech.id = tl.technician_id;

-- ---------------------------------------------------------------------------
-- Visits and retention
-- ---------------------------------------------------------------------------

create view v_client_visits
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
where t.voided_at is null
group by t.client_id, t.ticket_date;

create view v_client_retention
with (security_invoker = on) as
with gaps as (
  select client_id,
         count(*)                       as visit_count,
         min(visit_date)                as first_visit,
         max(visit_date)                as last_visit,
         sum(spend_cents)               as lifetime_spend_cents,
         sum(company_share_cents)       as lifetime_company_share_cents,
         -- Undefined, not zero, for a client with a single visit (edge case 26).
         percentile_cont(0.5) within group (
           order by days_since_previous) filter (where days_since_previous is not null)
                                        as median_interval_days
  from v_client_visits
  group by client_id
)
select
  c.id as client_id,
  c.full_name,
  c.phone,
  c.phone_declined,
  c.town,
  c.barangay,
  g.visit_count,
  g.first_visit,
  g.last_visit,
  g.lifetime_spend_cents,
  g.lifetime_company_share_cents,
  round(g.median_interval_days)::int as median_interval_days,
  case
    when g.median_interval_days is null then null
    else (business_date() - g.last_visit) - round(g.median_interval_days)::int
  end as days_overdue,
  case
    when g.visit_count = 1 then 'never_returned'
    when g.median_interval_days is null then 'unknown'
    when (business_date() - g.last_visit) > round(g.median_interval_days)::int * 2 then 'lapsed'
    when (business_date() - g.last_visit) > round(g.median_interval_days)::int then 'at_risk'
    else 'active'
  end as status
from clients c
join gaps g on g.client_id = c.id
where c.merged_into_id is null;

-- ---------------------------------------------------------------------------
-- Service margin, per branch per month
-- ---------------------------------------------------------------------------

create view v_service_margin
with (security_invoker = on) as
select
  branch_id,
  branch_code,
  service_id,
  service_name,
  service_type_name,
  month,
  sum(qty)                     as units,
  count(*)                     as lines,
  sum(total_cents)             as revenue_cents,
  sum(company_share_cents)     as company_share_cents,
  sum(discount_cents)          as discount_cents,
  -- nullif keeps a zero-revenue month from dividing by zero (edge case 29).
  round(sum(company_share_cents)::numeric
        / nullif(sum(total_cents), 0) * 100, 1) as margin_pct,
  round(avg(rating) filter (where rating is not null), 2) as avg_rating,
  count(rating) filter (where rating is not null) as rated_lines
from v_ticket_lines_active
group by branch_id, branch_code, service_id, service_name, service_type_name, month;

-- ---------------------------------------------------------------------------
-- Technician performance, per branch per month
-- ---------------------------------------------------------------------------

create view v_technician_utilisation
with (security_invoker = on) as
with busy as (
  select technician_id, branch_id, ticket_date,
         sum(attributed_minutes) as busy_minutes
  from v_ticket_lines_active
  group by technician_id, branch_id, ticket_date
),
scheduled as (
  select technician_id, branch_id, work_date,
         sum(extract(epoch from (end_time - start_time)) / 60) as scheduled_minutes
  from shift_blocks
  group by technician_id, branch_id, work_date
)
select
  coalesce(b.technician_id, s.technician_id) as technician_id,
  coalesce(b.branch_id, s.branch_id)         as branch_id,
  coalesce(b.ticket_date, s.work_date)       as work_date,
  coalesce(b.busy_minutes, 0)::numeric(10,2) as busy_minutes,
  s.scheduled_minutes::numeric(10,2)         as scheduled_minutes,
  -- Null, not zero, when nobody was scheduled: an unscheduled day has no
  -- utilisation to report (edge case 29).
  round(coalesce(b.busy_minutes, 0) / nullif(s.scheduled_minutes, 0) * 100, 1) as utilisation_pct
from busy b
full outer join scheduled s
  on s.technician_id = b.technician_id and s.work_date = b.ticket_date;

create view v_technician_performance
with (security_invoker = on) as
with base as (
  select
    technician_id,
    technician_name,
    branch_id,
    branch_code,
    month,
    count(*)                                as lines,
    sum(total_cents)                        as revenue_cents,
    sum(company_share_cents)                as company_share_cents,
    count(distinct client_id)               as distinct_clients,
    count(distinct ticket_id)               as tickets,
    round(avg(rating) filter (where rating is not null), 2) as avg_rating,
    count(rating) filter (where rating is not null)         as rated_lines,
    -- What the company would have kept on this mix at catalogue rates. Raw
    -- margin by technician punishes people for the price list, not their
    -- work: nail work sits at 50-58%, hair at 70%.
    round(sum(total_cents * default_sharing_rate)::numeric
          / nullif(sum(total_cents), 0) * 100, 1) as expected_margin_pct,
    round(sum(company_share_cents)::numeric
          / nullif(sum(total_cents), 0) * 100, 1) as actual_margin_pct,
    sum(attributed_minutes)                 as busy_minutes
  from v_ticket_lines_active
  group by technician_id, technician_name, branch_id, branch_code, month
),
repeats as (
  select l.technician_id,
         date_trunc('month', l.ticket_date)::date as month,
         count(distinct l.client_id) as repeat_clients
  from v_ticket_lines_active l
  where exists (
    select 1 from v_ticket_lines_active prior
    where prior.client_id = l.client_id
      and prior.technician_id = l.technician_id
      and prior.ticket_date < l.ticket_date
  )
  group by l.technician_id, date_trunc('month', l.ticket_date)
)
select
  base.*,
  coalesce(r.repeat_clients, 0) as repeat_clients,
  round(coalesce(r.repeat_clients, 0)::numeric
        / nullif(base.distinct_clients, 0) * 100, 1) as client_retention_pct,
  base.actual_margin_pct - base.expected_margin_pct  as margin_vs_expected_pts
from base
left join repeats r
  on r.technician_id = base.technician_id and r.month = base.month;

-- ---------------------------------------------------------------------------
-- Daily cash
-- ---------------------------------------------------------------------------

create view v_daily_cash
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
  cd.note
from days d
left join cash_days cd
  on cd.branch_id = d.branch_id and cd.business_date = d.business_date;
