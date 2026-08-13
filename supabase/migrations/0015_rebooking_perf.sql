-- 0015_rebooking_perf.sql — f_rebooking_by_service in one pass.
--
-- The old version found each line's "next visit" with a correlated
-- subquery over v_client_visits — O(lines × client history), which crossed
-- the API's 8-second statement timeout once the client merges consolidated
-- visit histories. Same result, computed once per client with a window
-- function instead. Run as-is in the Supabase SQL editor.

create or replace function f_rebooking_by_service(
  p_branch uuid default null, p_min_samples int default 5)
returns table (service_id uuid, service_name text, samples bigint,
               median_days numeric, p25_days numeric, p75_days numeric)
language sql stable security invoker set search_path = public as $$
  with nv as (
    select d.client_id, d.visit_date,
           lead(d.visit_date) over (partition by d.client_id
                                    order by d.visit_date) as next_visit
    from (select distinct v.client_id, v.visit_date from v_client_visits v) d
  ),
  gaps as (
    select l.service_id, l.service_name,
           (nv.next_visit - l.ticket_date) as gap_days
    from v_ticket_lines_active l
    join clients c on c.id = l.client_id and not c.is_pool
    join nv on nv.client_id = l.client_id and nv.visit_date = l.ticket_date
    where (p_branch is null or l.branch_id = p_branch)
      and nv.next_visit is not null
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

select count(*) as services_with_intervals, sum(samples) as total_samples
from f_rebooking_by_service(null, 5);
