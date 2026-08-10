-- inStyle Salon — analytics entry points.
-- One function per dashboard tile, on purpose: a tile that fails fails alone
-- and the rest of the page still renders (§5, partial failure).
-- p_branch null means consolidated across every branch the caller can read.

-- ---------------------------------------------------------------------------
-- Headline numbers
-- ---------------------------------------------------------------------------

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
    select ticket_id, client_id, is_new_client,
           count(*) as line_count, sum(total_cents) as ticket_total
    from l group by ticket_id, client_id, is_new_client
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
    'clients',              (select count(distinct client_id) from t),
    'new_clients',          (select count(*) from t where is_new_client),
    'returning_clients',    (select count(*) from t where not is_new_client),
    'avg_ticket_cents',     (select round(avg(ticket_total)) from t),
    -- Upsell: a ticket that bought more than one thing.
    'upsell_pct',           (select round(count(*) filter (where line_count > 1)::numeric
                                    / nullif(count(*), 0) * 100, 1) from t),
    'avg_rating',           (select round(avg(rating), 2) from l where rating is not null),
    -- Ratings are blank on a meaningful share of rows, so the coverage is
    -- reported next to the average rather than hidden (edge case 14).
    'rated_pct',            (select round(count(rating)::numeric
                                    / nullif(count(*), 0) * 100, 1) from l)
  )
$$;

