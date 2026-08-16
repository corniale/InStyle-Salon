-- 0023_technician_service_stats.sql — technician performance per service:
-- volume, revenue, average rating, and average minutes per treatment
-- (timed tickets only — never the catalogue default, so the efficiency
-- number is real or absent, not faked).
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

create or replace function f_technician_service_stats(p_branch uuid default null)
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
  group by l.service_id, l.service_name, l.technician_id, l.technician_name
$$;

select count(*) as tech_service_pairs,
       count(*) filter (where avg_rating is not null) as with_ratings,
       count(*) filter (where avg_minutes is not null) as with_timings
from f_technician_service_stats(null);
