-- 0024_ranking_perf.sql — f_technician_ranking without the per-line
-- repeat-client lookup.
--
-- The repeats CTE probed the whole line view once per line in range to ask
-- "did this client see this technician before?" — the same shape that made
-- rebooking intervals time out on the live instance once histories grew.
-- Same cure: compute each (client, technician) pair's first-ever date in
-- one pass, then a repeat client is simply an in-range line dated after it.
-- Output is identical; only the plan changes.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

create or replace function f_technician_ranking(
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
  first_pair as (
    select client_id, technician_id, min(ticket_date) as first_date
    from v_ticket_lines_active
    group by client_id, technician_id
  ),
  repeats as (
    select x.technician_id, count(distinct x.client_id)::bigint as repeat_clients
    from (
      select l.technician_id, l.client_id
      from l
      join first_pair fp
        on fp.client_id = l.client_id and fp.technician_id = l.technician_id
      where l.ticket_date > fp.first_date
    ) x
    group by x.technician_id
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

select count(*) as ranking_rows
from f_technician_ranking(null, null, null, 10);
