-- 0014_technician_profile.sql — technicians gain a specialty (Hairdresser,
-- Nail technician, …) and a skill level, both optional, shown in the
-- Settings roster and captured by the add-technician dialog.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

alter table technicians
  add column if not exists specialty text,
  add column if not exists skill_level text;

alter table technicians
  drop constraint if exists technicians_skill_level_check;
alter table technicians
  add constraint technicians_skill_level_check
  check (skill_level is null or skill_level in ('trainee', 'junior', 'senior', 'master'));

select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'technicians'
order by ordinal_position;