create or replace function f_pace_vs_target(
  p_branch uuid default null, p_month date default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with bounds as (
    select date_trunc('month', coalesce(p_month, business_date()))::date as month_start,
           (date_trunc('month', coalesce(p_month, business_date()))
             + interval '1 month - 1 day')::date as month_end
  ),
  target as (
    select coalesce(sum(b.monthly_target_cents), 0) as target_cents
    from branches b
    where b.active and (p_branch is null or b.id = p_branch)
  ),
  actual as (
    select coalesce(sum(l.total_cents), 0) as revenue_cents,
           coalesce(sum(l.company_share_cents), 0) as company_share_cents
    from v_ticket_lines_active l, bounds
    where (p_branch is null or l.branch_id = p_branch)
      and l.ticket_date between bounds.month_start and bounds.month_end
  )
  select jsonb_build_object(
    'month_start',   bounds.month_start,
    'month_end',     bounds.month_end,
    'days_elapsed',  least(business_date(), bounds.month_end) - bounds.month_start + 1,
    'days_in_month', bounds.month_end - bounds.month_start + 1,
    'target_cents',  target.target_cents,
    'revenue_cents', actual.revenue_cents,
    'company_share_cents', actual.company_share_cents,
    -- Pro-rata expectation for the days elapsed. Deliberately not a forecast:
    -- with two branches and Philippine seasonality a naive trend line is
    -- wrong within weeks, and one wrong number discredits the rest (§2).
    'expected_to_date_cents',
      round(target.target_cents::numeric
            * (least(business_date(), bounds.month_end) - bounds.month_start + 1)
            / nullif(bounds.month_end - bounds.month_start + 1, 0)),
    'pace_pct',
      round(actual.revenue_cents::numeric
            / nullif(target.target_cents::numeric
                     * (least(business_date(), bounds.month_end) - bounds.month_start + 1)
                     / nullif(bounds.month_end - bounds.month_start + 1, 0), 0) * 100, 1),
    'target_pct',
      round(actual.revenue_cents::numeric / nullif(target.target_cents, 0) * 100, 1)
  )
  from bounds, target, actual
$$;

-- ---------------------------------------------------------------------------
-- Breakdowns
-- ---------------------------------------------------------------------------

create or replace function f_sales_by_service(
  p_branch uuid default null, p_from date default null, p_to date default null,
  p_limit int default 50)
returns table (
  service_id uuid, service_name text, service_type_name text,
  units bigint, revenue_cents bigint, company_share_cents bigint,
  margin_pct numeric, avg_rating numeric)
language sql stable security invoker set search_path = public as $$
  select service_id, service_name, service_type_name,
         sum(qty)::bigint, sum(total_cents)::bigint, sum(company_share_cents)::bigint,
         round(sum(company_share_cents)::numeric / nullif(sum(total_cents), 0) * 100, 1),
         round(avg(rating) filter (where rating is not null), 2)
  from v_ticket_lines_active
  where (p_branch is null or branch_id = p_branch)
    and (p_from is null or ticket_date >= p_from)
    and (p_to   is null or ticket_date <= p_to)
  group by service_id, service_name, service_type_name
  order by sum(total_cents) desc
  limit p_limit
$$;

create or replace function f_payment_mix(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (method text, tickets bigint, amount_cents bigint, share_pct numeric)
language sql stable security invoker set search_path = public as $$
  with p as (
    select tp.method, tp.amount_cents, t.id as ticket_id
    from ticket_payments tp
    join tickets t on t.id = tp.ticket_id and t.voided_at is null
    where (p_branch is null or t.branch_id = p_branch)
      and (p_from is null or t.ticket_date >= p_from)
      and (p_to   is null or t.ticket_date <= p_to)
      and can_read_branch(t.branch_id)
  )
  select method, count(distinct ticket_id)::bigint, sum(amount_cents)::bigint,
         round(sum(amount_cents)::numeric / nullif((select sum(amount_cents) from p), 0) * 100, 1)
  from p group by method order by sum(amount_cents) desc
$$;

-- Daily series for the sales chart. Days with no tickets at all come back
-- null, not zero, so the chart shows a gap instead of interpolating across a
-- month nobody recorded (edge case 24).
create or replace function f_daily_series(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (day date, revenue_cents bigint, company_share_cents bigint, tickets bigint)
language sql stable security invoker set search_path = public as $$
  with span as (
    select coalesce(p_from, business_date() - 29) as d_from,
           coalesce(p_to, business_date()) as d_to
  ),
  cal as (
    select generate_series(d_from, d_to, interval '1 day')::date as day from span
  ),
  agg as (
    select ticket_date, sum(total_cents) as revenue, sum(company_share_cents) as share,
           count(distinct ticket_id) as tickets
    from v_ticket_lines_active, span
    where (p_branch is null or branch_id = p_branch)
      and ticket_date between span.d_from and span.d_to
    group by ticket_date
  )
  select cal.day, agg.revenue::bigint, agg.share::bigint, agg.tickets::bigint
  from cal left join agg on agg.ticket_date = cal.day
  order by cal.day
$$;

create or replace function f_monthly_series(
  p_branch uuid default null, p_months int default 12)
returns table (month date, revenue_cents bigint, company_share_cents bigint,
               tickets bigint, clients bigint)
language sql stable security invoker set search_path = public as $$
  with span as (
    select date_trunc('month', business_date())::date - ((p_months - 1) || ' months')::interval as m_from
  ),
  cal as (
    select generate_series((select m_from from span),
                           date_trunc('month', business_date()),
                           interval '1 month')::date as month
  ),
  agg as (
    select month, sum(total_cents) as revenue, sum(company_share_cents) as share,
           count(distinct ticket_id) as tickets, count(distinct client_id) as clients
    from v_ticket_lines_active
    where (p_branch is null or branch_id = p_branch)
      and month >= (select m_from from span)::date
    group by month
  )
  select cal.month, agg.revenue::bigint, agg.share::bigint,
         agg.tickets::bigint, agg.clients::bigint
  from cal left join agg on agg.month = cal.month
  order by cal.month
$$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

create or replace function f_retention_summary(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with firsts as (
    select r.client_id, r.first_visit, r.visit_count, r.median_interval_days, r.status
    from v_client_retention r
    where (p_from is null or r.first_visit >= p_from)
      and (p_to   is null or r.first_visit <= p_to)
      and (p_branch is null or exists (
            select 1 from v_client_visits v
            where v.client_id = r.client_id and v.branch_id = p_branch))
  ),
  -- Second-visit conversion is only fair to measure on clients who have had
  -- time to come back, so cohorts younger than 60 days are held out.
  mature as (select * from firsts where first_visit <= business_date() - 60)
  select jsonb_build_object(
    'new_clients',            (select count(*) from firsts),
    'mature_cohort',          (select count(*) from mature),
    'converted_to_second',    (select count(*) from mature where visit_count >= 2),
    'second_visit_pct',       (select round(count(*) filter (where visit_count >= 2)::numeric
                                      / nullif(count(*), 0) * 100, 1) from mature),
    'median_interval_days',   (select round(percentile_cont(0.5) within group (
                                      order by median_interval_days))
                               from firsts where median_interval_days is not null),
    'active_clients',         (select count(*) from v_client_retention where status = 'active'),
    'at_risk_clients',        (select count(*) from v_client_retention where status = 'at_risk'),
    'lapsed_clients',         (select count(*) from v_client_retention where status = 'lapsed'),
    'never_returned',         (select count(*) from v_client_retention where status = 'never_returned')
  )
$$;

create or replace function f_at_risk_clients(
  p_branch uuid default null, p_limit int default 50, p_offset int default 0)
returns table (
  client_id uuid, full_name text, phone text, phone_declined boolean,
  visit_count bigint, last_visit date, median_interval_days int,
  days_overdue int, lifetime_spend_cents bigint, status text, total_count bigint)
language sql stable security invoker set search_path = public as $$
  with rows as (
    select r.* from v_client_retention r
    where r.status in ('at_risk', 'lapsed')
      and (p_branch is null or exists (
            select 1 from v_client_visits v
            where v.client_id = r.client_id and v.branch_id = p_branch))
  )
  select client_id, full_name, phone, phone_declined, visit_count, last_visit,
         median_interval_days, days_overdue, lifetime_spend_cents, status,
         count(*) over ()
  from rows
  order by days_overdue desc nulls last, lifetime_spend_cents desc
  limit p_limit offset p_offset
$$;

-- Rebooking interval per service: how long, typically, before a client who
-- had this service comes back for anything at all.
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

-- ---------------------------------------------------------------------------
-- Technicians
-- ---------------------------------------------------------------------------

-- Technicians below the ticket threshold are returned with ranked = false so
-- the UI can show them separately: a new hire's three tickets must not top
-- the leaderboard (edge case 27).
create or replace function f_technician_ranking(
  p_branch uuid default null, p_from date default null, p_to date default null,
  p_min_tickets int default 10)
returns table (
  technician_id uuid, technician_name text, branch_id uuid, branch_code text,
  tickets bigint, lines bigint, revenue_cents bigint, company_share_cents bigint,
  distinct_clients bigint, repeat_clients bigint, client_retention_pct numeric,
  avg_rating numeric, rated_pct numeric,
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

-- ---------------------------------------------------------------------------
-- Branch comparison — a primary view, not a filter (§1.1)
-- ---------------------------------------------------------------------------

create or replace function f_branch_comparison(
  p_from date default null, p_to date default null)
returns table (
  branch_id uuid, branch_code text, branch_name text, accent text,
  revenue_cents bigint, company_share_cents bigint, margin_pct numeric,
  tickets bigint, treatments bigint, clients bigint, new_clients bigint,
  avg_ticket_cents numeric, discount_pct numeric, avg_rating numeric,
  monthly_target_cents bigint)
language sql stable security invoker set search_path = public as $$
  with l as (
    select * from v_ticket_lines_active
    where (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
  ),
  t as (
    select branch_id, ticket_id, client_id, is_new_client, sum(total_cents) as ticket_total
    from l group by branch_id, ticket_id, client_id, is_new_client
  )
  select b.id, b.code, b.name, b.accent,
         coalesce(sum(l.total_cents), 0)::bigint,
         coalesce(sum(l.company_share_cents), 0)::bigint,
         round(sum(l.company_share_cents)::numeric / nullif(sum(l.total_cents), 0) * 100, 1),
         (select count(*) from t where t.branch_id = b.id)::bigint,
         coalesce(sum(l.qty), 0)::bigint,
         (select count(distinct client_id) from t where t.branch_id = b.id)::bigint,
         (select count(*) from t where t.branch_id = b.id and t.is_new_client)::bigint,
         (select round(avg(ticket_total)) from t where t.branch_id = b.id),
         round(sum(l.discount_cents)::numeric / nullif(sum(l.qty * l.unit_price_cents), 0) * 100, 1),
         round(avg(l.rating) filter (where l.rating is not null), 2),
         b.monthly_target_cents
  from branches b
  left join l on l.branch_id = b.id
  where b.active and can_read_branch(b.id)
  group by b.id, b.code, b.name, b.accent, b.monthly_target_cents
  order by b.code
$$;

-- Per-service, per-branch comparison. A service sold at only one branch shows
-- as "not offered" rather than zero (edge case 28).
create or replace function f_service_branch_matrix(
  p_from date default null, p_to date default null)
returns table (
  service_id uuid, service_name text, service_type_name text,
  branch_id uuid, branch_code text, offered boolean,
  units bigint, revenue_cents bigint, company_share_cents bigint,
  margin_pct numeric, list_price_cents bigint)
language sql stable security invoker set search_path = public as $$
  with pairs as (
    select s.id as service_id, s.name as service_name, st.name as service_type_name,
           b.id as branch_id, b.code as branch_code
    from services s
    join service_types st on st.id = s.service_type_id
    cross join branches b
    where s.active and b.active and can_read_branch(b.id)
  ),
  price as (
    select p.service_id, p.branch_id, (price_on(p.branch_id, p.service_id, coalesce(p_to, business_date()))).price_cents
    from pairs p
  ),
  agg as (
    select service_id, branch_id, sum(qty) as units, sum(total_cents) as revenue,
           sum(company_share_cents) as share
    from v_ticket_lines_active
    where (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
    group by service_id, branch_id
  )
  select p.service_id, p.service_name, p.service_type_name, p.branch_id, p.branch_code,
         price.price_cents is not null,
         agg.units::bigint, agg.revenue::bigint, agg.share::bigint,
         round(agg.share::numeric / nullif(agg.revenue, 0) * 100, 1),
         price.price_cents
  from pairs p
  left join price on price.service_id = p.service_id and price.branch_id = p.branch_id
  left join agg on agg.service_id = p.service_id and agg.branch_id = p.branch_id
  order by p.service_type_name, p.service_name, p.branch_code
$$;

-- Divergent branch pricing is legitimate but must be deliberate, so the
-- dashboard flags it (§7.1).
create or replace function f_price_divergence()
returns table (service_id uuid, service_name text, branches int,
               min_price_cents bigint, max_price_cents bigint, spread_pct numeric)
language sql stable security invoker set search_path = public as $$
  with current_prices as (
    select b.id as branch_id, s.id as service_id, s.name as service_name,
           (price_on(b.id, s.id, business_date())).price_cents as price_cents
    from services s cross join branches b
    where s.active and b.active and can_read_branch(b.id)
  )
  select service_id, service_name, count(*)::int,
         min(price_cents), max(price_cents),
         round((max(price_cents) - min(price_cents))::numeric
               / nullif(min(price_cents), 0) * 100, 1)
  from current_prices
  where price_cents is not null
  group by service_id, service_name
  having min(price_cents) <> max(price_cents)
  order by (max(price_cents) - min(price_cents))::numeric / nullif(min(price_cents), 0) desc
$$;

-- How often the phone number is being skipped. If this climbs, the analytics
-- layer is quietly eroding (§1.1, open question 1).
create or replace function f_data_quality(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with l as (
    select * from v_ticket_lines_active
    where (p_branch is null or branch_id = p_branch)
      and (p_from is null or ticket_date >= p_from)
      and (p_to   is null or ticket_date <= p_to)
  ),
  t as (select distinct ticket_id, client_id, started_at, ended_at from l)
  select jsonb_build_object(
    'tickets',            (select count(*) from t),
    'declined_phone',     (select count(*) from t
                           join clients c on c.id = t.client_id where c.phone_declined),
    'declined_phone_pct', (select round(count(*) filter (where c.phone_declined)::numeric
                                  / nullif(count(*), 0) * 100, 1)
                           from t join clients c on c.id = t.client_id),
    'unrated_lines_pct',  (select round(count(*) filter (where rating is null)::numeric
                                  / nullif(count(*), 0) * 100, 1) from l),
    'missing_times_pct',  (select round(count(*) filter (where started_at is null or ended_at is null)::numeric
                                  / nullif(count(*), 0) * 100, 1) from t),
    'unnamed_clients',    (select count(*) from t
                           join clients c on c.id = t.client_id
                           where coalesce(btrim(c.full_name), '') = '')
  )
$$;
