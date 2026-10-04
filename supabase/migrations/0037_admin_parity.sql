-- 0037_admin_parity.sql — Admin becomes owner-equivalent, minus the title.
--
-- The vendor's account should not carry the Owner label — that belongs to
-- the client alone. Admin therefore gains the remaining owner-only ground:
-- settings (catalogue, prices, branches, businesses), products and
-- categories, costing, staff accounts, the audit log and series counters.
--
-- Two things deliberately stay owner-only:
--   * approving the weekly schedule (0035) — that is the owner's business
--     sign-off, not an access matter;
--   * owner accounts themselves — an admin may manage staff but can never
--     create, promote, demote or deactivate an Owner (trigger below), so
--     the client's control of the app cannot be taken from the app.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- 1. Owner-only policies widen to owner-or-admin.
-- ---------------------------------------------------------------------------

alter policy profiles_owner_read on profiles
  using (auth_role() in ('owner', 'admin'));

alter policy profiles_owner_write on profiles
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy branches_owner_write on branches
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy service_types_owner_write on service_types
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy services_owner_write on services
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy prices_owner_write on branch_service_prices
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy series_counters_owner_read on series_counters
  using (auth_role() in ('owner', 'admin'));

alter policy audit_owner_read on audit_log
  using (auth_role() in ('owner', 'admin'));

alter policy businesses_owner_write on businesses
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy products_owner_write on products
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy product_categories_owner_write on product_categories
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy service_recipes_owner_write on service_recipes
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

alter policy costing_settings_owner on costing_settings
  using (auth_role() in ('owner', 'admin'))
  with check (auth_role() in ('owner', 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Owner accounts are off-limits to admins. Without this, a profiles
--    write grant would let an admin demote the owner or mint a new one.
-- ---------------------------------------------------------------------------

create or replace function guard_owner_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth_role() = 'admin' then
    if (tg_op <> 'INSERT' and old.role = 'owner')
       or (tg_op <> 'DELETE' and new.role = 'owner') then
      raise exception 'Only the owner can change owner accounts.'
        using errcode = 'insufficient_privilege', hint = 'owner_rows_locked';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists profiles_owner_guard on profiles;
create trigger profiles_owner_guard
  before insert or update or delete on profiles
  for each row execute function guard_owner_profiles();

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  (select count(*) from pg_policies
   where schemaname = 'public' and (qual like '%admin%' or with_check like '%admin%'))
    as policies_with_admin,
  to_regprocedure('guard_owner_profiles()') is not null as owner_guard_ready,
  exists (select 1 from pg_trigger
          where tgname = 'profiles_owner_guard') as owner_guard_armed;
