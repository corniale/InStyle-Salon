-- inStyle Salon — row-level security.
-- RLS is on for every table. Policies are explicit, there is no permissive
-- fallback, and every policy is granted `to authenticated` only, so an
-- anonymous request matches no policy anywhere.

alter table branches              enable row level security;
alter table profiles              enable row level security;
alter table technicians           enable row level security;
alter table service_types         enable row level security;
alter table services              enable row level security;
alter table branch_service_prices enable row level security;
alter table clients               enable row level security;
alter table tickets               enable row level security;
alter table ticket_lines          enable row level security;
alter table ticket_payments       enable row level security;
alter table packages              enable row level security;
alter table package_sessions      enable row level security;
alter table expenses              enable row level security;
alter table cash_days             enable row level security;
alter table shift_blocks          enable row level security;
alter table audit_log             enable row level security;
alter table series_counters       enable row level security;

-- The anon role has no surface at all in Stage 1: there is nothing public
-- until Stage 2 online booking.
revoke all on schema public from anon;
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;

-- ---------------------------------------------------------------------------
-- profiles — a user reads only their own row; only the owner manages profiles
-- ---------------------------------------------------------------------------

create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_owner_read on profiles
  for select to authenticated using (auth_role() = 'owner');

create policy profiles_owner_write on profiles
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------

create policy branches_read on branches
  for select to authenticated using (can_read_branch(id));

create policy branches_owner_write on branches
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- tickets — read and insert scoped to the user's branch, only owner and
-- manager may void, nobody deletes
-- ---------------------------------------------------------------------------

create policy tickets_read on tickets
  for select to authenticated using (can_read_branch(branch_id));

create policy tickets_insert on tickets
  for insert to authenticated
  with check (can_read_branch(branch_id) and created_by = auth.uid());

create policy tickets_update on tickets
  for update to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'));

-- No delete policy on tickets. With RLS enabled and no policy for an action,
-- that action is denied: deletion is impossible through the API for every role.

-- ---------------------------------------------------------------------------
-- ticket_lines and ticket_payments — inherit the parent ticket's branch
-- ---------------------------------------------------------------------------

create policy ticket_lines_read on ticket_lines
  for select to authenticated using (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id))
  );

create policy ticket_lines_write on ticket_lines
  for insert to authenticated with check (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id)
              and t.voided_at is null)
  );

create policy ticket_payments_read on ticket_payments
  for select to authenticated using (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id))
  );

create policy ticket_payments_write on ticket_payments
  for insert to authenticated with check (
    exists (select 1 from tickets t
            where t.id = ticket_id and can_read_branch(t.branch_id)
              and t.voided_at is null)
  );

-- ---------------------------------------------------------------------------
-- clients — shared across branches; only owner and manager may merge
-- ---------------------------------------------------------------------------

create policy clients_read on clients
  for select to authenticated using (auth_role() is not null);

create policy clients_insert on clients
  for insert to authenticated with check (auth_role() is not null);

create policy clients_update on clients
  for update to authenticated
  using (auth_role() in ('owner', 'manager'))
  with check (auth_role() in ('owner', 'manager'));

-- ---------------------------------------------------------------------------
-- Catalogue — everyone reads, owner writes
-- ---------------------------------------------------------------------------

create policy service_types_read on service_types
  for select to authenticated using (auth_role() is not null);

create policy service_types_owner_write on service_types
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

create policy services_read on services
  for select to authenticated using (auth_role() is not null);

create policy services_owner_write on services
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

create policy prices_read on branch_service_prices
  for select to authenticated using (can_read_branch(branch_id));

create policy prices_owner_write on branch_service_prices
  for all to authenticated
  using (auth_role() = 'owner') with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Branch-scoped operations
-- ---------------------------------------------------------------------------

create policy technicians_read on technicians
  for select to authenticated using (auth_role() is not null);

create policy technicians_write on technicians
  for all to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'));

create policy expenses_read on expenses
  for select to authenticated using (can_read_branch(branch_id));

create policy expenses_write on expenses
  for insert to authenticated
  with check (can_read_branch(branch_id) and recorded_by = auth.uid());

create policy expenses_update on expenses
  for update to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'));

create policy cash_days_read on cash_days
  for select to authenticated using (can_read_branch(branch_id));

create policy cash_days_write on cash_days
  for all to authenticated
  using (can_read_branch(branch_id)) with check (can_read_branch(branch_id));

create policy shift_blocks_read on shift_blocks
  for select to authenticated using (can_read_branch(branch_id));

create policy shift_blocks_write on shift_blocks
  for all to authenticated
  using (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'))
  with check (can_read_branch(branch_id) and auth_role() in ('owner', 'manager'));

-- Series counters are maintained by a security definer trigger. Staff read
-- nothing here and write nothing here.
create policy series_counters_owner_read on series_counters
  for select to authenticated using (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Packages
-- ---------------------------------------------------------------------------

create policy packages_read on packages
  for select to authenticated using (auth_role() is not null);

create policy packages_write on packages
  for insert to authenticated with check (auth_role() is not null);

create policy packages_update on packages
  for update to authenticated
  using (auth_role() in ('owner', 'manager'))
  with check (auth_role() in ('owner', 'manager'));

create policy package_sessions_read on package_sessions
  for select to authenticated using (auth_role() is not null);

create policy package_sessions_write on package_sessions
  for insert to authenticated with check (auth_role() is not null);

-- ---------------------------------------------------------------------------
-- audit_log — owner reads, nobody writes through the API
-- ---------------------------------------------------------------------------

create policy audit_owner_read on audit_log
  for select to authenticated using (auth_role() = 'owner');

-- Rows are inserted by security definer triggers, which bypass RLS. There is
-- no insert policy, so no client can forge an audit entry.
