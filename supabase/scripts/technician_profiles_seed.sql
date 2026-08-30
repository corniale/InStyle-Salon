-- technician_profiles_seed.sql — apply the salon's section-B roster to the
-- technician records: specialty per technician, skill level where the
-- salon actually assigns one (Joey = senior; the two trainees).
--
-- Safe to rerun. Matches by branch + name as they exist in the database;
-- the final SELECT shows every active technician with the result, plus
-- anything that did NOT match for manual review in Settings → Technicians.
-- Run as-is in the Supabase SQL editor.

-- MAIN hair
update technicians t set specialty = 'Hair'
from branches b
where t.branch_id = b.id and b.code = 'MAIN'
  and (upper(t.full_name) in ('MARK', 'ELMA') or t.full_name ilike 'JAYSON%');

-- MAIN nail & foot (JANE assumed = Mary Jane — flag if wrong)
update technicians t set specialty = 'Nail & Foot'
from branches b
where t.branch_id = b.id and b.code = 'MAIN'
  and (upper(t.full_name) in ('JANE', 'ROCHELLE', 'KRISTINE', 'RUTH', 'RICHELLE'));

-- BRANCH hair
update technicians t set specialty = 'Hair'
from branches b
where t.branch_id = b.id and b.code = 'BRANCH'
  and upper(t.full_name) in ('JOEY', 'IRIS', 'JASON');

-- BRANCH nail & foot
update technicians t set specialty = 'Nail & Foot'
from branches b
where t.branch_id = b.id and b.code = 'BRANCH'
  and (upper(t.full_name) in ('LANY', 'MARICON', 'CHRISTINE')
       or t.full_name ilike 'JAYMARK%');

-- Skill levels the salon actually uses today.
update technicians t set skill_level = 'senior'
from branches b
where t.branch_id = b.id and b.code = 'BRANCH' and upper(t.full_name) = 'JOEY';

update technicians t set skill_level = 'trainee'
from branches b
where t.branch_id = b.id and b.code = 'BRANCH' and upper(t.full_name) = 'JASON';

-- Review list: every active technician and where the roster left them.
-- 'REVIEW' rows are active records the salon's roster did not mention —
-- either former staff to deactivate, or names that need matching by hand
-- (e.g. Ma. Riza Genel, and trainee Elayza who may not have a record yet).
select b.code as branch, t.full_name, t.specialty, t.skill_level,
       case when t.specialty is null then 'REVIEW' else 'ok' end as status
from technicians t
join branches b on b.id = t.branch_id
where t.active
order by (t.specialty is null) desc, b.code, t.full_name;
