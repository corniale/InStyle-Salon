-- 0022_peak_periods.sql — traffic buckets for the Analytics peak-periods
-- heatmap: tickets and revenue by month × weekday, by weekday, and by
-- hour of day (Manila time, from ticket start times — sparse until the
-- POS has been capturing times for a while).
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

create or replace function f_peak_periods(p_branch uuid default null)
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

select dim, count(*) as buckets, sum(tickets) as tickets
from f_peak_periods(null)
group by dim order by dim;
