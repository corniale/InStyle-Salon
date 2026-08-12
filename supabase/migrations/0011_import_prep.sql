-- Defensive re-issue of migration 0011 (import preparation).
-- Safe to run from ANY state: never applied, partially applied, or fully
-- applied — every structural change is guarded, every view and function is
-- rebuilt. Run this BEFORE the four import files.

-- Preparation for the January-July history import, driven by what the real
-- workbooks contain (which differs from the spec's assumptions):
--
-- 1. The source records explicit peso splits ("FIXED SHARING": 630 total,
--    355 company / 275 technician). Three decimals of sharing rate cannot
--    reproduce those splits exactly, so the line rate gains precision. The
--    generated columns depend on the column, so they are rebuilt around it.
--
-- 2. Most historical rows are anonymous daily tallies ("HC x16") with no
--    client at all. They import against one pooled walk-in client per
--    branch so the money is complete — but a pool is not a person, so
--    retention analytics must exclude it or every metric drowns in fake
--    never-returned clients.

-- ---------------------------------------------------------------------------
-- Sharing rate precision. The share columns feed the whole view stack, so
-- the views come down first and are rebuilt below. The analytics functions
-- resolve view names at call time and need no rebuild except where their
-- own logic changes.
-- ---------------------------------------------------------------------------

drop view if exists v_technician_performance;
drop view if exists v_technician_utilisation;
drop view if exists v_service_margin;
drop view if exists v_client_retention;
drop view if exists v_client_visits;
drop view if exists v_ticket_lines_active;

alter table ticket_lines drop column if exists company_share_cents;
alter table ticket_lines drop column if exists technician_share_cents;

alter table ticket_lines alter column sharing_rate type numeric(8,6);

alter table ticket_lines add column company_share_cents bigint generated always as
  ((round((qty * unit_price_cents - discount_cents) * sharing_rate))::bigint) stored;
alter table ticket_lines add column technician_share_cents bigint generated always as
  (((qty * unit_price_cents - discount_cents)
    - round((qty * unit_price_cents - discount_cents) * sharing_rate))::bigint) stored;

-- ---------------------------------------------------------------------------
-- Rebuild the view stack (definitions unchanged from 0004/0009)
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
  coalesce(
    nullif(extract(epoch from (t.ended_at - t.started_at)) / 60, 0)
      / nullif(count(*) over (partition by tl.ticket_id), 0),
    s.default_duration_min * tl.qty
  )::numeric(10,2) as attributed_minutes,
  b.business_id,
  biz.code                 as business_code
from ticket_lines tl
join tickets t       on t.id = tl.ticket_id and t.voided_at is null
join branches b      on b.id = t.branch_id
join businesses biz  on biz.id = b.business_id
join services s      on s.id = tl.service_id
join service_types st on st.id = s.service_type_id
join technicians tech on tech.id = tl.technician_id;

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
  round(sum(company_share_cents)::numeric
        / nullif(sum(total_cents), 0) * 100, 1) as margin_pct,
  round(avg(rating) filter (where rating is not null), 2) as avg_rating,
  count(rating) filter (where rating is not null) as rated_lines
from v_ticket_lines_active
group by branch_id, branch_code, service_id, service_name, service_type_name, month;

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
-- Pooled walk-in clients
-- ---------------------------------------------------------------------------

alter table clients add column if not exists is_pool boolean not null default false;

comment on column clients.is_pool is
  'A per-branch bucket for historical anonymous walk-in rows. Money counts; retention must not.';

-- The views/functions that reason about *people* exclude pools.

create view v_client_retention
with (security_invoker = on) as
with gaps as (
  select client_id,
         count(*)                       as visit_count,
         min(visit_date)                as first_visit,
         max(visit_date)                as last_visit,
         sum(spend_cents)               as lifetime_spend_cents,
         sum(company_share_cents)       as lifetime_company_share_cents,
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
where c.merged_into_id is null
  and not c.is_pool;

-- Rebooking intervals: a pool "coming back tomorrow" is not a rebooking.
create or replace function f_rebooking_by_service(
  p_branch uuid default null, p_min_samples int default 5)
returns table (service_id uuid, service_name text, samples bigint,
               median_days numeric, p25_days numeric, p75_days numeric)
language sql stable security invoker set search_path = public as $$
  with visits as (
    select l.service_id, l.service_name, l.client_id, l.ticket_date,
           (select min(v.visit_date) from v_client_visits v
            where v.client_id = l.client_id and v.visit_date > l.ticket_date) as next_visit
    from v_ticket_lines_active l
    join clients c on c.id = l.client_id and not c.is_pool
    where (p_branch is null or l.branch_id = p_branch)
  ),
  gaps as (
    select service_id, service_name, (next_visit - ticket_date) as gap_days
    from visits where next_visit is not null
  )
  select service_id, service_name, count(*)::bigint,
         round(percentile_cont(0.5) within group (order by gap_days)::numeric, 1),
         round(percentile_cont(0.25) within group (order by gap_days)::numeric, 1),
         round(percentile_cont(0.75) within group (order by gap_days)::numeric, 1)
  from gaps
  group by service_id, service_name
  having count(*) >= p_min_samples
  order by count(*) desc
$$;

-- Sales summary: revenue and ticket counts keep everything; the people
-- numbers (clients, new vs returning) count identified clients only.
create or replace function f_sales_summary(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with l as (
    select * from v_ticket_lines_active
    where (p_branch is null or branch_id = p_branch)
      and (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
  ),
  t as (
    select l.ticket_id, l.client_id, l.is_new_client, c.is_pool,
           count(*) as line_count, sum(l.total_cents) as ticket_total
    from l join clients c on c.id = l.client_id
    group by l.ticket_id, l.client_id, l.is_new_client, c.is_pool
  )
  select jsonb_build_object(
    'revenue_cents',        coalesce((select sum(total_cents) from l), 0),
    'company_share_cents',  coalesce((select sum(company_share_cents) from l), 0),
    'technician_share_cents', coalesce((select sum(technician_share_cents) from l), 0),
    'discount_cents',       coalesce((select sum(discount_cents) from l), 0),
    'margin_pct',           (select round(sum(company_share_cents)::numeric
                                    / nullif(sum(total_cents), 0) * 100, 1) from l),
    'discount_pct',         (select round(sum(discount_cents)::numeric
                                    / nullif(sum(qty * unit_price_cents), 0) * 100, 1) from l),
    'tickets',              (select count(*) from t),
    'treatments',           coalesce((select sum(qty) from l), 0),
    'lines',                (select count(*) from l),
    'clients',              (select count(distinct client_id) from t where not is_pool),
    'new_clients',          (select count(*) from t where is_new_client and not is_pool),
    'returning_clients',    (select count(*) from t where not is_new_client and not is_pool),
    'avg_ticket_cents',     (select round(avg(ticket_total)) from t),
    'upsell_pct',           (select round(count(*) filter (where line_count > 1)::numeric
                                    / nullif(count(*), 0) * 100, 1) from t where not is_pool),
    'avg_rating',           (select round(avg(rating), 2) from l where rating is not null),
    'rated_pct',            (select round(count(rating)::numeric
                                    / nullif(count(*), 0) * 100, 1) from l)
  )
$$;
