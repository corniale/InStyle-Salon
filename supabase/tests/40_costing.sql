-- Costing behaviour: recipe rights and guard, costing math, owner-only
-- assumptions. Runs after 30_inventory (its products and deliveries exist:
-- 'Shampoo 1L' with a ₱300 weighted-average delivery cost).

\set QUIET on
set client_min_messages = warning;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

-- Owner attaches a recipe to Manicure: 0.5 bottle of shampoo (WAC ₱300)
-- and 1 'Cotton pads' (no cost recorded anywhere -> flagged unpriced).
do $$
declare v_svc uuid; v_shampoo uuid; v_pads uuid;
begin
  select id into v_svc from public.services where name = 'Manicure';
  select id into v_shampoo from public.products
  where name = 'Shampoo 1L' and brand is null;
  select id into v_pads from public.products where name = 'Cotton pads';

  insert into public.service_recipes (service_id, product_id, qty)
  values (v_svc, v_shampoo, 0.5), (v_svc, v_pads, 1);
end $$;

-- Costing math: product cost = 0.5 × 30000 = 15000; the costless item is
-- counted and flagged, priced at zero.
do $$
declare v_main uuid; r record;
begin
  select id into v_main from public.branches where code = 'MAIN';
  select * into r from f_service_costing(v_main) where service_name = 'Manicure';
  if not found then raise exception 'costing returned no Manicure row'; end if;
  if r.product_cost_cents <> 15000 then
    raise exception 'product cost wrong: %', r.product_cost_cents;
  end if;
  if r.recipe_items <> 2 or r.unpriced_items <> 1 then
    raise exception 'recipe flags wrong: % items, % unpriced', r.recipe_items, r.unpriced_items;
  end if;
  if r.sharing_rate is null then
    raise exception 'sharing rate missing';
  end if;
  if (select monthly_minutes from f_costing_basis(v_main)) < 0 then
    raise exception 'costing basis negative';
  end if;
  perform * from f_overhead_suggestion(v_main);
end $$;

-- Owner sets the branch assumptions.
do $$
declare v_main uuid;
begin
  select id into v_main from public.branches where code = 'MAIN';
  insert into public.costing_settings (branch_id, monthly_overhead_cents)
  values (v_main, 5000000)
  on conflict (branch_id) do update set monthly_overhead_cents = 5000000;
  if (select monthly_overhead_cents from public.costing_settings
      where branch_id = v_main) <> 5000000 then
    raise exception 'costing settings did not save';
  end if;
end $$;

-- Front desk: recipes are read-only, assumptions are invisible.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
do $$
declare v_svc uuid; v_pads uuid; v_ok boolean := false;
begin
  select id into v_svc from public.services where name = 'Manicure';
  select id into v_pads from public.products where name = 'Cotton pads';
  begin
    insert into public.service_recipes (service_id, product_id, qty)
    values (v_svc, v_pads, 5);
  exception when others then v_ok := true;
  end;
  if not v_ok and (select count(*) from public.service_recipes
                   where service_id = v_svc) <> 2 then
    raise exception 'front desk wrote a recipe';
  end if;
  if (select count(*) from public.costing_settings) <> 0 then
    raise exception 'front desk can read costing settings';
  end if;
end $$;

reset role;

-- Business guard: a SALON service cannot consume a SPA product.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;
do $$
declare v_svc uuid; v_spa_biz uuid; v_spa_prod uuid;
begin
  select id into v_spa_biz from public.businesses where code = 'SPA';
  if v_spa_biz is null then return; end if; -- no second business seeded
  insert into public.products (business_id, name)
  values (v_spa_biz, 'Massage oil') returning id into v_spa_prod;
  select id into v_svc from public.services where name = 'Manicure';
  begin
    insert into public.service_recipes (service_id, product_id, qty)
    values (v_svc, v_spa_prod, 1);
    raise exception 'cross-business recipe accepted';
  exception when check_violation then null;
  end;
end $$;

reset role;
select 'costing suite passed' as result;
