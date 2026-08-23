-- 0031_costing.sql — service costing, phase 1.
--
-- True cost of a service = labor + products + overhead:
--   labor    — exact already: the technician share copied onto every line.
--   products — a consumption recipe per service (qty of each product used
--              per treatment), costed at the inventory's weighted-average
--              delivery cost, falling back to the standard cost. The same
--              recipes later drive automatic stock deduction (phase 2).
--   overhead — a manual monthly pool per branch (rent, fixed salaries,
--              whatever the ledger does not carry), absorbed per serviced
--              minute; serviced minutes come from actual line times.
--
-- Margins are the owner's numbers: costing_settings is owner-only even to
-- read, and the UI lives in Settings.
--
-- Rerun-safe. Run as-is in the Supabase SQL editor (default role).

-- ---------------------------------------------------------------------------
-- Recipes: what one treatment consumes.
-- ---------------------------------------------------------------------------

create table if not exists service_recipes (
  id         uuid primary key default gen_random_uuid(),
  service_id uuid not null references services(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  qty        numeric(8,3) not null check (qty > 0),
  created_at timestamptz not null default now(),
  unique (service_id, product_id)
);

-- The product must belong to the same business as the service.
create or replace function guard_service_recipe()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_svc_biz  uuid;
  v_prod_biz uuid;
begin
  select st.business_id into v_svc_biz
  from services s join service_types st on st.id = s.service_type_id
  where s.id = new.service_id;
  select business_id into v_prod_biz from products where id = new.product_id;
  if v_svc_biz is distinct from v_prod_biz then
    raise exception 'That product belongs to a different business than the service.'
      using errcode = 'check_violation', hint = 'business_mismatch';
  end if;
  return new;
end
$$;

drop trigger if exists service_recipes_guard on service_recipes;
create trigger service_recipes_guard
  before insert or update on service_recipes
  for each row execute function guard_service_recipe();

alter table service_recipes enable row level security;

drop policy if exists service_recipes_read on service_recipes;
create policy service_recipes_read on service_recipes
  for select to authenticated using (auth_role() is not null);

drop policy if exists service_recipes_owner_write on service_recipes;
create policy service_recipes_owner_write on service_recipes
  to authenticated
  using (auth_role() = 'owner')
  with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Per-branch costing assumptions. Owner-only, read included — margins are
-- not front-desk material.
-- ---------------------------------------------------------------------------

create table if not exists costing_settings (
  branch_id               uuid primary key references branches(id) on delete cascade,
  monthly_overhead_cents  bigint not null default 0 check (monthly_overhead_cents >= 0),
  monthly_minutes_override int check (monthly_minutes_override > 0),
  updated_at              timestamptz not null default now()
);

alter table costing_settings enable row level security;

drop policy if exists costing_settings_owner on costing_settings;
create policy costing_settings_owner on costing_settings
  to authenticated
  using (auth_role() = 'owner')
  with check (auth_role() = 'owner');

-- ---------------------------------------------------------------------------
-- One row per service of the branch's business: everything the margin
-- table needs except the overhead rate (pool ÷ minutes stays client-side
-- so the what-if column can recompute live).
-- ---------------------------------------------------------------------------

create or replace function f_service_costing(p_branch uuid)
returns table (
  service_id uuid,
  service_name text,
  service_type_name text,
  active boolean,
  price_cents bigint,
  sharing_rate numeric,
  product_cost_cents bigint,
  recipe_items int,
  unpriced_items int,
  duration_min numeric,
  duration_source text,
  treatments_90d bigint,
  realized_price_cents bigint
) language sql stable security invoker set search_path = public as $$
  with cur_price as (
    select distinct on (bsp.service_id)
           bsp.service_id, bsp.price_cents, bsp.sharing_rate
    from branch_service_prices bsp
    where bsp.branch_id = p_branch and bsp.effective_from <= business_date()
    order by bsp.service_id, bsp.effective_from desc
  ),
  recipe as (
    select r.service_id,
           count(*)::int as items,
           (count(*) filter (
              where coalesce(c.avg_cost_cents, p.standard_cost_cents) is null))::int
             as unpriced,
           sum(r.qty * coalesce(c.avg_cost_cents, p.standard_cost_cents, 0))::bigint
             as cost_cents
    from service_recipes r
    join products p on p.id = r.product_id
    left join v_product_cost c on c.product_id = r.product_id
    group by r.service_id
  ),
  usage as (
    select l.service_id,
           sum(l.qty) as treatments,
           (sum(l.total_cents) / nullif(sum(l.qty), 0))::bigint as realized,
           percentile_cont(0.5) within group (
             order by extract(epoch from (l.line_ended_at - l.line_started_at)) / 60)
             filter (where l.line_started_at is not null
                       and l.line_ended_at is not null
                       and l.line_ended_at > l.line_started_at)
             as med_minutes
    from v_ticket_lines_active l
    where l.branch_id = p_branch
      and l.ticket_date >= business_date() - 89
    group by l.service_id
  )
  select s.id,
         s.name,
         st.name,
         s.active,
         cp.price_cents,
         coalesce(cp.sharing_rate, s.default_sharing_rate),
         coalesce(rc.cost_cents, 0),
         coalesce(rc.items, 0),
         coalesce(rc.unpriced, 0),
         round(coalesce(u.med_minutes, s.default_duration_min)::numeric, 1),
         case when u.med_minutes is not null then 'timed' else 'standard' end,
         coalesce(u.treatments, 0)::bigint,
         u.realized
  from services s
  join service_types st on st.id = s.service_type_id
  left join cur_price cp on cp.service_id = s.id
  left join recipe rc on rc.service_id = s.id
  left join usage u on u.service_id = s.id
  where st.business_id = (select business_id from branches where id = p_branch)
    and can_read_branch(p_branch)
  order by st.name, s.name
$$;

-- Monthly serviced minutes (90-day average) — the absorption base.
create or replace function f_costing_basis(p_branch uuid)
returns table (monthly_minutes numeric)
language sql stable security invoker set search_path = public as $$
  select round(coalesce(sum(attributed_minutes), 0) / 3, 0)
  from v_ticket_lines_active
  where branch_id = p_branch
    and ticket_date >= business_date() - 89
    and can_read_branch(p_branch)
$$;

-- What the ledger already knows about monthly running costs, as a
-- reference when the owner sets the pool (last 3 full months, per
-- category). Allowance/withdrawal categories overlap with commission or
-- are not costs at all — the UI marks them.
create or replace function f_overhead_suggestion(p_branch uuid)
returns table (category text, monthly_avg_cents bigint)
language sql stable security invoker set search_path = public as $$
  select e.category, (sum(e.amount_cents) / 3)::bigint
  from expenses e
  where e.branch_id = p_branch
    and e.spent_on >= (date_trunc('month', business_date()) - interval '3 months')::date
    and e.spent_on <  date_trunc('month', business_date())::date
    and can_read_branch(p_branch)
  group by e.category
  order by 2 desc
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  to_regclass('service_recipes') is not null   as recipes_ready,
  to_regclass('costing_settings') is not null  as settings_ready,
  to_regprocedure('f_service_costing(uuid)') is not null as costing_fn_ready,
  to_regprocedure('f_costing_basis(uuid)') is not null as basis_fn_ready,
  to_regprocedure('f_overhead_suggestion(uuid)') is not null as suggestion_fn_ready,
  (select count(*) from pg_policies
   where tablename in ('service_recipes', 'costing_settings')) as policies;
