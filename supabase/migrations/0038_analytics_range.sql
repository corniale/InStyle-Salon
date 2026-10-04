-- 0038_analytics_range.sql — the Analytics page gains a free date-range
-- filter. Two of its functions had no date parameters; they gain
-- optional p_from / p_to (null = all history, so existing behaviour is
-- unchanged until a range is passed).
--
-- Adding parameters changes each function's signature, so the old
-- single-argument versions are dropped first — otherwise both would
-- coexist and calls through the API become ambiguous.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

drop function if exists f_peak_periods(uuid);
drop function if exists f_peak_periods(uuid, date, date);

create function f_peak_periods(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (dim text, bucket int, dow int, tickets bigint, revenue_cents bigint)
language sql stable security invoker set search_path = public as $$
  with t as (
    select t.id,
           extract(month from t.ticket_date)::int  as m,
           extract(isodow from t.ticket_date)::int as d,
           t.started_at,
           (select sum(l.total_cents) from ticket_lines l where l.ticket_id = t.id) as rev
    from tickets t
    where t.voided_at is null and t.status = 'closed'
      and (p_branch is null or t.branch_id = p_branch)
      and (p_from is null or t.ticket_date >= p_from)
      and (p_to   is null or t.ticket_date <= p_to)
  )
  select 'month_dow'::text as dim, m as bucket, d as dow,
         count(*)::bigint as tickets, coalesce(sum(rev), 0)::bigint as revenue_cents
  from t group by m, d
  union all
  select 'dow', d, null, count(*)::bigint, coalesce(sum(rev), 0)::bigint
  from t group by d
  union all
  select 'hour',
         extract(hour from t.started_at at time zone 'Asia/Manila')::int, null,
         count(*)::bigint, coalesce(sum(rev), 0)::bigint
  from t where t.started_at is not null
  group by 2
$$;

drop function if exists f_technician_service_stats(uuid);
drop function if exists f_technician_service_stats(uuid, date, date);

create function f_technician_service_stats(
  p_branch uuid default null, p_from date default null, p_to date default null)
returns table (
  service_id uuid, service_name text,
  technician_id uuid, technician_name text, branch_code text,
  treatments bigint, revenue_cents bigint,
  avg_rating numeric, rated bigint,
  timed bigint, avg_minutes numeric, standard_minutes int)
language sql stable security invoker set search_path = public as $$
  select l.service_id, l.service_name,
         l.technician_id, l.technician_name,
         max(l.branch_code),
         sum(l.qty)::bigint,
         sum(l.total_cents)::bigint,
         round(avg(l.rating) filter (where l.rating is not null), 2),
         count(l.rating)::bigint,
         count(*) filter (where (l.line_started_at is not null and l.line_ended_at is not null)
                             or (l.started_at is not null and l.ended_at is not null))::bigint,
         round(avg(l.attributed_minutes / nullif(l.qty, 0)) filter (
           where (l.line_started_at is not null and l.line_ended_at is not null)
              or (l.started_at is not null and l.ended_at is not null)), 1),
         max(l.default_duration_min)
  from v_ticket_lines_active l
  where (p_branch is null or l.branch_id = p_branch)
    and (p_from is null or l.ticket_date >= p_from)
    and (p_to   is null or l.ticket_date <= p_to)
  group by l.service_id, l.service_name, l.technician_id, l.technician_name
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  to_regprocedure('f_peak_periods(uuid, date, date)') is not null as peak_ranged,
  to_regprocedure('f_peak_periods(uuid)') is null as peak_old_gone,
  to_regprocedure('f_technician_service_stats(uuid, date, date)') is not null as techsvc_ranged,
  to_regprocedure('f_technician_service_stats(uuid)') is null as techsvc_old_gone;
