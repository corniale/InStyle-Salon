-- 0020_admin_role.sql — the Admin role, between Owner and Branch manager.
--
-- Interim powers until the owner defines them precisely (backlog):
-- everything a branch manager can do, but across ALL branches (like the
-- owner, an admin has no home branch), plus the export buttons. Owner-only
-- ground — settings, catalogue and price edits, staff accounts, the audit
-- log — stays owner-only.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('owner', 'admin', 'manager', 'front_desk'));

alter table profiles drop constraint if exists profiles_branch_scope;
alter table profiles add constraint profiles_branch_scope
  check (branch_id is not null or role in ('owner', 'admin'));

-- Admins see every branch, like the owner.
create or replace function can_read_branch(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and (p.role in ('owner', 'admin') or p.branch_id = target)
  )
$$;

-- Manager-level policies now include admin.
alter policy tickets_update on tickets
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'));

alter policy clients_update on clients
  using (auth_role() in ('owner', 'admin', 'manager'))
  with check (auth_role() in ('owner', 'admin', 'manager'));

alter policy technicians_write on technicians
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'));

alter policy expenses_update on expenses
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'));

alter policy shift_blocks_write on shift_blocks
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'admin', 'manager'));

alter policy packages_update on packages
  using (auth_role() in ('owner', 'admin', 'manager'))
  with check (auth_role() in ('owner', 'admin', 'manager'));

select count(*) as policies_with_admin
from pg_policies
where schemaname = 'public' and qual like '%admin%';
