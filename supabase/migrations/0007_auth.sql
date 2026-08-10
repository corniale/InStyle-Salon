-- inStyle Salon — profile provisioning.
-- Staff never self-register in Stage 1: the owner invites them from Settings,
-- and this trigger turns the resulting auth user into a profile.

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role      text := coalesce(new.raw_user_meta_data ->> 'role', 'front_desk');
  v_branch    uuid := nullif(new.raw_user_meta_data ->> 'branch_id', '')::uuid;
  v_name      text := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                               split_part(new.email, '@', 1));
  v_first     boolean;
begin
  select not exists (select 1 from public.profiles) into v_first;

  -- Bootstrap: the very first account is the owner, because otherwise there
  -- is nobody who can grant anybody else a role. Every later account is
  -- created by the owner and takes the role the owner chose.
  if v_first then
    v_role := 'owner';
    v_branch := null;
  end if;

  if v_role not in ('owner', 'manager', 'front_desk') then
    v_role := 'front_desk';
  end if;

  -- Only the owner may be branchless. A manager or front desk account with no
  -- branch yet is parked on the main branch until the owner moves it.
  if v_role <> 'owner' and v_branch is null then
    select id into v_branch from public.branches where code = 'MAIN';
  end if;

  insert into public.profiles (id, full_name, role, branch_id, active)
  values (new.id, v_name, v_role, v_branch, true)
  on conflict (id) do nothing;

  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
